import { NotImplementedError } from '../util/errors.js';

/**
 * Crash recovery. Runs once at startup, before the scheduler loop.
 *
 * The database is the controller's memory, but it is not the truth. On restart
 * we re-derive reality from the four external systems and reconcile:
 *
 *   controller DB  ->  Orca  ->  git  ->  GitHub  ->  Linear  ->  reconcile
 *
 * Examples the reconciler must handle:
 *
 *   DB says CI, GitHub says PR #192 exists and checks passed
 *     -> advance to FINAL_REVIEW
 *
 *   DB says IMPLEMENTING, Orca worktree exists, agent terminal died
 *     -> classify the interrupted attempt, resume per retry policy
 *
 *   DB says PR_OPEN, GitHub says merged
 *     -> MERGED, then re-evaluate the dependency wave
 */
export interface ReconciliationReport {
  runId: string;
  issueId: string;
  dbState: string;
  derivedState: string;
  action: 'advance' | 'resume' | 'relaunch' | 'block' | 'noop';
  reason: string;
}

export async function recoverAll(): Promise<ReconciliationReport[]> {
  throw new NotImplementedError('recovery.recoverAll');
}

export async function reconcileRun(_runId: string): Promise<ReconciliationReport> {
  throw new NotImplementedError('recovery.reconcileRun');
}
