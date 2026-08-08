import type { ControllerConfig } from '../config/load-config.js';
import type { ControllerRepositories } from '../state/repositories.js';
import { computeReadyWave, detectDependencyCycles, type SchedulableIssue } from '../scheduler/dag.js';
import { availableCapacity, shouldThrottleNewWork, type CapacityState } from '../scheduler/capacity.js';
import { rankWork, filterUnderThrottle, type WorkItem } from '../scheduler/priority.js';
import { resolveRepository } from '../projects/resolver.js';
import { logger } from '../util/log.js';

const log = logger('runner');

export interface TickReport {
  startedAt: string;
  durationMs: number;
  reconciled: number;
  readyIssues: string[];
  blockedIssues: Array<{ identifier: string; waitingOn: string[] }>;
  cycles: string[][];
  dispatched: WorkItem[];
  skipped: Array<{ item: WorkItem; why: string }>;
  throttled: boolean;
  needsContext: string[];
}

/**
 * Everything the loop touches, injected so a tick is testable without Linear,
 * GitHub or Orca being reachable.
 */
export interface RunnerDeps {
  config: ControllerConfig;
  repos: ControllerRepositories;

  reconcile: () => Promise<number>;
  /** Issues carrying `ai-ready`, plus their explicit blockers. */
  fetchReadyIssues: () => Promise<
    Array<{
      identifier: string;
      title?: string;
      projectName: string | null;
      description: string;
      labels: string[];
      blockedBy: string[];
    }>
  >;
  /** Merged PRs, which is the only thing that satisfies a dependency. */
  syncMergedPullRequests: () => Promise<string[]>;
  /** Work already in flight, from controller state. */
  pendingWork: () => Promise<WorkItem[]>;
  capacityState: () => Promise<CapacityState>;
  remediationBacklog: () => Promise<number>;
  providerPressures: () => Promise<Array<'LOW' | 'NORMAL' | 'HIGH' | 'EXHAUSTED'>>;
  dispatch: (item: WorkItem) => Promise<void>;
  markNeedsContext: (identifier: string, message: string) => Promise<void>;
  flagCycle: (identifiers: string[]) => Promise<void>;
}

/**
 * One scheduler tick.
 *
 * Order matters and is not arbitrary:
 *   1. reconcile   — the DB is memory, not truth; re-derive reality first
 *   2. merges      — a merge is the only thing that unblocks downstream work
 *   3. ai-ready    — the human gate, read but never written
 *   4. waves       — recomputed from real merge state every tick
 *   5. capacity    — hard limits
 *   6. priority    — finish things before starting things
 *   7. dispatch
 */
