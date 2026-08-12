import {
  copyFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  readlinkSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ControllerConfig } from '../config/load-config.js';
import type { ControllerRepositories } from '../state/repositories.js';
import type { Risk } from '../state/types.js';
import type { Agents } from '../agents/roles.js';
import { reviewerCandidates } from '../agents/roles.js';
import type { OrcaClient } from '../orca/client.js';
import type { GitHub } from '../github/client.js';
import type { Git } from '../git/repository.js';
import { createIntegrator } from '../git/integration.js';
import type { GitRunner } from '../git/repository.js';
import {
  launchWorker,
  listTerminals,
  classifyWorkerLiveness,
  workerScript,
  WORKER_PROMPT_FILE,
  WORKER_SCRIPT_FILE,
  WORKER_EXIT_FILE,
  WORKER_RESULT_FILE,
  WORKER_HEARTBEAT_FILE,
} from '../orca/terminals.js';
import {
  createWorkerWorktree,
  findWorkerWorktree,
  listWorktrees,
  worktreePathFromId,
} from '../orca/worktrees.js';
import { ensureDraftPullRequest, updatePullRequestBody, findPullRequestByBranch } from '../github/pull-requests.js';
import { readChecks } from '../github/checks.js';
import { renderPrBody, renderStubPrBody } from '../github/pr-body.js';
import { readEffectiveSetupCommand, readValidationCommands, runRequiredValidation } from '../validation/local.js';
import { buildFinalReviewPacket, renderPacket } from '../reviews/packet.js';
import { toPrComments, type ReviewResult } from '../reviews/review.js';
import type { RemediationTask } from '../reviews/remediation.js';
import { authorshipByFamily } from '../routing/selector.js';
import { isUsable } from '../routing/pressure.js';
import { selectModel, type SelectorDeps } from '../routing/selector.js';
import { postBlockerQuestion } from '../linear/dependencies.js';
import { setAiLifecycleLabel } from '../linear/labels.js';
import type { OrchestratorDeps, PlanTask, StepContext } from './orchestrator.js';
import { logger } from '../util/log.js';
import { finalizeRunScores } from '../scoring/runtime.js';

const log = logger('steps');

export interface StepsWiring {
  config: ControllerConfig;
  repos: ControllerRepositories;
  agents: Agents;
  orca: OrcaClient;
  github: GitHub;
  git: Git;
  gitRunner: GitRunner;
  routing: SelectorDeps;
  agentNameFor: (alias: string) => string;
  /** Set false in tests and dry runs so Linear is never written to. */
  writeToLinear?: boolean;
}

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export interface WorkerCommitMessageInput {
  issueId: string;
  projectId: string;
  taskId: string;
  taskCategory?: string | undefined;
  taskSummary: string;
  ownedPaths: string[];
  workerSummary: string;
}

function commitKind(taskCategory?: string): 'feat' | 'fix' | 'test' | 'docs' | 'chore' {
  const category = taskCategory?.toLowerCase() ?? '';
  if (category.includes('test')) return 'test';
  if (category.includes('fix') || category.includes('bug')) return 'fix';
  if (category.includes('doc')) return 'docs';
  if (category.includes('feature') || category.includes('implementation')) return 'feat';
  return 'chore';
}

function conciseSummary(summary: string, maxLength: number): string {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  const lowercased = normalized ? `${normalized[0]!.toLowerCase()}${normalized.slice(1)}` : 'update task';
  if (lowercased.length <= maxLength) return lowercased;
  const clipped = lowercased.slice(0, Math.max(1, maxLength - 1));
  return `${clipped.replace(/\s+\S*$/, '').trim()}…`;
}

/** Formats a concise subject and retains unverified worker evidence in the body. */
export function formatWorkerCommitMessage(input: WorkerCommitMessageInput): string {
  const prefix = `${commitKind(input.taskCategory)}(${input.projectId}): `;
  const suffix = ` (${input.issueId})`;
  const subject = `${prefix}${conciseSummary(input.taskSummary, 72 - prefix.length - suffix.length)}${suffix}`;
  return [
    subject,
    '',
    `Task: ${input.taskId}`,
    `Owned paths: ${input.ownedPaths.join(', ')}`,
    '',
    `Verification: ${input.workerSummary || 'No worker verification summary recorded.'}`,
  ].join('\n');
}

/** A task may raise an issue's risk, never lower it. */
export function effectiveTaskRisk(issueRisk: Risk, taskRisk?: Risk): Risk {
  if (!taskRisk) return issueRisk;
  return RISK_RANK[taskRisk] > RISK_RANK[issueRisk] ? taskRisk : issueRisk;
}

/** One task owns one durable child worktree across all bounded attempts. */
export function workerWorktreeName(branch: string, taskId: string): string {
  return `${branch.replace(/\//g, '-')}-${taskId}`;
}

/** Terminals are attempt-scoped so a stale shell cannot confirm a new launch. */
export function workerTerminalTitle(taskId: string, attemptNo: number): string {
  return `worker:${taskId}:attempt:${attemptNo}`;
}

export function shouldWaitForExistingWorkerLaunch(input: {
  resumingDispatch: boolean;
  recentHeartbeat: boolean;
  terminalExists: boolean;
}): boolean {
  return input.resumingDispatch && (input.recentHeartbeat || input.terminalExists);
}

