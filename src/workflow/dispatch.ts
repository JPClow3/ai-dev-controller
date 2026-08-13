import type { ControllerConfig } from '../config/load-config.js';
import type { ControllerRepositories } from '../state/repositories.js';
import type { OrcaClient } from '../orca/client.js';
import type { GitHub } from '../github/client.js';
import type { Git } from '../git/repository.js';
import {
  createParentWorktree,
  listWorktrees,
  listRepos,
  findRepoBySlug,
  branchNameFor,
  hasExistingWork,
  type ExistingWorkspace,
  type OrcaWorktree,
} from '../orca/worktrees.js';
import { findPullRequestByBranch } from '../github/pull-requests.js';
import { selectModel } from '../routing/selector.js';
import type { SelectorDeps } from '../routing/selector.js';
import type { WorkItem } from '../scheduler/priority.js';
import { logger } from '../util/log.js';

const log = logger('dispatch');

/** Orca reports branches fully qualified; git commands want the short name. */
export function shortBranch(ref: string | undefined): string {
  return (ref ?? '').replace(/^refs\/heads\//, '');
}

/**
 * Whether an existing worktree is the one this issue asked for.
 *
 * Orca creates `ai/JP-9-work` as `JPClow3/ai/JP-9-work`, so an equality test
 * against the requested name matched nothing — duplicate detection passed
 * every time and a second worktree was created on every restart.
 */
export function matchesRequestedBranch(worktree: OrcaWorktree, requested: string): boolean {
  if (worktree.displayName === requested) return true;
  // Orca replaces `/` with `-` inside the name as well as prepending the
  // owner, so `ai/JP-9-work` comes back as `JPClow3/ai-JP-9-work`. Both
  // transformations have to be undone before comparing.
  const flat = (value: string) => value.replace(/\//g, '-');
  const actual = shortBranch(worktree.branch);
  const tail = actual.slice(actual.indexOf('/') + 1);
  return actual === requested || flat(tail) === flat(requested);
}

export interface DispatchDeps {
  config: ControllerConfig;
  repos: ControllerRepositories;
  orca: OrcaClient;
  github: GitHub;
  git: Git;
  routing: SelectorDeps;
  /** Orca custom agent name for a routing alias, e.g. "Ollama DeepSeek V4". */
  agentNameFor: (alias: string) => string;
}

export interface DispatchResult {
  issueId: string;
  action: 'started' | 'adopted' | 'skipped';
  runId?: string;
  branch?: string;
  worktreeId?: string;
  alias?: string;
  reason: string;
}

/**
 * Everywhere prior work for this issue could already exist.
 *
 * Checked before creating anything. Restarting the controller or Orca must
 * never produce LIN-123, LIN-123-2, LIN-123-copy — and the controller database
 * is only one of the four places the truth can live.
 */
export async function findExistingWorkspace(
  deps: DispatchDeps,
  issueId: string,
  branch: string,
  slug: string,
  repoPath: string,
): Promise<ExistingWorkspace> {
  const run = deps.repos.getActiveRun(issueId);

  // Duplicate detection is a safety gate. An unavailable source is unknown,
  // never evidence that no work exists.
  const worktrees = await listWorktrees(deps.orca);
  const orcaWorktree = worktrees.find((w) => matchesRequestedBranch(w, branch)) ?? null;

  const gitBranchExists = await deps.git.branchExists(repoPath, branch);

  const pr = await findPullRequestByBranch(deps.github, slug, branch);

  return {
    controllerWorktreeId: run?.orcaWorktreeId ?? null,
    orcaWorktree,
    gitBranchExists,
    openPullRequest: pr && pr.state === 'OPEN' ? pr.number : null,
  };
}

/**
 * Starts a new issue: claim, fresh base, worktree, route, launch.
 *
 * Ordered so the cheapest refusals happen first and nothing external is
 * created until the claim is genuinely ours.
 */
export async function dispatchNewIssue(
  deps: DispatchDeps,
  input: { issueId: string; projectId: string; role: string; risk: 'low' | 'medium' | 'high'; slug: string },
): Promise<DispatchResult> {
  const project = deps.config.registry.projects[input.projectId];
  if (!project) {
    return { issueId: input.issueId, action: 'skipped', reason: `unregistered project ${input.projectId}` };
  }

  const repoPath = project.repository.path;
  const baseBranch = project.repository.baseBranch;
  const branch = branchNameFor(deps.config.global.git.branchPrefix, input.issueId);

  // 1. Refuse duplicates before touching anything.
  const existing = await findExistingWorkspace(deps, input.issueId, branch, input.slug, repoPath);
  if (hasExistingWork(existing)) {
    // Adopt, but still claim and record. Returning here without claiming left
    // the issue permanently stuck: prior work existed, no run owned it, and
    // nothing ever picked it up again.
    log.info(`${input.issueId}: existing work found, adopting rather than recreating`);
    const adopted = deps.repos.getActiveRun(input.issueId) ?? deps.repos.claimIssueRun(input.issueId, input.projectId);
    const adoptedBranch = shortBranch(existing.orcaWorktree?.branch) || branch;
    if (adopted) {
      const baseSha = await deps.git.fetchFreshBase(repoPath, baseBranch);
      deps.repos.attachRunWorkspace(adopted.id, {
        branch: adoptedBranch,
        baseSha,
        ...(existing.orcaWorktree ? { orcaWorktreeId: existing.orcaWorktree.id } : {}),
      });
    }
    return {
      issueId: input.issueId,
      action: 'adopted',
      ...(adopted ? { runId: adopted.id } : {}),
      branch: adoptedBranch,
      ...(existing.orcaWorktree ? { worktreeId: existing.orcaWorktree.id } : {}),
      reason: describeExisting(existing),
    };
  }

  // 2. Claim. The unique index decides, not this read.
  const run = deps.repos.claimIssueRun(input.issueId, input.projectId);
  if (!run) {
    return { issueId: input.issueId, action: 'skipped', reason: 'another run already holds this issue' };
  }

  // 3. Fresh base. Every issue branches from the newest base at the moment it
  //    becomes eligible, so wave 2 never builds on yesterday's assumptions.
  const baseSha = await deps.git.fetchFreshBase(repoPath, baseBranch);

  // 4. Route. The controller picks the alias; Orca owns the session.
  const decision = selectModel(
    { projectId: input.projectId, role: input.role, risk: input.risk },
    deps.routing,
  );

  // 5. Create the parent worktree, base branch pinned explicitly.
  const repos = await listRepos(deps.orca);
  const repo = findRepoBySlug(repos, project.repository.github);
  if (!repo) {
    return {
      issueId: input.issueId,
      action: 'skipped',
      reason: `repository ${project.repository.github} is not registered in Orca`,
    };
  }

  // No `--agent`: the parent worktree holds the integrated branch, and its
  // workers run in child worktrees. Requesting an agent here would also
  // require a GUI-registered custom agent, which cannot be created from a
  // script.
  const worktree = await createParentWorktree(deps.orca, {
    repoSelector: `id:${repo.id}`,
    name: branch,
    baseBranch,
    linearIssue: input.issueId,
  });
  await deps.git.fastForwardTo(worktree.path, baseSha);

  // Without this the run row keeps a NULL branch, base sha and worktree id,
  // and the very next step interpolates "id:null" into an Orca selector and
  // diffs against a stale local ref instead of the commit it branched from.
  // The branch is the one Orca created, not the one requested: Orca namespaces
  // it under the GitHub owner, and pushing the requested name pushed a ref
  // that does not exist.
  const created = shortBranch(worktree.branch) || branch;
  deps.repos.attachRunWorkspace(run.id, {
    branch: created,
    baseSha,
    orcaWorktreeId: worktree.id,
  });

  log.info(
    `${input.issueId}: started on ${decision.alias} (${decision.reason}) at ${created} from ${baseSha.slice(0, 8)}`,
  );

  return {
    issueId: input.issueId,
    action: 'started',
    runId: run.id,
    branch: created,
    worktreeId: worktree.id,
    alias: decision.alias,
    reason: `routed to ${decision.alias} (${decision.reason})`,
  };
}

function describeExisting(found: ExistingWorkspace): string {
  const parts: string[] = [];
  if (found.controllerWorktreeId) parts.push('controller has a worktree');
  if (found.orcaWorktree) parts.push(`Orca worktree ${found.orcaWorktree.id}`);
  if (found.gitBranchExists) parts.push('git branch exists');
  if (found.openPullRequest !== null) parts.push(`PR #${found.openPullRequest} open`);
  return parts.join('; ');
}

/**
 * The `dispatch` seam the runner calls.
 *
 * Only new-issue starts are wired to Orca. The other work kinds need the
 * planner, integrator and reviewers, which run inside the issue's own state
 * machine rather than here.
 */
export function createDispatcher(deps: DispatchDeps) {
  return async function dispatch(item: WorkItem): Promise<void> {
    if (item.kind !== 'NEW_READY_ISSUE') {
      log.debug(`${item.issueId}: ${item.kind} is not wired to Orca yet`);
      return;
    }

    // The runner resolved this when it read the issue; a new issue has no run
    // to look it up from.
    const projectId = item.projectId ?? deps.repos.getActiveRun(item.issueId)?.repositoryId;
    if (!projectId) {
      log.warn(`${item.issueId}: no resolved repository on the work item; skipping`);
      return;
    }

    const project = deps.config.registry.projects[projectId];
    if (!project) return;
    const issueRouting = deps.repos.issueRouting(item.issueId);

    await dispatchNewIssue(deps, {
      issueId: item.issueId,
      projectId,
      role: issueRouting.role,
      risk: issueRouting.risk,
      slug: project.repository.github,
    });
  };
}

/**
 * Maps a routing alias to the Orca custom agent that runs it.
 *
 * Both sides ultimately invoke `codex --profile <name>`; this is the naming
 * bridge between the controller's aliases and Orca's agent list.
 */
export function defaultAgentNameFor(config: ControllerConfig): (alias: string) => string {
  const names: Record<string, string> = {
    luna_low: 'GPT Luna Low',
    luna_medium: 'GPT Luna Medium',
    luna_high: 'GPT Luna High',
    luna_xhigh: 'GPT Luna XHigh',
    terra_medium: 'GPT Terra Medium',
    terra_high: 'GPT Terra High',
    terra_xhigh: 'GPT Terra XHigh',
    sol_medium: 'GPT Sol Medium',
    sol_high: 'GPT Sol High',
    sol_xhigh: 'GPT Sol XHigh',
    glm_5_2: 'Ollama GLM 5.2',
    kimi_code: 'Ollama Kimi K2.7',
    deepseek_flash: 'Ollama DeepSeek V4',
  };

  return (alias: string) => {
    const name = names[alias];
    if (name) return name;
    const profile = config.routing.aliases[alias]?.profile;
    if (!profile) throw new Error(`No Orca agent mapping for alias "${alias}"`);
    return profile;
  };
}
