import type { ControllerConfig } from '../config/load-config.js';
import type { ControllerRepositories } from '../state/repositories.js';
import { createOrcaClient, type OrcaClient } from '../orca/client.js';
import { createGitHub, type GitHub } from '../github/client.js';
import { createGit, realGit } from '../git/repository.js';
import { createInvoker } from '../agents/invoke.js';
import { ollamaTransport } from '../agents/ollama-profiles.js';
import { codexTransport } from '../agents/codex-profiles.js';
import { createAgents } from '../agents/roles.js';
import { defaultPressure, pressureFromOrca, withOverride } from '../routing/pressure.js';
import { listIssuesByLabel, getIssueContract } from '../linear/issues.js';
import { setAiLifecycleLabel } from '../linear/labels.js';
import { postBlockerQuestion } from '../linear/dependencies.js';
import { listRecentlyMerged, issueIdFromBranch } from '../github/pull-requests.js';
import { createSteps } from './steps.js';
import {
  createDispatcher,
  defaultAgentNameFor,
  matchesRequestedBranch,
  shortBranch,
  type DispatchDeps,
} from './dispatch.js';
import {
  createParentWorktree,
  listRepos,
  listWorktrees,
  findRepoBySlug,
  branchNameFor,
  worktreePathFromId,
} from '../orca/worktrees.js';
import { advanceRun, type OrchestratorDeps, type StepContext } from './orchestrator.js';
import type { RunnerDeps } from './runner.js';
import type { WorkItem } from '../scheduler/priority.js';
import type { CapacityState } from '../scheduler/capacity.js';
import { projectToLinear } from './states.js';
import { logger } from '../util/log.js';

const log = logger('wire');

export interface WiringOptions {
  config: ControllerConfig;
  repos: ControllerRepositories;
  /** Set false for dry runs so Linear is never written to. */
  writeToLinear?: boolean;
  orca?: OrcaClient;
  github?: GitHub;
}

/**
 * The composition root.
 *
 * Everything else in this codebase takes its dependencies as parameters so it
 * can be tested in isolation. That only works if exactly one place assembles
 * the real thing — without it, every module is individually correct and
 * nothing runs.
 */