/** Builds one disjoint worker task per affected file for a remediation wave. */
export function remediationPlanTasks(tasks: RemediationTask[], cycle: number): PlanTask[] {
  const byFile = new Map<string, RemediationTask[]>();
  for (const task of tasks) {
    const grouped = byFile.get(task.file) ?? [];
    grouped.push(task);
    byFile.set(task.file, grouped);
  }

  return [...byFile.entries()].map(([file, findings], index) => ({
    id: `remediation-${cycle}-${index}`,
    summary: [
      'Fix only the independently reviewed findings below; do not re-implement the original task.',
      ...findings.flatMap((finding) => [
        '',
        finding.instruction,
        `Verify with: ${finding.suggestedValidation}`,
      ]),
    ].join('\n'),
    // The orchestrator route gives a review repair a different Codex alias
    // from the routine worker in the Codex-only pilot.
    task_category: 'orchestrator',
    owns: [file],
    blocked_by: [],
    acceptance_criteria: [...new Set(
      findings
        .map((finding) => finding.acceptanceCriterion)
        .filter((criterion): criterion is string => criterion !== null),
    )],
    exclude_aliases: [...new Set(findings.flatMap((finding) => finding.excludeAliases))],
  }));
}

function isRemediationTask(value: unknown): value is RemediationTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<RemediationTask>;
  return typeof task.findingIndex === 'number'
    && typeof task.file === 'string'
    && (typeof task.acceptanceCriterion === 'string' || task.acceptanceCriterion === null)
    && typeof task.instruction === 'string'
    && typeof task.suggestedValidation === 'string'
    && Array.isArray(task.excludeAliases)
    && task.excludeAliases.every((alias) => typeof alias === 'string');
}

/** Remediation edits the integrated result, not the issue's original base. */
export async function alignRemediationWorktree(
  git: Pick<Git, 'headSha' | 'fastForwardTo'>,
  workerPath: string,
  parentPath: string,
): Promise<void> {
  const parentHead = await git.headSha(parentPath);
  await git.fastForwardTo(workerPath, parentHead);
}

/**
 * Preserves a failed attempt's owned diff outside the worktree, then restores
 * exactly the tracked/untracked files it owned. A retry never inherits dirty
 * code from the alias it replaces; any out-of-scope dirt blocks the retry.
 */
