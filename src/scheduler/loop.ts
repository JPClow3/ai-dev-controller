import { NotImplementedError } from '../util/errors.js';

/**
 * The polling loop. Local-first, so no webhook endpoint and no cloud server.
 * Interval is config/global.yaml -> scheduler.poll_interval_seconds (45s default).
 * There is no advantage to polling Linear every second.
 *
 * Each tick, in order:
 *   1. synchronise Linear state
 *   2. synchronise GitHub PR state
 *   3. reconcile active runs
 *   4. detect newly ai-ready issues
 *   5. recompute the dependency DAG
 *   6. calculate available capacity
 *   7. resume remediation / review work FIRST
 *   8. launch eligible new tasks
 *   9. update metrics
 */

/** Lower number wins. Mirrors scheduler.priorities in config/global.yaml. */
export const PRIORITY = {
  HUMAN_UNBLOCKED: 0,
  FINAL_REVIEW_PR: 1,
  CI_REMEDIATION: 2,
  INTEGRATION: 3,
  ACTIVE_ISSUE_WORKER: 4,
  NEW_READY_ISSUE: 5,
  CHALLENGER_EXPERIMENT: 6,
  MAINTENANCE: 7,
} as const;

export interface QueueItem {
  priority: number;
  issueId: string;
  taskKey?: string;
  kind: 'curate' | 'plan' | 'implement' | 'integrate' | 'validate' | 'review' | 'pr' | 'remediate';
}

export async function tick(): Promise<void> {
  throw new NotImplementedError('loop.tick');
}

export function buildQueue(): QueueItem[] {
  throw new NotImplementedError('loop.buildQueue');
}

export async function run(_opts?: { once?: boolean }): Promise<void> {
  throw new NotImplementedError('loop.run');
}
