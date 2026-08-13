import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Risk } from '../state/types.js';
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
import { createWorkerWorktree, findWorkerWorktree, listWorktrees, worktreePathFromId } from '../orca/worktrees.js';
import {
  readEffectiveSetupCommandAtBaseSha,
  readValidationCommandsAtBaseSha,
} from '../validation/local.js';
import { assertSafeValidationCommand } from '../validation/safety.js';
import { selectModel } from '../routing/selector.js';
import type { OrchestratorDeps, PlanTask, StepContext } from './orchestrator.js';
import type { StepsWiring } from './step-types.js';
import {
  alignRemediationWorktree,
  cleanFailedAttempt,
  effectiveTaskRisk,
  formatWorkerCommitMessage,
  isRemediationTask,
  remediationPlanTasks,
  shouldWaitForExistingWorkerLaunch,
  workerPrompt,
  workerTerminalTitle,
  workerWorktreeName,
} from './step-helpers.js';
import { logger } from '../util/log.js';

const log = logger('step-workers');

interface PlanResponse {
  verdict: 'planned' | 'blocked';
  blocked?: { reason: string; question: string };
  tasks?: PlanTask[];
}

export interface WorkerStepEnvironment {
  wiring: StepsWiring;
  repoPath: (ctx: StepContext) => string;
  treePath: (ctx: StepContext) => string;
  workerControlDir: (ctx: StepContext, taskKey: string) => string;
  readIfPresent: (base: string, relative: string) => string;
  issueContract: (ctx: StepContext) => string;
}

/** Screens setup at the last boundary before the controller launches it. */
export function assertSafeWorkerSetup(command: string | undefined, forbiddenOperations: readonly string[]): void {
  if (command) assertSafeValidationCommand(command, forbiddenOperations);
}

export type WorkerStepHandlers = Pick<
  OrchestratorDeps,
  | 'fetchFreshBase'
  | 'plan'
  | 'createWorktrees'
  | 'dispatchNextWave'
  | 'workersSettled'
  | 'retryInterruptedWorkers'
  | 'dispatchRemediation'
>;

/**
 * Worker lifecycle is intentionally isolated from integration, validation and
 * review. It owns the attempt/worktree protocol and exposes only orchestrator
 * seams, keeping the composition root readable without changing the state
 * machine's public dependency contract.
 */
export function createWorkerStepHandlers(env: WorkerStepEnvironment): WorkerStepHandlers {
  const { wiring } = env;
  const { config, repos, agents, orca, git } = wiring;

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
      await alignRemediationWorktree(git, worktree.path, env.treePath(ctx));
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
    const controlDir = env.workerControlDir(ctx, task.id);
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
    const setup = ctx.run.baseSha
      ? await readEffectiveSetupCommandAtBaseSha(env.treePath(ctx), ctx.run.baseSha)
      : null;
    // Setup runs before the Codex sandbox starts, with the controller's own
    // credentials. It must cross the same policy boundary as validation.
    assertSafeWorkerSetup(setup?.command, config.global.safety.forbiddenOperations);
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

  async function trackedFiles(ctx: StepContext, limit = 600): Promise<string> {
    try {
      const out = await wiring.gitRunner(env.treePath(ctx), ['ls-files']);
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

  async function commitWorkerChanges(
    ctx: StepContext,
    task: { id: string; summary: string; owns: string[]; task_category?: string },
    workerPath: string,
    controlDir: string,
  ): Promise<void> {
    const run = (args: string[]) => wiring.gitRunner(workerPath, args);

    const dirty = await run(['status', '--porcelain']).catch(() => '');
    if (!dirty.trim()) return;
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
      workerSummary: env.readIfPresent(controlDir, WORKER_RESULT_FILE).trim(),
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
    const ordered = [...commits].reverse();
    repos.recordAttemptResult(ctx.run.id, taskKey, {
      commits: ordered,
      finalMessage: env.readIfPresent(controlDir, WORKER_RESULT_FILE).slice(0, 4000),
    });
    return ordered;
  }

  return {
    async fetchFreshBase(ctx) {
      return git.fetchFreshBase(env.repoPath(ctx), ctx.baseBranch);
    },

    async plan(ctx) {
      const decision = selectModel(
        { projectId: ctx.projectId, role: 'orchestrator', risk: ctx.risk },
        wiring.routing,
      );
      const response = await agents.plan<PlanResponse>(
        decision.alias,
        [
          env.issueContract(ctx),
          '',
          '## Repository instructions',
          env.readIfPresent(env.treePath(ctx), 'AGENTS.md'),
          '',
          '## Validation commands available',
          ctx.run.baseSha
            ? (await readValidationCommandsAtBaseSha(env.treePath(ctx), ctx.run.baseSha))
                .map((c) => `- ${c.name}: ${c.command}${c.required ? ' (required)' : ''}`)
                .join('\n') || '- none declared'
            : '- none declared',
          '',
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
      repos.recordTasks(ctx.run.id, tasks);
      const runnable = tasks.filter((t) => (t.blocked_by ?? []).length === 0);
      if (runnable.length === 0 && tasks.length > 0) {
        throw new Error(`Every task in the plan declares a blocker; the dependency graph has no starting point.`);
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

    async dispatchNextWave(ctx) {
      const tasks = repos.runTasks(ctx.run.id);
      const done = new Set(tasks.filter((task) => task.state === 'DONE').map((task) => task.id));
      const ready = tasks.filter((task) => task.state === 'PENDING' && task.blocked_by.every((b) => done.has(b)));
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
      const tasks = repos.runTasks(ctx.run.id).filter((task) => task.state === 'DISPATCHED');
      const interrupted: string[] = [];
      for (const task of tasks) {
        if (!task.orcaWorktreeId) continue;
        const path = worktreePathFromId(task.orcaWorktreeId);
        const control = env.workerControlDir(ctx, task.id);
        const exitContents = env.readIfPresent(control, WORKER_EXIT_FILE) || null;
        const heartbeatPath = join(control, WORKER_HEARTBEAT_FILE);
        const attempt = repos.latestWorkerAttempt(ctx.run.id, task.id);
        const launchConfirmedMs = attempt?.startedAt ? Date.parse(attempt.startedAt) : null;
        const heartbeatModifiedMs = existsSync(heartbeatPath) ? statSync(heartbeatPath).mtimeMs : launchConfirmedMs;
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
      for (const task of tasks) {
        if (!task.orcaWorktreeId) return false;
        const attemptNo = repos.workerAttemptCount(ctx.run.id, task.id);
        const clean = await cleanFailedAttempt(
          wiring.gitRunner,
          worktreePathFromId(task.orcaWorktreeId),
          task.owns,
          join(env.workerControlDir(ctx, task.id), `attempt-${attemptNo}.failed.patch`),
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

    async dispatchRemediation(ctx, tasks) {
      const findings = tasks.filter(isRemediationTask);
      if (findings.length !== tasks.length) {
        throw new Error(`${ctx.run.issueId}: persisted remediation plan is malformed`);
      }
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
  };
}
