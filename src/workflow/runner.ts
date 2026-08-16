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
  adopted: number;
  curated: number;
  readyIssues: string[];
  blockedIssues: Array<{ identifier: string; waitingOn: string[] }>;
  cycles: string[][];
  dispatched: WorkItem[];
  skipped: Array<{ item: WorkItem; why: string }>;
  throttled: boolean;
  curationBlocked: string[];
}

/**
 * Everything the loop touches, injected so a tick is testable without Linear,
 * GitHub or Orca being reachable.
 */
export interface RunnerDeps {
  config: ControllerConfig;
  repos: ControllerRepositories;

  reconcile: () => Promise<number>;
  /** Newly-created unlabeled issues adopted into `ai-curate`. */
  adoptNewIssues: () => Promise<number>;
  /** Rough `ai-curate` issues processed before implementation scheduling. */
  curateIssues: () => Promise<number>;
  /** Issues carrying `ai-ready`, plus their explicit blockers. */
  fetchReadyIssues: () => Promise<
    Array<{
      identifier: string;
      title?: string;
      projectName: string | null;
      description: string;
      labels: string[];
      blockedBy: string[];
      url?: string;
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
  markCurationBlocked: (identifier: string, message: string) => Promise<void>;
  flagCycle: (identifiers: string[]) => Promise<void>;
}

/**
 * One scheduler tick.
 *
 * Order matters and is not arbitrary:
 *   1. reconcile   — the DB is memory, not truth; re-derive reality first
 *   2. merges      — a merge is the only thing that unblocks downstream work
 *   3. adoption    — new unlabeled issues enter ai-curate
 *   4. curation    — improve rough issues and promote them to ai-ready
 *   5. ai-ready    — autonomous implementation queue
 *   6. waves       — recomputed from real merge state every tick
 *   7. capacity    — hard limits
 *   8. priority    — finish things before starting things
 *   9. dispatch
 */
export async function runSchedulerTick(deps: RunnerDeps): Promise<TickReport> {
  const started = Date.now();
  const startedAt = new Date().toISOString();

  const reconciled = await deps.reconcile();

  // A merged PR satisfies blockers. Nothing else does.
  const merged = await deps.syncMergedPullRequests();
  for (const issueId of merged) deps.repos.markDependencySatisfiedByMerge(issueId);

  const adopted = await deps.adoptNewIssues();
  const curated = await deps.curateIssues();

  const ready = await deps.fetchReadyIssues();
  const curationBlocked: string[] = [];
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
      curationBlocked.push(issue.identifier);
      await deps.markCurationBlocked(issue.identifier, resolution.message);
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
    // Criteria are parsed here, deterministically, rather than left for the
    // curator. Nothing was populating them: the review packet arrived with an
    // empty criteria list and the PR body rendered an empty checklist, so the
    // one thing a reviewer is meant to check against was never present.
    deps.repos.upsertIssue({
      id: issue.identifier,
      projectId: resolution.projectId,
      title: issue.title ?? null,
      body: issue.description,
      acceptanceCriteria: parseAcceptanceCriteria(issue.description ?? ''),
      url: issue.url ?? null,
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
      provider: 'chatgpt',
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
    adopted,
    curated,
    readyIssues: wave.issues,
    blockedIssues: wave.blocked,
    cycles,
    dispatched,
    skipped,
    throttled: throttleDecision.throttle,
    curationBlocked,
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

  if (options.signal?.aborted) return reports;

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
        `tick: ${report.adopted} adopted, ${report.curated} curated, ${report.dispatched.length} dispatched, ` +
          `${report.readyIssues.length} ready, ` +
          `${report.blockedIssues.length} blocked${report.throttled ? ', THROTTLED' : ''}`,
      );
    } catch (err) {
      log.error('tick failed', err);
    } finally {
      running = false;
    }
  };

  await tick();
  if (options.once || options.signal?.aborted) return reports;

  return new Promise((resolve) => {
    const timer = setInterval(() => void tick(), intervalMs);
    const stop = () => {
      clearInterval(timer);
      options.signal?.removeEventListener('abort', stop);
      process.removeListener('SIGINT', stop);
      resolve(reports);
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    process.once('SIGINT', stop);
  });
}

/**
 * Acceptance criteria, read from the issue body.
 *
 * The convention the curator prompt already produces and the pilot issues
 * already use: a line whose first token is an `AC-<n>` label. Deliberately
 * deterministic — criteria are the yardstick the reviewer is graded against,
 * so they must not be re-invented by a model on every read.
 */
export function parseAcceptanceCriteria(body: string): Array<{ id: string; statement: string }> {
  const found: Array<{ id: string; statement: string }> = [];
  const seen = new Set<string>();

  for (const line of body.split(/\r?\n/)) {
    // Tolerates "- [ ] AC-1: ...", "* AC-2 — ...", "AC-3. ..."
    const match = /^\s*(?:[-*]\s*)?(?:\[[ xX]?\]\s*)?(AC-\d+)\s*[:.—-]?\s*(.+)$/.exec(line);
    const id = match?.[1];
    const statement = match?.[2]?.trim();
    if (!id || !statement || seen.has(id)) continue;
    seen.add(id);
    found.push({ id, statement });
  }
  return found;
}