export async function cleanFailedAttempt(
  gitRunner: GitRunner,
  workerPath: string,
  owned: string[],
  evidencePath: string,
): Promise<boolean> {
  if (owned.length === 0) return false;
  const run = (args: string[]) => gitRunner(workerPath, args);
  const nulList = (value: string) => value.split('\0').filter(Boolean);
  const tracked = nulList(await run(['diff', '--name-only', '-z', 'HEAD', '--', ...owned]).catch(() => ''));
  const untracked = nulList(await run(['ls-files', '--others', '--exclude-standard', '-z', '--', ...owned]).catch(() => ''));
  const patch = await run(['diff', '--binary', 'HEAD', '--', ...owned]).catch(() => '');
  writeFileSync(evidencePath, [patch, '', '# Untracked files', ...untracked].join('\n'), 'utf8');

  if (tracked.length > 0) {
    await run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]);
  }
  const root = resolve(workerPath);
  const archiveRoot = `${evidencePath}.files`;
  for (const file of untracked) {
    const target = resolve(root, file);
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Refused to clean untracked path outside worker worktree: ${file}`);
    }
    const archived = resolve(archiveRoot, rel);
    const archivedRel = relative(resolve(archiveRoot), archived);
    if (!archivedRel || archivedRel.startsWith('..') || isAbsolute(archivedRel)) {
      throw new Error(`Refused to archive untracked path outside evidence directory: ${file}`);
    }
    mkdirSync(resolve(archived, '..'), { recursive: true });
    if (lstatSync(target).isSymbolicLink()) {
      writeFileSync(`${archived}.symlink.txt`, readlinkSync(target), 'utf8');
    } else {
      copyFileSync(target, archived);
    }
    rmSync(target, { force: true });
  }
  const remaining = await run(['status', '--porcelain', '--untracked-files=all']);
  return remaining.trim().length === 0;
}

interface PlanResponse {
  verdict: 'planned' | 'blocked';
  blocked?: { reason: string; question: string };
  tasks?: PlanTask[];
}

/**
 * Concrete implementations of every orchestrator seam.
 *
 * The orchestrator was written against injected dependencies so it could be
 * tested without Orca, GitHub or a model. This is the other half: the real
 * bindings, assembled in one place so the composition is visible rather than
 * scattered through the state machine.
 */
export function createSteps(wiring: StepsWiring): OrchestratorDeps {
  const { config, repos, agents, orca, github, git } = wiring;
  const integrator = createIntegrator(wiring.gitRunner);
  const writeToLinear = wiring.writeToLinear !== false;

  function project(ctx: StepContext) {
    const entry = config.registry.projects[ctx.projectId];
    if (!entry) throw new Error(`Unregistered project "${ctx.projectId}"`);
    return entry;
  }

  /** The registry clone. Only correct before the worktree exists. */
  function repoPath(ctx: StepContext): string {
    return project(ctx).repository.path;
  }

  /**
   * Where this run's code actually lives.
   *
   * Everything after PLANNING — integration, validation, the review diff, the
   * push — must run here. `repoPath` has the base branch checked out.
   */
  function treePath(ctx: StepContext): string {
    if (!ctx.worktreePath) {
      throw new Error(`Run ${ctx.run.id} has no parent worktree path; cannot operate on the base clone`);
    }
    return ctx.worktreePath;
  }

  function slug(ctx: StepContext): string {
    return project(ctx).repository.github;
  }

  /**
   * Where this run's validation contract actually is.
   *
   * `.ai-workflow/project.yaml` is meant to be committed, by the bootstrap PR,
   * so it travels with the branch and a run on an old base is validated by the
   * rules of that base. Until that PR merges the file exists only in the
   * registry clone's working tree, and a fresh worktree checkout has none —
   * which silently produced a run with no setup command and no validation
   * commands at all, and a pull request whose body honestly reported that the
   * repository declared none.
   *
   * Falling back to the clone keeps the soft knowledge gate usable. Saying so
   * out loud every time keeps it from becoming the permanent arrangement.
   */
  function contractPath(ctx: StepContext): string {
    const tree = treePath(ctx);
    if (existsSync(join(tree, '.ai-workflow/project.yaml'))) return tree;

    const clone = repoPath(ctx);
    if (existsSync(join(clone, '.ai-workflow/project.yaml'))) {
      log.warn(
        `${ctx.run.issueId}: .ai-workflow/project.yaml is not committed; ` +
          `reading the validation contract from ${clone}. Merge the bootstrap PR so it travels with the branch.`,
      );
      return clone;
    }
    return tree;
  }

  /** Controller-owned scratch for one worker, deliberately not in the repo. */
  function workerControlDir(ctx: StepContext, taskKey: string): string {
    return resolve(config.rootDir, 'data', 'workers', ctx.run.id, taskKey);
  }

  function readIfPresent(base: string, relative: string): string {
    const path = join(base, relative);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  /** Bounded full-file context so review can see relevant unchanged tests. */
  function changedFileContext(base: string, paths: string[]): Record<string, string> {
    const files: Record<string, string> = {};
    let remaining = 96_000;
    for (const relative of paths) {
      if (remaining <= 0) break;
      const path = join(base, relative);
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, 'utf8');
        if (content.includes('\0')) continue;
        const excerpt = content.slice(0, Math.min(24_000, remaining));
        files[relative] = excerpt;
        remaining -= excerpt.length;
      } catch {
        // Deleted, binary or unreadable files remain represented by the diff.
      }
    }
    return files;
  }

  function issueContract(ctx: StepContext): string {
    const row = repos.getIssueContract(ctx.run.issueId);
    return row ?? `Issue ${ctx.run.issueId} (no curated body recorded)`;
  }

  /**
   * Creates a worker's worktree, writes its prompt and launcher, and starts it.
   *
   * Shared by the first wave and every later one so a task dispatched second
   * is dispatched identically to a task dispatched first.
   */
  async function dispatchTask(ctx: StepContext, task: PlanTask): Promise<boolean> {
    const parent = ctx.run.orcaWorktreeId;
    if (!parent) throw new Error(`Run ${ctx.run.id} has no parent worktree`);

    // A planner may return a task_category that is not a declared routing
    // role. Falling back is right; throwing here would escape advanceRun.
    const role = wiring.routing.routing.roles[task.task_category] ? task.task_category : 'routine_behavior';
    if (role !== task.task_category) {
      log.warn(`${ctx.run.issueId}/${task.id}: unknown task_category "${task.task_category}", routing as ${role}`);
    }

    // No `--agent`: custom agents can only be registered through the Orca
    // GUI, which would make this un-runnable from a script. The worker is
    // launched as a plain command instead.
    // Flat name: Orca rejects a worktree name carrying the parent's path
    // separators, and the parent link already expresses the relationship.
    const risk = effectiveTaskRisk(ctx.risk, task.risk);
    const effectiveTask = { ...task, risk };
    const persisted = repos.runTasks(ctx.run.id).find((candidate) => candidate.id === task.id);
    const attemptsBefore = repos.workerAttemptCount(ctx.run.id, task.id);
    const resumingDispatch = persisted?.state === 'DISPATCHING' && attemptsBefore > 0;
    const repositoryCap =
      config.registry.projects[ctx.projectId]?.maxAgents ?? config.global.concurrency.agentsPerRepository;
    if (
      !resumingDispatch &&
      (repos.activeWorkerCount() >= config.global.concurrency.globalAgents ||
        repos.activeWorkerCount(ctx.run.id) >= config.global.concurrency.workersPerIssue ||
        repos.activeWorkerCountForRepository(ctx.projectId) >= repositoryCap)
    ) {
      return false;
    }
    const prior = resumingDispatch ? repos.latestWorkerAttempt(ctx.run.id, task.id) : null;
    const selected = prior ? null : selectModel(
      {
        projectId: ctx.projectId,
        role,
        risk,
        ...(task.exclude_aliases?.length ? { excludeAliases: task.exclude_aliases } : {}),
      },
      wiring.routing,
    );
    const alias = prior?.aliasId ?? selected!.alias;
    const isChallenger = prior?.isChallenger ?? selected!.isChallenger;
    const profile = config.routing.aliases[alias]?.profile;
    if (!profile) throw new Error(`Alias ${alias} declares no Codex profile`);
    const attemptNo = resumingDispatch ? attemptsBefore : attemptsBefore + 1;
    if (!resumingDispatch) {
      // Intent precedes every external side effect. After a crash the same
      // attempt and deterministic name are resumed rather than incremented.
      repos.setTaskState(ctx.run.id, task.id, 'DISPATCHING');
      repos.recordAttempt(ctx.run.id, task.id, {
        aliasId: alias,
        role: 'worker',
        isChallenger,
      });
    }
    const name = workerWorktreeName(ctx.branch, task.id);
    const repoSelector = `id:${parent.split('::')[0]}`;
    const existing = findWorkerWorktree(await listWorktrees(orca, repoSelector), parent, name);
    const worktree = existing ?? await createWorkerWorktree(orca, {
      parentSelector: `id:${parent}`,
      repoSelector,
      name,
    });

    // Orca associates the child with its parent but creates the git branch
    // from the repository base. A remediation worker must see the already
    // integrated diff it is repairing, so align it before attaching the
    // external worktree id. A crash before this point simply retries the same
    // deterministic clean worktree.
    if (task.id.startsWith('remediation-') && !persisted?.orcaWorktreeId) {
      await alignRemediationWorktree(git, worktree.path, treePath(ctx));
    }

    // Attach immediately after create/adopt. A later crash can now locate the
    // exact worktree without scanning, while a crash before this write is
    // recovered by the deterministic scan above.
    repos.recordTasks(ctx.run.id, [
      { ...effectiveTask, branch: worktree.branch ?? `${ctx.branch}/${task.id}`, orcaWorktreeId: worktree.id },
    ]);
    const attemptBaseSha = await git.headSha(worktree.path);
    repos.setWorkerAttemptBaseSha(ctx.run.id, task.id, attemptBaseSha);

    // Both go to files: the prompt exceeds the Windows argv limit, and the
    // files survive for inspection after the run. They go OUTSIDE the
    // worktree so they cannot end up in the worker's commit.
    const controlDir = workerControlDir(ctx, task.id);
    mkdirSync(controlDir, { recursive: true });
    const heartbeatPath = join(controlDir, WORKER_HEARTBEAT_FILE);
    const recentHeartbeat = existsSync(heartbeatPath)
      && classifyWorkerLiveness(null, statSync(heartbeatPath).mtimeMs).state === 'running';
    const terminalTitle = workerTerminalTitle(task.id, attemptNo);
    const terminalExists = resumingDispatch
      && (await listTerminals(orca, `id:${worktree.id}`)).some((terminal) => terminal.title === terminalTitle);
    if (shouldWaitForExistingWorkerLaunch({ resumingDispatch, recentHeartbeat, terminalExists })) {
      // Either the worker process wrote its heartbeat or Orca confirms that
      // the deterministic terminal was created before the controller crashed.
      repos.markWorkerLaunched(ctx.run.id, task.id);
      return true;
    }
    // A retried task reuses its controller-owned control directory. Old
    // sentinels would otherwise make the replacement look finished before it
    // starts.
    for (const stale of [WORKER_EXIT_FILE, WORKER_RESULT_FILE, WORKER_HEARTBEAT_FILE]) {
      rmSync(join(controlDir, stale), { force: true });
    }
    writeFileSync(join(controlDir, WORKER_PROMPT_FILE), workerPrompt(ctx, task), 'utf8');
    const setup = readEffectiveSetupCommand(contractPath(ctx));
    writeFileSync(
      join(controlDir, WORKER_SCRIPT_FILE),
      workerScript(profile, controlDir, {
        ...(setup?.command ? { setupCommand: setup.command } : {}),
      }),
      'utf8',
    );
    await launchWorker(orca, {
      worktreeSelector: `id:${worktree.id}`,
      title: terminalTitle,
      controlDir,
    });

    repos.markWorkerLaunched(ctx.run.id, task.id);
    log.info(`${ctx.run.issueId}/${task.id}: dispatched to ${alias} (${profile})`);
    return true;
  }

  /**
   * The worktree's tracked files, capped.
   *
   * Capped rather than truncated silently: a planner that is told it has the
   * whole tree, and is handed a third of it, will confidently declare
   * ownership of paths it never saw. The cap says so out loud.
   */
  async function trackedFiles(ctx: StepContext, limit = 600): Promise<string> {
    try {
      const out = await wiring.gitRunner(treePath(ctx), ['ls-files']);
      const files = out.split('\n').filter(Boolean);
      if (files.length <= limit) return files.join('\n');
      return [
        ...files.slice(0, limit),
        `... ${files.length - limit} more tracked file(s) not shown; ask for a subtree if you need them.`,
      ].join('\n');
    } catch {
      return '(file tree unavailable)';
    }
  }

  /**
   * Commits whatever a finished worker left uncommitted, within its own paths.
   *
   * Workers cannot commit for themselves: a linked worktree's git directory is
   * outside the sandbox's writable root, and granting it pushes codex onto a
   * Windows elevation helper that cannot run unattended. So the controller
   * does it — which turns out to be the better arrangement anyway. Staging by
   * pathspec makes the ownership rule mechanical: a change outside the
   * declared set cannot be committed, however convinced the model is that it
   * belonged. Files left dirty afterwards are reported as the scope violation
   * they are, rather than silently swept into the pull request.
   */
  async function commitWorkerChanges(
    ctx: StepContext,
    task: { id: string; summary: string; owns: string[]; task_category?: string },
    workerPath: string,
    controlDir: string,
  ): Promise<void> {
    const run = (args: string[]) => wiring.gitRunner(workerPath, args);

    const dirty = await run(['status', '--porcelain']).catch(() => '');
    if (!dirty.trim()) return;

    // Pathspecs, not a hand-rolled glob matcher: git already knows how to
    // match `packages/shared/**` against a path, and getting that subtly
    // wrong would either drop the work or widen the scope.
    if (task.owns.length === 0) {
      log.warn(`${ctx.run.issueId}/${task.id}: uncommitted changes but no declared ownership; leaving them`);
      return;
    }
    await run(['add', '--', ...task.owns]).catch((err: unknown) => {
      log.warn(`${ctx.run.issueId}/${task.id}: could not stage owned paths`, (err as Error).message);
    });

    const staged = await run(['diff', '--cached', '--name-only']).catch(() => '');
    if (!staged.trim()) {
      log.warn(`${ctx.run.issueId}/${task.id}: changes exist but none inside ${task.owns.join(', ')}`);
      return;
    }

    const message = formatWorkerCommitMessage({
      issueId: ctx.run.issueId,
      projectId: ctx.projectId,
      taskId: task.id,
      taskCategory: task.task_category,
      taskSummary: task.summary,
      ownedPaths: task.owns,
      workerSummary: readIfPresent(controlDir, WORKER_RESULT_FILE).trim(),
    });

    await run(['commit', '-m', message]);
    log.info(`${ctx.run.issueId}/${task.id}: committed ${staged.split('\n').filter(Boolean).length} owned file(s)`);

    const leftover = await run(['status', '--porcelain']).catch(() => '');
    const outside = leftover
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    if (outside.length > 0) {
      log.warn(
        `${ctx.run.issueId}/${task.id}: left ${outside.length} change(s) outside its ownership, not committed: ${outside
          .slice(0, 5)
          .join(', ')}`,
      );
    }
  }

  /** Records what a finished worker actually committed on its own branch. */
  async function harvestCommits(
    ctx: StepContext,
    taskKey: string,
    workerPath: string,
    controlDir: string,
  ): Promise<Array<{ sha: string; message: string }>> {
    const baseSha = repos.latestWorkerAttempt(ctx.run.id, taskKey)?.baseSha ?? ctx.run.baseSha;
    if (!baseSha) return [];

    const commits = await git.commitsSince(workerPath, baseSha).catch((err: unknown) => {
      log.warn(`${ctx.run.issueId}/${taskKey}: could not read commits`, (err as Error).message);
      return [] as Array<{ sha: string; message: string }>;
    });

    // Oldest first, so cherry-picking replays the worker's own order.
    const ordered = [...commits].reverse();
    repos.recordAttemptResult(ctx.run.id, taskKey, {
      commits: ordered,
      finalMessage: readIfPresent(controlDir, WORKER_RESULT_FILE).slice(0, 4000),
    });
    return ordered;
  }

  return {
    config,
    repos,

    dependenciesMerged(issueId) {
      // Merged, and only merged. Every other signal is explicitly untrusted.
      return repos.getDependencies(issueId).every((d) => d.satisfiedAt !== null);
    },

    async fetchFreshBase(ctx) {
      return git.fetchFreshBase(repoPath(ctx), ctx.baseBranch);
    },

    async plan(ctx) {
      const decision = selectModel(
        { projectId: ctx.projectId, role: 'orchestrator', risk: ctx.risk },
        wiring.routing,
      );

      const response = await agents.plan<PlanResponse>(
        decision.alias,
        [
          issueContract(ctx),
          '',
          '## Repository instructions',
          readIfPresent(treePath(ctx), 'AGENTS.md'),
          '',
          '## Validation commands available',
          readValidationCommands(contractPath(ctx))
            .map((c) => `- ${c.name}: ${c.command}${c.required ? ' (required)' : ''}`)
            .join('\n') || '- none declared',
          '',
          // The prompt tells the planner it receives the worktree's file tree.
          // It did not, so every `owns` glob was guessed from the issue text
          // alone — and a glob that matches nothing produces a worker with no
          // files it is allowed to touch.
          '## Repository tree (tracked files)',
          await trackedFiles(ctx),
          '',
          `Base branch: ${ctx.baseBranch}`,
        ].join('\n'),
      );

      if (response.verdict === 'blocked') {
        return { tasks: [], blocked: response.blocked?.question ?? 'planner reported a blocker' };
      }
      return { tasks: response.tasks ?? [] };
    },

    async createWorktrees(ctx, tasks) {
      // Persist the decomposition first: integration, reviewer selection and
      // the provenance body all read these rows, and a crash between creating
      // a worktree and recording it would orphan the work.
      repos.recordTasks(ctx.run.id, tasks);

      // Dispatch only the tasks with no unsatisfied blockers.
      //
      // The ownership check deliberately PERMITS overlapping paths between
      // sequential tasks — serialising is how the design resolves a clash.
      // Launching every task regardless of `blocked_by` threw that guarantee
      // away: two workers were observed editing the same file concurrently,
      // which is precisely the corruption the rule exists to prevent.
      const runnable = tasks.filter((t) => (t.blocked_by ?? []).length === 0);

      if (runnable.length === 0 && tasks.length > 0) {
        throw new Error(
          `Every task in the plan declares a blocker; the dependency graph has no starting point.`,
        );
      }
      for (const task of tasks.filter((t) => (t.blocked_by ?? []).length > 0)) {
        log.info(`${ctx.run.issueId}/${task.id}: deferred behind ${(task.blocked_by ?? []).join(', ')}`);
      }
      for (const task of runnable) {
        if (!(await dispatchTask(ctx, task))) {
          log.info(`${ctx.run.issueId}/${task.id}: waiting for worker capacity`);
          break;
        }
      }
    },

    /**
     * Launches the tasks whose blockers have all finished.
     *
     * Without this a plan containing any sequential step lost its dependent
     * half outright: the tasks were recorded, never launched, and the run
     * integrated only the first wave while reporting success.
     */
    async dispatchNextWave(ctx) {
      const tasks = repos.runTasks(ctx.run.id);
      const done = new Set(tasks.filter((t) => t.state === 'DONE').map((t) => t.id));

      const ready = tasks.filter(
        (t) => t.state === 'PENDING' && t.blocked_by.every((b) => done.has(b)),
      );
      let started = 0;
      for (const task of ready) {
        const dispatched = await dispatchTask(ctx, {
          id: task.id,
          summary: task.summary,
          task_category: task.task_category,
          owns: task.owns,
          blocked_by: task.blocked_by,
          acceptance_criteria: task.acceptance_criteria,
          ...(task.risk ? { risk: task.risk as NonNullable<PlanTask['risk']> } : {}),
        });
        if (!dispatched) return { started, capacityBlocked: true };
        started += 1;
      }
      return { started, capacityBlocked: false };
    },

    /**
     * Whether every dispatched worker has finished.
     *
     * Read from each worker's own worktree, not from Orca. Orca terminals are
     * long-lived shells: `terminal list` reports neither a status nor an exit
     * code, so the previous check ("no terminal has status running") was
     * vacuously true on the first tick and every worker was declared settled
     * the instant it was launched. It also scoped the query to the PARENT
     * worktree, which never contains worker terminals at all.
    */
    async workersSettled(ctx) {
      let pending = 0;
      const dispatching = repos.runTasks(ctx.run.id).filter((task) => task.state === 'DISPATCHING');
      for (const task of dispatching) {
        const risk: Risk = task.risk === 'medium' || task.risk === 'high' ? task.risk : 'low';
        if (!(await dispatchTask(ctx, {
          id: task.id,
          summary: task.summary,
          task_category: task.task_category,
          owns: task.owns,
          blocked_by: task.blocked_by,
          acceptance_criteria: task.acceptance_criteria,
          risk,
        }))) pending += 1;
      }
      const tasks = repos.runTasks(ctx.run.id).filter((t) => t.state === 'DISPATCHED');
      const interrupted: string[] = [];

      for (const task of tasks) {
        if (!task.orcaWorktreeId) continue;
        const path = worktreePathFromId(task.orcaWorktreeId);
        const control = workerControlDir(ctx, task.id);
        const exitContents = readIfPresent(control, WORKER_EXIT_FILE) || null;
        const heartbeatPath = join(control, WORKER_HEARTBEAT_FILE);
        const attempt = repos.latestWorkerAttempt(ctx.run.id, task.id);
        const launchConfirmedMs = attempt?.startedAt ? Date.parse(attempt.startedAt) : null;
        const heartbeatModifiedMs = existsSync(heartbeatPath)
          ? statSync(heartbeatPath).mtimeMs
          : launchConfirmedMs;
        const liveness = classifyWorkerLiveness(exitContents, heartbeatModifiedMs);

        if (liveness.state === 'running') {
          pending += 1;
          continue;
        }
        if (liveness.state === 'interrupted') {
          repos.setTaskState(ctx.run.id, task.id, 'FAILED');
          repos.recordAttemptResult(ctx.run.id, task.id, { failureClass: 'interrupted', commits: [] });
          interrupted.push(task.id);
          continue;
        }
        const exit = liveness.exitCode ?? 1;
        if (exit !== 0) {
          repos.setTaskState(ctx.run.id, task.id, 'FAILED');
          repos.recordAttemptResult(ctx.run.id, task.id, { exitCode: exit, commits: [] });
          interrupted.push(task.id);
          continue;
        }

        // Commit, then harvest. The commits recorded here are the only thing
        // integration has to work with, and nothing was writing them, so every
        // run reached INTEGRATING and reported "no worker produced any
        // commit".
        await commitWorkerChanges(ctx, task, path, control).catch((err: unknown) => {
          log.error(`${ctx.run.issueId}/${task.id}: could not commit`, (err as Error).message);
        });
        const commits = await harvestCommits(ctx, task.id, path, control);
        repos.setTaskState(ctx.run.id, task.id, 'DONE');
        log.info(`${ctx.run.issueId}/${task.id}: finished with ${commits.length} commit(s)`);
      }

      return { allSettled: pending === 0, interrupted };
    },

    async retryInterruptedWorkers(ctx, taskIds) {
      const tasks = repos.runTasks(ctx.run.id).filter((task) => taskIds.includes(task.id));
      if (tasks.length !== taskIds.length) return false;

      const maxAttempts = 1 + config.escalation.limits.workerEscalations;
      if (tasks.some((task) => repos.workerAttemptCount(ctx.run.id, task.id) >= maxAttempts)) return false;

      // Clean every failed worktree before launching any replacement. A
      // preflight refusal can therefore never leave a partial retry wave
      // running while the run is moved to BLOCKED_HUMAN.
      for (const task of tasks) {
        if (!task.orcaWorktreeId) return false;
        const attemptNo = repos.workerAttemptCount(ctx.run.id, task.id);
        const clean = await cleanFailedAttempt(
          wiring.gitRunner,
          worktreePathFromId(task.orcaWorktreeId),
          task.owns,
          join(workerControlDir(ctx, task.id), `attempt-${attemptNo}.failed.patch`),
        ).catch((error: unknown) => {
          log.warn(`${ctx.run.issueId}/${task.id}: failed-attempt cleanup refused`, (error as Error).message);
          return false;
        });
        if (!clean) return false;
      }
      for (const task of tasks) {
        repos.setTaskState(ctx.run.id, task.id, 'PENDING');
        const risk: Risk = task.risk === 'medium' || task.risk === 'high' ? task.risk : 'low';
        await dispatchTask(ctx, {
          id: task.id,
          summary: task.summary,
          task_category: task.task_category,
          owns: task.owns,
          blocked_by: task.blocked_by,
          acceptance_criteria: task.acceptance_criteria,
          risk,
        });
      }
      return true;
    },

    async integrate(ctx) {
      const workers = repos.workerCommits(ctx.run.id);
      const result = await integrator.integrate(treePath(ctx), workers);
      return {
        conflicts: result.conflicts.flatMap((c) => c.files),
        headSha: result.headSha,
      };
    },

    async runValidation(ctx) {
      // Setup first, and inside the same summary: a fresh worktree has no
      // installed dependencies, so without it every command fails for a
      // reason unrelated to the change. Recording it as a result rather than
      // hiding it means a failed install reads as a failed install.
      const setup = readEffectiveSetupCommand(contractPath(ctx));
      const commands = [...(setup ? [setup] : []), ...readValidationCommands(contractPath(ctx))];
      const summary = await runRequiredValidation(treePath(ctx), commands);
      // Stored so the PR body reports the run that actually gated the
      // transition, rather than a second execution whose results may differ.
      repos.recordValidation(ctx.run.id, summary);
      return summary;
    },

    async pushBranch(ctx) {
      await git.pushBranch(treePath(ctx), ctx.branch, ctx.baseBranch, config.global.git.branchPrefix);
    },

    async ensureDraftPr(ctx) {
      // Stub body on purpose: this PR exists to trigger CI, and must not read
      // as reviewable work.
      const pr = await ensureDraftPullRequest(github, {
        slug: slug(ctx),
        head: ctx.branch,
        base: ctx.baseBranch,
        title: `${ctx.run.issueId}: in progress`,
        body: renderStubPrBody(ctx.run.issueId),
      });
      repos.recordPullRequest(ctx.run.id, {
        number: pr.number,
        url: pr.url,
        draft: pr.isDraft,
        headBranch: pr.headRefName,
        baseBranch: pr.baseRefName,
      });
      return pr;
    },

    async readChecks(ctx) {
      const pr = await findPullRequestByBranch(github, slug(ctx), ctx.branch);
      if (!pr) throw new Error(`No pull request for ${ctx.branch}`);
      const checks = await readChecks(github, slug(ctx), pr.number, project(ctx).ci.requiredChecks);
      repos.recordCiObservation(ctx.run.id, checks);
      return checks;
    },

    async retryEnvironmentalCi(ctx, checks) {
      const failedRuns = [...new Set(
        checks.checks
          .filter((check) => check.required && checks.failed.includes(check.name))
          .map((check) => check.githubRunId)
          .filter((id): id is number => id !== undefined),
      )];
      if (failedRuns.length === 0) return false;

      // Retry only failures whose raw evidence is unmistakably external. A
      // product/test failure must proceed to ordinary remediation instead of
      // being relabelled flaky because rerunning is cheaper.
      const environmental = /(?:\b(?:403|429|5\d\d)\b.*(?:Forbidden|rate limit|Service Unavailable)|runner (?:was|has been) lost|timed? out|network (?:error|failure)|ECONNRESET|ETIMEDOUT)/i;
      for (const runId of failedRuns) {
        if (repos.ciRetryRequested(ctx.run.id, runId)) return false;
        const failureLog = await github.text(['run', 'view', String(runId), '--repo', slug(ctx), '--log-failed']);
        if (!environmental.test(failureLog)) return false;
      }

      for (const runId of failedRuns) {
        await github.text(['run', 'rerun', String(runId), '--repo', slug(ctx), '--failed']);
        repos.recordCiRetry(ctx.run.id, checks.headSha, runId, checks.checks);
      }
      return true;
    },

    async review(ctx) {
      const baseSha = ctx.run.baseSha ?? ctx.baseBranch;
      const diff = await git.diffAgainst(treePath(ctx), baseSha);
      const changed = await git.changedFiles(treePath(ctx), baseSha);
      const pr = await findPullRequestByBranch(github, slug(ctx), ctx.branch);
      const checks = pr
        ? await readChecks(github, slug(ctx), pr.number, project(ctx).ci.requiredChecks)
        : undefined;
      const localValidation = checks ? null : repos.lastValidation(ctx.run.id);

      const packet = buildFinalReviewPacket({
        issueId: ctx.run.issueId,
        originalIssue: issueContract(ctx),
        curatedIssue: issueContract(ctx),
        acceptanceCriteria: repos.acceptanceCriteria(ctx.run.issueId),
        agentsMd: readIfPresent(treePath(ctx), 'AGENTS.md'),
        architectureSummary: readIfPresent(treePath(ctx), '.ai-workflow/generated/architecture-summary.md'),
        diff,
        changedFiles: changed.map((c) => c.path),
        currentFiles: changedFileContext(treePath(ctx), changed.map((c) => c.path)),
        ...(checks ? { checks } : {}),
        ...(localValidation ? { localValidation } : {}),
      });

      // The reviewer is chosen from the family least involved in authoring, so
      // no family grades its own homework.
      const authorship = authorshipByFamily(
        repos.attemptAuthorship(ctx.run.id),
        config.routing,
      );
      // Pressure applies to reviewers too. Selecting purely on family picked
      // the *least involved* one, which is exactly the family most likely to
      // be the one that is disabled or out of quota — the review then failed
      // instead of falling back to a reachable reviewer.
      const candidates = reviewerCandidates(config.routing).filter((id) => {
        const spec = config.routing.aliases[id];
        return spec ? isUsable(wiring.routing.pressure, spec.provider) : false;
      });
      if (candidates.length === 0) throw new Error('No reachable reviewer: every provider is EXHAUSTED');

      const { alias, data } = await agents.reviewFinal<ReviewResult>(
        authorship,
        candidates,
        renderPacket(packet),
      );

      return {
        ...data,
        // The old schema did not require an empty findings array. Normalize at
        // the provider boundary as well as tightening the schema so a model
        // omission can never crash the scheduler after the result is stored.
        findings: Array.isArray(data.findings) ? data.findings : [],
        criteria: Array.isArray(data.criteria) ? data.criteria : [],
        reviewer: { ...data.reviewer, id: alias },
      };
    },

    async pullRequestIsDraft(ctx) {
      const pr = await findPullRequestByBranch(github, slug(ctx), ctx.branch);
      return pr?.isDraft === true;
    },

    async writeProvenanceBody(ctx, assessment) {
      const pr = await findPullRequestByBranch(github, slug(ctx), ctx.branch);
      if (!pr) throw new Error(`No pull request for ${ctx.branch}`);

      const validation = repos.lastValidation(ctx.run.id) ?? (await this.runValidation(ctx));
      const criteria = repos.acceptanceCriteria(ctx.run.issueId);
      const attempts = repos.attemptSummary(ctx.run.id);
      const finalReview = repos.lastReview(ctx.run.id);

      // Criterion status comes from the reviewer, never assumed. Hardcoding
      // `satisfied: true` made the deliverable claim success it had not
      // established.
      const explicitStatus = new Map(finalReview?.criteria.map((criterion) => [criterion.id, criterion.status]) ?? []);
      const unsatisfied = new Set(criteria
        .filter((criterion) => explicitStatus.get(criterion.id) !== 'satisfied')
        .map((criterion) => criterion.id));

      const issueUrl = repos.issueUrl(ctx.run.issueId);
      const body = renderPrBody({
        issueId: ctx.run.issueId,
        ...(issueUrl ? { issueUrl } : {}),
        summary: issueContract(ctx).split('\n').slice(0, 3).join(' '),
        criteria: criteria.map((c) => ({
          id: c.id,
          statement: c.statement,
          // With no review recorded nothing is established, so nothing is ticked.
          satisfied: explicitStatus.get(c.id) === 'satisfied',
        })),
        implementationNotes: attempts.map((a) => `- ${a.alias}: ${a.role}`).join('\n'),
        validation: validation.results.map((r) => ({ name: r.name, passed: r.passed, command: r.command })),
        planner: attempts.find((a) => a.role === 'planner')?.alias ?? 'unknown',
        workers: attempts.filter((a) => a.role === 'worker').map((a) => ({ alias: a.alias, taskSummary: a.taskKey ?? '' })),
        integrationReviewer: attempts.find((a) => a.role === 'integration_reviewer')?.alias ?? null,
        finalReviewer:
          finalReview?.reviewer.id ?? attempts.find((a) => a.role === 'final_reviewer')?.alias ?? 'unknown',
        knowledgeStatus: project(ctx).knowledgeStatus === 'verified' ? 'VERIFIED' : 'UNVERIFIED',
        risks: unsatisfied.size > 0 ? [`${unsatisfied.size} acceptance criterion/criteria not established`] : [],
        // Non-blocking findings reach the human here or nowhere.
        reviewNotes: assessment ? toPrComments(assessment) : ['No review was recorded for this run.'],
        ...(ctx.run.baseSha ? { baseSha: ctx.run.baseSha } : {}),
        remediationCycles: repos.remediationCycles(ctx.run.id),
      });

      const title = repos.issueTitle(ctx.run.issueId);
      await updatePullRequestBody(
        github,
        slug(ctx),
        pr.number,
        body,
        title ? `${ctx.run.issueId}: ${title}` : ctx.run.issueId,
      );
    },

    async recordScores(ctx) {
      return finalizeRunScores({ run: ctx.run, repos, git, scoring: config.scoring });
    },

    remediationCycles: (runId) => repos.remediationCycles(runId),
    originalAuthors: (runId) => repos.attemptSummary(runId).map((a) => a.alias),

    async dispatchRemediation(ctx, tasks) {
      const findings = tasks.filter(isRemediationTask);
      if (findings.length !== tasks.length) {
        throw new Error(`${ctx.run.issueId}: persisted remediation plan is malformed`);
      }

      // Recording tasks precedes every worktree/terminal side effect. If the
      // process dies here, the next pass finds the same incomplete cycle and
      // regenerates the same task ids rather than spending another cycle.
      const existing = repos.runTasks(ctx.run.id)
        .map((task) => ({ task, match: /^remediation-(\d+)-/.exec(task.id) }))
        .filter((entry) => entry.match !== null);
      const incomplete = existing.filter((entry) => entry.task.state !== 'DONE');
      const cycle = incomplete.length > 0
        ? Math.max(...incomplete.map((entry) => Number(entry.match![1])))
        : repos.remediationCycles(ctx.run.id) + 1;
      const wave = remediationPlanTasks(findings, cycle);
      repos.recordTasks(ctx.run.id, wave);
      for (const task of wave) await dispatchTask(ctx, task);
      log.info(`${ctx.run.issueId}: dispatched remediation cycle ${cycle} with ${wave.length} task(s)`);
    },

    async blockForHuman(ctx, trigger, question) {
      repos.recordEscalation(ctx.run.issueId, ctx.run.id, trigger, question);
      if (!writeToLinear) return;
      try {
        await postBlockerQuestion(ctx.run.issueId, question, trigger);
        await setAiLifecycleLabel(ctx.run.issueId, 'ai-blocked');
      } catch (err) {
        // Losing the Linear write must not lose the escalation itself.
        log.error(`${ctx.run.issueId}: could not write blocker to Linear`, err);
      }
    },
  };
}

function workerPrompt(ctx: StepContext, task: PlanTask): string {
  return [
    `You are implementing task "${task.id}" for issue ${ctx.run.issueId}.`,
    '',
    task.summary,
    '',
    '## You own ONLY these paths',
    ...task.owns.map((o) => `- ${o}`),
    '',
    'Editing anything outside this set is a scope violation. If the task cannot',
    'be completed without touching another path, stop and say so.',
    '',
    '## Acceptance criteria this task advances',
    ...task.acceptance_criteria.map((c) => `- ${c}`),
    '',
    '## Finishing',
    "This worktree's dependencies were installed for you before you started,",
    'so you can and should run the relevant tests before you finish.',
    '',
    'Leave your changes in the working tree. Do not commit, branch, merge or',
    'push — the controller commits the files you own, on the branch this',
    'worktree already has checked out, once you exit. Anything you change',
    'outside the paths above will NOT be committed and will be reported as a',
    'scope violation, so keep your edits inside them.',
    '',
    'Your last message becomes the commit description. Make it an accurate',
    'account of what you actually changed and what you verified.',
    '',
    `Base branch: ${ctx.baseBranch}. Never merge, never push to the base branch.`,
  ].join('\n');
}
