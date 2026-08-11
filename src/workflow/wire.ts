import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ControllerConfig } from '../config/load-config.js';
import type { ControllerRepositories } from '../state/repositories.js';
import { createOrcaClient, type OrcaClient } from '../orca/client.js';
import { createGitHub, type GitHub } from '../github/client.js';
import { createGit, realGit } from '../git/repository.js';
import { createInvoker } from '../agents/invoke.js';
import { ollamaTransport } from '../agents/ollama-profiles.js';
import { codexTransport } from '../agents/codex-profiles.js';
import { createAgents, reviewerCandidates } from '../agents/roles.js';
import { defaultPressure, pressureFromOrca, withOverride } from '../routing/pressure.js';
import { isUsable } from '../routing/pressure.js';
import {
  applyQuotaCooldown,
  isProviderQuotaExhausted,
  refreshRuntimePressure,
} from '../routing/quota.js';
import {
  listIssuesByLabel,
  listIssuesCreatedBetween,
  getIssueContract,
  updateIssueContract,
  commentOnIssue,
} from '../linear/issues.js';
import { clearAiLifecycleLabels, setAiLifecycleLabel } from '../linear/labels.js';
import { AUTO_CURATE_CURSOR_KEY, autoCurateNewIssues } from '../linear/auto-curate.js';
import { postBlockerQuestion } from '../linear/dependencies.js';
import {
  findPullRequestByBranch,
  listRecentlyMerged,
  issueIdFromBranch,
} from '../github/pull-requests.js';
import { readChecks } from '../github/checks.js';
import { readWorkerExit, WORKER_EXIT_FILE } from '../orca/terminals.js';
import { reconcileIncompleteRuns, type RuntimeRecoveryResult } from '../recovery/runtime.js';
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
import { finalizeRunScores } from '../scoring/runtime.js';
import { resolveRepository } from '../projects/resolver.js';
import { selectModel } from '../routing/selector.js';
import {
  curateIssues as processCuration,
  normalizeCuratedBody,
  type CuratedIssueResult,
  type CuratorIssue,
  type NeedsContext,
} from '../curation/curate.js';
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
  refreshRuntimePressure(pressure, config.routing, repos.activeProviderPressures(), disabled);

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
        }
      } catch (err) {
        if (isProviderQuotaExhausted(err)) {
          const resetAt = applyQuotaCooldown(repos, pressure, err);
          log.warn(
            `${run.issueId}: ${err.provider} exhausted; final review paused until ${resetAt.toISOString()}`,
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
  async function recoverReality(apply = true): Promise<RuntimeRecoveryResult> {
    // One Orca list per recovery pass, shared by every active run. The promise
    // is scoped to this call so a later tick never reuses a stale snapshot.
    const worktrees = listWorktrees(orca);

    const result = await reconcileIncompleteRuns({
      repos,
      apply,
      ciTriggerFor(run) {
        return config.registry.projects[run.repositoryId]?.ci.trigger ?? 'pull_request';
      },

      async observeOrca(run) {
        const all = await worktrees;
        const parent = all.find(
          (w) => w.id === run.orcaWorktreeId || (run.branch ? matchesRequestedBranch(w, run.branch) : false),
        );
        const tasks = repos.runTasks(run.id);
        const firstWave = tasks.filter((task) => task.blocked_by.length === 0);
        const planningComplete = tasks.length > 0
          && firstWave.length > 0
          && firstWave.every((task) => Boolean(task.orcaWorktreeId));
        const dispatched = tasks.filter((task) => task.state === 'DISPATCHED');
        const exits = dispatched.map((task) => {
          const path = join(config.rootDir, 'data', 'workers', run.id, task.id, WORKER_EXIT_FILE);
          return readWorkerExit(existsSync(path) ? readFileSync(path, 'utf8') : null);
        });
        const agentRunning = exits.some((exit) => exit === null);
        const implementationPending = tasks.some((task) => task.state !== 'DONE');
        const agentSettled = tasks.length > 0 && !agentRunning && tasks.every((task) =>
          task.state === 'DONE' || task.state === 'FAILED' || task.state === 'PENDING' || task.state === 'DISPATCHED',
        );
        return {
          worktreeExists: Boolean(parent),
          planningComplete,
          implementationPending,
          agentRunning,
          agentSettled,
        };
      },

      async observeGit(run) {
        const project = config.registry.projects[run.repositoryId];
        if (!project || !run.branch) {
          return { branchExists: false, hasCommitsBeyondBase: false, branchPushed: false };
        }
        const worktreePath = run.orcaWorktreeId ? worktreePathFromId(run.orcaWorktreeId) : '';
        const repositoryPath = worktreePath && existsSync(worktreePath) ? worktreePath : project.repository.path;
        const branchExists = await git.branchExists(repositoryPath, run.branch);
        const branchPushed = await git.remoteBranchExists(repositoryPath, run.branch);
        const hasCommitsBeyondBase = Boolean(
          run.baseSha &&
            worktreePath &&
            existsSync(worktreePath) &&
            (await git.commitsSince(worktreePath, run.baseSha)).length > 0,
        );
        const workerShas = run.state === 'INTEGRATING'
          ? repos.workerCommits(run.id).flatMap((worker) => worker.commits)
          : [];
        const integrationPending = workerShas.length > 0 && (
          !worktreePath ||
          !existsSync(worktreePath) ||
          (await Promise.all(workerShas.map((sha) => git.patchPresent(worktreePath, sha))))
            .some((present) => !present)
        );
        return { branchExists, hasCommitsBeyondBase, branchPushed, integrationPending };
      },

      async observeGitHub(run) {
        const project = config.registry.projects[run.repositoryId];
        if (!project || !run.branch) {
          return {
            pullRequestNumber: null,
            isDraft: false,
            merged: false,
            checksComplete: false,
            requiredChecksPassed: false,
          };
        }
        const pr = await findPullRequestByBranch(github, project.repository.github, run.branch);
        if (!pr) {
          return {
            pullRequestNumber: null,
            isDraft: false,
            merged: false,
            checksComplete: false,
            requiredChecksPassed: false,
          };
        }
        if (pr.merged) {
          // Merge truth is already authoritative. CI is valuable scoring
          // evidence, but an optional checks outage must not hide the merge
          // and keep downstream dependencies blocked.
          try {
            const checks = await readChecks(github, project.repository.github, pr.number, project.ci.requiredChecks);
            repos.recordCiObservation(run.id, checks);
          } catch (error) {
            log.warn(`${run.issueId}: merged PR checks unavailable during recovery - ${(error as Error).message}`);
          }
          return {
            pullRequestNumber: pr.number,
            url: pr.url,
            isDraft: pr.isDraft,
            headBranch: pr.headRefName,
            baseBranch: pr.baseRefName,
            merged: true,
            checksComplete: true,
            requiredChecksPassed: true,
          };
        }
        const checks = await readChecks(github, project.repository.github, pr.number, project.ci.requiredChecks);
        // Recovery evidence must be usable by routing too. Otherwise a crash
        // that authoritatively fast-forwards CI silently degrades its score to
        // the neutral missing-telemetry value.
        repos.recordCiObservation(run.id, checks);
        return {
          pullRequestNumber: pr.number,
          url: pr.url,
          isDraft: pr.isDraft,
          headBranch: pr.headRefName,
          baseBranch: pr.baseRefName,
          merged: false,
          checksComplete: checks.complete,
          requiredChecksPassed: checks.allRequiredPassed,
        };
      },

      async observeLinear(run) {
        const issue = await getIssueContract(run.issueId);
        const lifecycle = issue.labels.find((label) => label.startsWith('ai-')) ?? null;
        return { label: lifecycle };
      },

      async onApplied(run, report) {
        if (!apply) return;
        await syncLinear(run.issueId, report.derivedState);
        if (report.derivedState === 'MERGED') {
          await finalizeRunScores({ run, repos, git, scoring: config.scoring }).catch((error: unknown) => {
            log.warn(`${run.issueId}: merge-recovery scoring deferred - ${(error as Error).message}`);
          });
        }
      },
    });

    for (const failure of result.observationErrors) {
      log.warn(`${failure.runId}: ${failure.system} recovery probe failed`, failure.message);
    }
    return result;
  }

  const runnerDeps: RunnerDeps = {
    config,
    repos,

    async reconcile() {
      const recovery = await recoverReality();
      const recovered = new Set(recovery.appliedRunIds);
      return recovered.size + (await advanceAll(recovered));
    },

    async adoptNewIssues() {
      // Dry runs must not consume the durable watermark: the same issues need
      // to remain visible when the controller is restarted with writes on.
      if (!writeToLinear) return 0;
      const report = await autoCurateNewIssues({
        getCursor: () => repos.getControllerMeta(AUTO_CURATE_CURSOR_KEY),
        setCursor: (value) => repos.setControllerMeta(AUTO_CURATE_CURSOR_KEY, value),
        fetchIssues: listIssuesCreatedBetween,
        resolveRepository(issue) {
          const resolution = resolveRepository(issue, config.registry);
          if (!resolution.ok) {
            return {
              ok: false,
              message: resolution.message,
              candidates: resolution.candidates,
            };
          }
          return {
            ok: true,
            projectId: resolution.projectId,
            context: projectKnowledge(resolution.projectId),
          };
        },
        setLifecycle: setAiLifecycleLabel,
        async requestContext(identifier, message, candidates) {
          await commentOnIssue(
            identifier,
            [
              'AI controller could not resolve a repository for this new issue:',
              `- ${message}`,
              ...(candidates?.length ? [`- Candidate repositories: ${candidates.join(', ')}`] : []),
            ].join('\n'),
          );
        },
      });
      for (const identifier of report.needsContext) {
        log.warn(`${identifier}: new issue needs repository context`);
      }
      return report.adopted.length + report.needsContext.length;
    },

    async curateIssues() {
      const summaries = await listIssuesByLabel(config.global.linear.labels.curate);
      const rough: CuratorIssue[] = [];
      for (const summary of summaries) {
        const issue = await getIssueContract(summary.identifier);
        rough.push({
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description,
          labels: issue.labels,
          projectName: issue.projectName,
          url: issue.url,
        });
      }

      const report = await processCuration({
        fetchIssues: async () => rough,
        resolveRepository(issue) {
          const resolution = resolveRepository(issue, config.registry);
          if (!resolution.ok) {
            return {
              ok: false,
              message: resolution.message,
              candidates: resolution.candidates,
            };
          }
          return {
            ok: true,
            projectId: resolution.projectId,
            context: projectKnowledge(resolution.projectId),
          };
        },
        async invokeCurator(issue, repository) {
          const decision = selectModel(
            { projectId: repository.projectId, role: 'issue_cleanup', risk: 'low' },
            routing,
          );
          const input = JSON.stringify(
            {
              raw_issue: issue,
              resolved_repository: repository.projectId,
              repository_knowledge: repository.context,
              routing_categories: Object.keys(routingConfig.roles),
              sibling_issues: [],
            },
            null,
            2,
          );
          return agents.curate<CuratedIssueResult>(decision.alias, input);
        },
        async persistCurated(issue, result) {
          const projectId = result.repository!;
          const role = result.task_category!;
          if (!routingConfig.roles[role]) {
            throw new Error(`curator returned unknown task_category ${role}`);
          }
          mirrorProject(projectId);
          repos.upsertIssue({
            id: issue.identifier,
            projectId,
            title: issue.title,
            body: issue.description,
            url: issue.url,
          });
          const body = normalizeCuratedBody(result.body!, result.acceptance_criteria!);
          repos.recordCuratedIssue(issue.identifier, {
            title: result.title!,
            body,
            role,
            risk: result.risk!,
            acceptanceCriteria: result.acceptance_criteria!,
          });
          if (writeToLinear) {
            await updateIssueContract(issue.identifier, { title: result.title!, body });
            for (const proposal of result.dependency_proposals ?? []) {
              await commentOnIssue(
                issue.identifier,
                [
                  'AI dependency proposal (not applied):',
                  `- ${proposal.blocked_issue} blocked by ${proposal.blocking_issue}`,
                  `- Criterion: ${proposal.acceptance_criterion}`,
                  `- Reason: ${proposal.reason}`,
                  '',
                  'A human must approve and create this Linear relation.',
                ].join('\n'),
              );
            }
          }
        },
        async requestContext(identifier, context: NeedsContext) {
          if (!writeToLinear) return;
          await commentOnIssue(
            identifier,
            [
              `AI curation needs context (${context.reason}):`,
              ...context.questions.map((question) => `- ${question}`),
              ...(context.candidate_repositories?.length
                ? [`- Candidate repositories: ${context.candidate_repositories.join(', ')}`]
                : []),
            ].join('\n'),
          );
        },
        async setLifecycle(identifier, label) {
          if (writeToLinear) await setAiLifecycleLabel(identifier, label);
        },
      });

      for (const failure of report.failed) {
        log.warn(`${failure.identifier}: curation failed`, failure.error);
      }
      return report.curated.length + report.needsContext.length;
    },

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
          url: contract.url,
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
      let observed = {};
      try {
        const accounts = await orca.json<{ rateLimits?: Parameters<typeof pressureFromOrca>[0] }>([
          'account',
          'list',
        ]);
        observed = pressureFromOrca(accounts.rateLimits ?? {});
      } catch {
        // No quota data is not the same as no quota.
      }
      refreshRuntimePressure(
        pressure,
        config.routing,
        repos.activeProviderPressures(),
        disabled,
        observed,
      );
      return Object.values(pressure).map((p) => p.pressure);
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

  return { runnerDeps, steps, agents, orca, github, git, advanceAll, recoverReality, contextFor };
}

export type Controller = ReturnType<typeof buildController>;