export function buildController(options: WiringOptions) {
  const { config, repos } = options;
  const orca = options.orca ?? createOrcaClient({ bin: config.global.orca.bin });
  const github = options.github ?? createGitHub();
  const git = createGit(realGit);
  const writeToLinear = options.writeToLinear !== false;

  const invoker = createInvoker({
    rootDir: config.rootDir,
    routing: config.routing,
    transports: [ollamaTransport(), codexTransport()],
  });
  const agents = createAgents(invoker, config.routing);

  // Operator override, which the design lists as a pressure source but nothing
  // implemented. Needed because a provider can be reachable yet unusable:
  // Ollama Cloud answers 403 "requires a subscription", which no amount of
  // retrying fixes, and challenger exploration would otherwise keep selecting
  // it and failing.
  const disabled = (process.env['AI_DEV_DISABLED_PROVIDERS'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  let pressure = defaultPressure(config.routing);
  for (const provider of disabled) {
    pressure = withOverride(pressure, provider, 'EXHAUSTED');
    log.warn(`provider "${provider}" disabled by AI_DEV_DISABLED_PROVIDERS; routing will not select it`);
  }

  // Pin every role to one alias. A pilot needs a known, reachable model rather
  // than whatever routing picks; without this, one unavailable challenger can
  // fail a run for reasons unrelated to what is being tested.
  const forced = process.env['AI_DEV_FORCE_ALIAS'];
  if (forced && !config.routing.aliases[forced]) {
    throw new Error(`AI_DEV_FORCE_ALIAS="${forced}" is not a declared alias`);
  }
  if (forced) log.warn(`AI_DEV_FORCE_ALIAS=${forced}: every role will use this alias`);

  const routingConfig = forced
    ? {
        ...config.routing,
        roles: Object.fromEntries(
          Object.entries(config.routing.roles).map(([role]) => [role, { champion: forced, challengers: [] }]),
        ),
      }
    : config.routing;

  const routing = {
    routing: routingConfig,
    scoring: config.scoring,
    pressure,
    stats: (projectId: string, role: string, alias: string) => repos.aliasStats(projectId, role, alias),
  };

  const steps: OrchestratorDeps = createSteps({
    config,
    repos,
    agents,
    orca,
    github,
    git,
    gitRunner: realGit,
    routing,
    agentNameFor: defaultAgentNameFor(config),
    writeToLinear,
  });

  const dispatchDeps: DispatchDeps = {
    config,
    repos,
    orca,
    github,
    git,
    routing,
    agentNameFor: defaultAgentNameFor(config),
  };

  /** Builds the context a step needs from persisted run state. */
  function contextFor(runId: string): StepContext | null {
    const run = repos.getRun(runId);
    if (!run) return null;
    const project = config.registry.projects[run.repositoryId];
    if (!project) {
      log.warn(`${run.issueId}: run references unregistered project ${run.repositoryId}`);
      return null;
    }
    // Before the worktree exists there is nothing to operate on, and the
    // registry path is not an acceptable stand-in: it has the base branch
    // checked out. `advanceAll` provisions first and rebuilds the context.
    return {
      run,
      projectId: run.repositoryId,
      ciTrigger: project.ci.trigger,
      risk: 'low',
      baseBranch: project.repository.baseBranch,
      branch: run.branch ?? '',
      worktreePath: run.orcaWorktreeId ? worktreePathFromId(run.orcaWorktreeId) : '',
    };
  }

  /**
   * Creates the branch, fresh base and worktree for an already-claimed run.
   *
   * Separate from claiming so the two can fail independently: losing the
   * worktree must not cost the claim, and re-running must not create a second
   * branch.
   */
  async function provisionWorkspace(runId: string): Promise<boolean> {
    const run = repos.getRun(runId);
    if (!run) return false;
    const project = config.registry.projects[run.repositoryId];
    if (!project) return false;

    const requested = branchNameFor(config.global.git.branchPrefix, run.issueId);
    const baseSha = await git.fetchFreshBase(project.repository.path, project.repository.baseBranch);

    const orcaRepos = await listRepos(orca);
    const repo = findRepoBySlug(orcaRepos, project.repository.github);
    if (!repo) {
      log.error(`${run.issueId}: ${project.repository.github} is not registered in Orca`);
      return false;
    }

    // Adopt an existing worktree rather than creating a second one.
    // The same matcher dispatch uses, so a run provisioned here adopts the
    // worktree dispatch created rather than making a second one.
    const existing = (await listWorktrees(orca).catch(() => [])).find((w) =>
      matchesRequestedBranch(w, requested),
    );
    const worktree =
      existing ??
      (await createParentWorktree(orca, {
        repoSelector: `id:${repo.id}`,
        name: requested,
        baseBranch: project.repository.baseBranch,
        linearIssue: run.issueId,
      }));

    // Orca owns branch naming: `--name ai/JP-9-work` becomes
    // `JPClow3/ai/JP-9-work`. Recording the requested name instead of the real
    // one produced a push of a ref that does not exist locally.
    const branch = shortBranch(worktree.branch) || requested;
    repos.attachRunWorkspace(runId, { branch, baseSha, orcaWorktreeId: worktree.id });
    log.info(`${run.issueId}: workspace ${branch} at ${baseSha.slice(0, 8)}`);
    return true;
  }

  /**
   * Advances every active run by one step.
   *
   * One step per tick keeps each transition a resumption point; a crash leaves
   * a state the reconciler can read rather than an unknown position inside a
   * long-running function.
   */
  async function advanceAll(): Promise<number> {
    let moved = 0;
    for (const run of repos.activeRuns()) {
      let ctx = contextFor(run.id);
      if (!ctx) continue;

      // A run can be claimed and then fail before its worktree exists — and
      // once Linear says ai-running it never comes back through the ready
      // wave, so nothing would ever repair it. Provision here instead of
      // stranding the claim.
      if (!ctx.branch || !ctx.worktreePath) {
        log.info(`${run.issueId}: claimed without a workspace; provisioning`);
        const provisioned = await provisionWorkspace(run.id).catch((err: unknown) => {
          log.error(`${run.issueId}: could not provision workspace`, (err as Error).message);
          return false;
        });
        if (!provisioned) continue;
        ctx = contextFor(run.id);
        if (!ctx?.branch || !ctx.worktreePath) continue;
      }
      try {
        const result = await advanceRun(ctx, steps);
        if (result.to) {
          moved += 1;
          log.info(`${run.issueId}: ${result.from} -> ${result.to} (${result.detail ?? ''})`);
          await syncLinear(run.issueId, result.to);
        }
      } catch (err) {
        log.error(`${run.issueId}: step failed`, (err as Error).message);
      }
    }
    return moved;
  }

  async function syncLinear(issueId: string, state: Parameters<typeof projectToLinear>[0]): Promise<void> {
    if (!writeToLinear) return;
    const label = projectToLinear(state);
    if (!label) return;
    try {
      await setAiLifecycleLabel(issueId, label);
    } catch (err) {
      // A failed label write must not roll back real progress.
      log.warn(`${issueId}: could not set ${label} in Linear`, (err as Error).message);
    }
  }

  const runnerDeps: RunnerDeps = {
    config,
    repos,

    reconcile: advanceAll,

    async fetchReadyIssues() {
      const label = config.global.linear.labels.ready;
      const issues = await listIssuesByLabel(label);
      const out = [];
      for (const issue of issues) {
        // The contract read gives us the explicit blockers; inferred ones are
        // never trusted.
        const contract = await getIssueContract(issue.identifier);
        out.push({
          identifier: issue.identifier,
          title: issue.title,
          projectName: issue.projectName,
          description: contract.description,
          labels: issue.labels,
          blockedBy: contract.blockedBy,
        });
      }
      return out;
    },

    async syncMergedPullRequests() {
      const merged: string[] = [];
      const slugs = new Set(
        Object.values(config.registry.projects).filter((p) => p.enabled).map((p) => p.repository.github),
      );
      for (const slug of slugs) {
        try {
          for (const pr of await listRecentlyMerged(github, slug, 30)) {
            const issueId = issueIdFromBranch(pr.headRefName, config.global.git.branchPrefix);
            if (issueId) merged.push(issueId);
          }
        } catch (err) {
          log.warn(`could not read merged PRs for ${slug}`, (err as Error).message);
        }
      }
      return merged;
    },

    async pendingWork(): Promise<WorkItem[]> {
      // Active runs are advanced by `reconcile`; they are not re-queued here,
      // or a run would be stepped twice in one tick.
      return [];
    },

    async capacityState(): Promise<CapacityState> {
      const runs = repos.activeRuns();
      return {
        activeIssues: runs.map((r) => r.issueId),
        agents: runs.map((r) => ({
          issueId: r.issueId,
          repositoryId: r.repositoryId,
          aliasId: 'active',
          provider: 'ollama' as const,
          heavy: false,
          luna: false,
        })),
      };
    },

    async remediationBacklog() {
      return repos.activeRuns().filter((r) => r.state === 'REMEDIATING').length;
    },

    async providerPressures() {
      // Start from every configured provider, then overlay what Orca reports.
      // Returning only the Orca-derived entry made "all providers EXHAUSTED"
      // true from a sample of one: a spent Codex quota throttled the whole
      // controller even though Ollama was idle and usable.
      const base = defaultPressure(config.routing);
      try {
        const accounts = await orca.json<{ rateLimits?: Parameters<typeof pressureFromOrca>[0] }>([
          'account',
          'list',
        ]);
        Object.assign(base, pressureFromOrca(accounts.rateLimits ?? {}));
      } catch {
        // No quota data is not the same as no quota.
      }
      return Object.values(base).map((p) => p.pressure);
    },

    dispatch: createDispatcher(dispatchDeps),

    async markNeedsContext(identifier, message) {
      repos.recordEscalation(identifier, '', 'repository_resolution_ambiguous', message);
      if (!writeToLinear) return;
      await postBlockerQuestion(identifier, message).catch(() => undefined);
      await setAiLifecycleLabel(identifier, 'ai-needs-context').catch(() => undefined);
    },

    async flagCycle(identifiers) {
      const message = `Dependency cycle detected: ${identifiers.join(' -> ')}. It cannot resolve on its own.`;
      for (const id of identifiers) {
        repos.recordEscalation(id, '', 'dependency_cycle_detected', message);
        if (writeToLinear) await postBlockerQuestion(id, message).catch(() => undefined);
      }
    },
  };

  return { runnerDeps, steps, agents, orca, github, git, advanceAll, contextFor };
}

export type Controller = ReturnType<typeof buildController>;