export async function runSchedulerTick(deps: RunnerDeps): Promise<TickReport> {
  const started = Date.now();
  const startedAt = new Date().toISOString();

  const reconciled = await deps.reconcile();

  // A merged PR satisfies blockers. Nothing else does.
  const merged = await deps.syncMergedPullRequests();
  for (const issueId of merged) deps.repos.markDependencySatisfiedByMerge(issueId);

  const ready = await deps.fetchReadyIssues();
  const needsContext: string[] = [];
  const resolvedProjects = new Map<string, string>();

  const schedulable: SchedulableIssue[] = [];
  for (const issue of ready) {
    const resolution = resolveRepository(
      { projectName: issue.projectName, description: issue.description, labels: issue.labels },
      deps.config.registry,
    );
    if (!resolution.ok) {
      // Refusing is a first-class outcome. Guessing sends agents at the wrong
      // codebase, which is far more expensive than asking.
      needsContext.push(issue.identifier);
      await deps.markNeedsContext(issue.identifier, resolution.message);
      continue;
    }
    // Mirror the registry into the database first: `issues.project_id` and
    // `runs.issue_id` are foreign keys with `foreign_keys` ON, so inserting an
    // issue for a project row that does not exist fails with a constraint
    // error rather than a clean refusal.
    const entry = deps.config.registry.projects[resolution.projectId];
    if (entry) {
      deps.repos.upsertProject({
        id: resolution.projectId,
        enabled: entry.enabled,
        repoPath: entry.repository.path,
        githubSlug: entry.repository.github,
        baseBranch: entry.repository.baseBranch,
        linearProject: entry.linear.project ?? null,
        knowledgeStatus: entry.knowledgeStatus,
        maxAgents: entry.maxAgents ?? deps.config.global.concurrency.agentsPerRepository,
        routingProfile: entry.routingProfile,
      });
    }
    deps.repos.upsertIssue({
      id: issue.identifier,
      projectId: resolution.projectId,
      title: issue.title ?? null,
      body: issue.description,
    });
    deps.repos.setDependencies(issue.identifier, issue.blockedBy);
    resolvedProjects.set(issue.identifier, resolution.projectId);
    schedulable.push({
      identifier: issue.identifier,
      blockedBy: issue.blockedBy,
      merged: false,
      ready: true,
    });
  }

  // Include merged issues so blockers can be satisfied by them.
  for (const issueId of merged) {
    if (!schedulable.some((s) => s.identifier === issueId)) {
      schedulable.push({ identifier: issueId, blockedBy: [], merged: true, ready: false });
    }
  }

  const cycles = detectDependencyCycles(schedulable);
  for (const cycle of cycles) await deps.flagCycle(cycle);

  const wave = computeReadyWave(schedulable);

  const throttleDecision = shouldThrottleNewWork({
    remediationBacklog: await deps.remediationBacklog(),
    remediationBacklogThreshold: 4,
    providerPressures: await deps.providerPressures(),
  });

  const queue = rankWork([
    ...(await deps.pendingWork()),
    ...wave.issues.map<WorkItem>((identifier) => ({
      kind: 'NEW_READY_ISSUE',
      issueId: identifier,
      ...(resolvedProjects.has(identifier) ? { projectId: resolvedProjects.get(identifier)! } : {}),
      enqueuedAt: startedAt,
    })),
  ]);

  const eligible = filterUnderThrottle(queue, throttleDecision.throttle);

  const dispatched: WorkItem[] = [];
  const skipped: Array<{ item: WorkItem; why: string }> = [];
  const capacity = await deps.capacityState();

  for (const item of eligible) {
    const startsNewIssue = item.kind === 'NEW_READY_ISSUE';
    const projectId = projectFor(item, deps);

    // No provider yet: routing happens at dispatch. Only the provider-agnostic
    // limits (issues, agents, per-issue, per-repository) apply here.
    const decision = availableCapacity(capacity, deps.config.global.concurrency, {
      issueId: item.issueId,
      repositoryId: projectId,
      startsNewIssue,
    });

    if (!decision.allowed) {
      skipped.push({ item, why: `capacity limit: ${decision.limit}` });
      continue;
    }

    await deps.dispatch(item);
    dispatched.push(item);

    // Reflect the dispatch locally so later items in this same tick see it.
    capacity.agents.push({
      issueId: item.issueId,
      repositoryId: projectId,
      aliasId: 'pending',
      provider: 'ollama',
      heavy: false,
      luna: false,
    });
    if (startsNewIssue && !capacity.activeIssues.includes(item.issueId)) {
      capacity.activeIssues.push(item.issueId);
    }
  }

  return {
    startedAt,
    durationMs: Date.now() - started,
    reconciled,
    readyIssues: wave.issues,
    blockedIssues: wave.blocked,
    cycles,
    dispatched,
    skipped,
    throttled: throttleDecision.throttle,
    needsContext,
  };
}

function projectFor(item: WorkItem, deps: RunnerDeps): string {
  // Prefer the resolution carried on the item: a new issue has no run, and
  // falling back to a literal 'unknown' would count every new issue's
  // per-repository limit against one fictional repository.
  return item.projectId ?? deps.repos.getActiveRun(item.issueId)?.repositoryId ?? 'unresolved';
}

export interface LoopOptions {
  once?: boolean;
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * The polling loop.
 *
 * A single in-process mutex, because a slow tick must never overlap the next
 * one: two concurrent ticks would both see "no active run" and race to claim
 * the same issue. The database index would catch it, but a clean skip is
 * better than a caught collision.
 */
export async function runLoop(deps: RunnerDeps, options: LoopOptions = {}): Promise<TickReport[]> {
  const intervalMs = options.intervalMs ?? deps.config.global.pollIntervalSeconds * 1000;
  const reports: TickReport[] = [];
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      log.warn('previous tick still running; skipping this interval');
      return;
    }
    running = true;
    try {
      const report = await runSchedulerTick(deps);
      reports.push(report);
      log.info(
        `tick: ${report.dispatched.length} dispatched, ${report.readyIssues.length} ready, ` +
          `${report.blockedIssues.length} blocked${report.throttled ? ', THROTTLED' : ''}`,
      );
    } catch (err) {
      log.error('tick failed', err);
    } finally {
      running = false;
    }
  };

  await tick();
  if (options.once) return reports;

  return new Promise((resolve) => {
    const timer = setInterval(() => void tick(), intervalMs);
    const stop = () => {
      clearInterval(timer);
      resolve(reports);
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    process.once('SIGINT', stop);
  });
}
