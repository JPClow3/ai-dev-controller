import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ControllerConfig } from '../config/load-config.js';
import type { ControllerRepositories } from '../state/repositories.js';
import { createOrcaClient, type OrcaClient } from '../orca/client.js';
import { createGitHub, type GitHub } from '../github/client.js';
import { createGit, realGit } from '../git/repository.js';
import { createInvoker } from '../agents/invoke.js';
import { codexTransport } from '../agents/codex-profiles.js';
import { createAgents, reviewerCandidates } from '../agents/roles.js';
import { defaultPressure, withOverride } from '../routing/pressure.js';
import { isUsable } from '../routing/pressure.js';
import {
  applyQuotaCooldown,
  isProviderQuotaExhausted,
  refreshRuntimePressure,
} from '../routing/quota.js';
import { clearAiLifecycleLabels, setAiLifecycleLabel } from '../linear/labels.js';
import { createSteps } from './steps.js';
import { defaultAgentNameFor, matchesRequestedBranch, shortBranch, type DispatchDeps } from './dispatch.js';
import {
  createParentWorktree,
  listRepos,
  listWorktrees,
  findRepoBySlug,
  branchNameFor,
  worktreePathFromId,
  setWorktreeWorkspaceStatus,
} from '../orca/worktrees.js';
import { advanceRun, type OrchestratorDeps, type StepContext } from './orchestrator.js';
import { projectToLinear, projectToOrcaBoard } from './states.js';
import { createRecovery } from './wire-recovery.js';
import { createRunnerDeps } from './wire-runner.js';
import { forcePilotAlias } from '../routing/forced.js';
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
    transports: [codexTransport()],
  });
  const agents = createAgents(invoker, config.routing, {
    onUsage: (aliasId, role, usage) =>
      repos.recordTokenUsage({
        aliasId,
        role,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }),
  });

  // Operator override, which the design lists as a pressure source but nothing
  // implemented. Needed because a provider can be reachable yet unusable — a
  // subscription lapse answers 403 forever, which no amount of retrying fixes,
  // and challenger exploration would otherwise keep selecting it and failing.
  const disabled = (process.env['AI_DEV_DISABLED_PROVIDERS'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  let pressure = defaultPressure(config.routing);
  for (const provider of disabled) {
    pressure = withOverride(pressure, provider, 'EXHAUSTED');
    log.warn(`provider "${provider}" disabled by AI_DEV_DISABLED_PROVIDERS; routing will not select it`);
  }
  refreshRuntimePressure(pressure, config.routing, repos.activeProviderPressures(), disabled);

  // Pin every role to one alias. A pilot needs a known, reachable model rather
  // than whatever routing picks; without this, one unavailable challenger can
  // fail a run for reasons unrelated to what is being tested.
  const forced = process.env['AI_DEV_FORCE_ALIAS'];
  if (forced && !config.routing.aliases[forced]) {
    throw new Error(`AI_DEV_FORCE_ALIAS="${forced}" is not a declared alias`);
  }
  if (forced) log.warn(`AI_DEV_FORCE_ALIAS=${forced}: every non-safety role will use this alias`);

  const routingConfig = forced ? forcePilotAlias(config.routing, forced) : config.routing;

  const routing = {
    routing: routingConfig,
    scoring: config.scoring,
    pressure,
    stats: (projectId: string, role: string, alias: string) => repos.aliasStats(projectId, role, alias),
  };

  function mirrorProject(projectId: string): void {
    const entry = config.registry.projects[projectId];
    if (!entry) throw new Error(`No registered project ${projectId}`);
    repos.upsertProject({
      id: projectId,
      enabled: entry.enabled,
      repoPath: entry.repository.path,
      githubSlug: entry.repository.github,
      baseBranch: entry.repository.baseBranch,
      linearProject: entry.linear.project ?? null,
      knowledgeStatus: entry.knowledgeStatus,
      maxAgents: entry.maxAgents ?? config.global.concurrency.agentsPerRepository,
      routingProfile: entry.routingProfile,
    });
  }

  /** A bounded, repository-owned context packet for issue cleanup. */
  function projectKnowledge(projectId: string): string {
    const project = config.registry.projects[projectId];
    if (!project) return '';
    const candidates = [
      '.ai-workflow/project.yaml',
      '.ai-workflow/knowledge-map.yaml',
      'AGENTS.md',
      'README.md',
      'packages/shared/README.md',
    ];
    const perFile = Math.min(config.global.knowledge.maxFileBytes, 32_768);
    const sections: string[] = [];
    for (const relative of candidates) {
      const path = join(project.repository.path, relative);
      if (!existsSync(path)) continue;
      const content = readFileSync(path, 'utf8');
      sections.push(`## ${relative}\n${content.slice(0, perFile)}`);
    }
    return sections.join('\n\n').slice(0, 96_000);
  }

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
      risk: repos.issueRouting(run.issueId).risk,
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
    const existing = (await listWorktrees(orca)).find((w) =>
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
    await syncOrcaBoard(run.issueId, worktree.id, 'PLANNING');
    return true;
  }

  /**
   * Moves the run's worktree to the board column matching a workflow state.
   *
   * Deliberately fire-and-forget beside the Linear write: a board column is
   * presentation, and losing it must never roll back or block a transition.
   * Startup recovery re-projects the current state on the next tick, so a
   * dropped write self-heals.
   */
  async function syncOrcaBoard(
    issueId: string,
    worktreeId: string | null,
    state: Parameters<typeof projectToOrcaBoard>[0],
  ): Promise<void> {
    if (!worktreeId) return;
    try {
      await setWorktreeWorkspaceStatus(orca, worktreeId, projectToOrcaBoard(state));
    } catch (err) {
      log.warn(`${issueId}: could not move worktree to "${projectToOrcaBoard(state)}" on the Orca board`, (err as Error).message);
    }
  }

  /**
   * Advances every active run by one step.
   *
   * One step per tick keeps each transition a resumption point; a crash leaves
   * a state the reconciler can read rather than an unknown position inside a
   * long-running function.
   */
  async function advanceAll(skipRunIds: ReadonlySet<string> = new Set()): Promise<number> {
    refreshRuntimePressure(pressure, config.routing, repos.activeProviderPressures(), disabled);
    let moved = 0;
    for (const run of repos.activeRuns()) {
      if (skipRunIds.has(run.id)) continue;
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
      if (
        ctx.run.state === 'FINAL_REVIEW' &&
        !reviewerCandidates(routingConfig).some((alias) => {
          const spec = routingConfig.aliases[alias];
          return spec ? isUsable(pressure, spec.provider) : false;
        })
      ) {
        // Durable provider cooldown: leave the run at its resumable state and
        // do not invoke the CLI again until the recorded reset expires.
        continue;
      }
      try {
        const result = await advanceRun(ctx, steps);
        if (result.to) {
          moved += 1;
          log.info(`${run.issueId}: ${result.from} -> ${result.to} (${result.detail ?? ''})`);
          await syncLinear(run.issueId, result.to);
          await syncOrcaBoard(run.issueId, ctx.run.orcaWorktreeId, result.to);
        }
      } catch (err) {
        if (isProviderQuotaExhausted(err)) {
          const resetAt = applyQuotaCooldown(repos, pressure, err);
          log.warn(
            `${run.issueId}: ${err.provider} exhausted; ${ctx.run.state} paused until ${resetAt.toISOString()}`,
          );
        } else {
          log.error(`${run.issueId}: step failed`, (err as Error).message);
        }
      }
    }
    return moved;
  }

  async function syncLinear(issueId: string, state: Parameters<typeof projectToLinear>[0]): Promise<void> {
    if (!writeToLinear) return;
    const label = projectToLinear(state);
    try {
      if (label) await setAiLifecycleLabel(issueId, label);
      else if (state === 'MERGED') await clearAiLifecycleLabels(issueId);
    } catch (err) {
      // A failed label write must not roll back real progress. Startup
      // reconciliation will try this projection again on the next tick.
      log.warn(`${issueId}: could not project ${state} to Linear`, (err as Error).message);
    }
  }

  /**
   * Rebuilds persisted workflow state from the four external systems before
   * normal orchestration resumes. This is deliberately separate from
   * `advanceAll`: recovery observes completed side effects first, so a crash
   * between an API call and its SQLite write cannot repeat that side effect.
   */
  const recoverReality = createRecovery({
    config,
    repos,
    orca,
    git,
    github,
    syncLinear,
    syncBoard: syncOrcaBoard,
  });

  const runnerDeps = createRunnerDeps({
    config,
    repos,
    writeToLinear,
    recoverReality,
    advanceAll,
    projectKnowledge,
    mirrorProject,
    agents,
    routing,
    routingConfig,
    pressure,
    disabled,
    orca,
    github,
    dispatchDeps,
  });

  return { runnerDeps, steps, agents, orca, github, git, advanceAll, recoverReality, contextFor };
}

export type Controller = ReturnType<typeof buildController>;
