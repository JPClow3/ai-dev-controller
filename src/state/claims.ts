import { NotImplementedError } from '../util/errors.js';
import type { RunRecord } from '../types/index.js';

/**
 * Idempotency. The single most important reason this controller exists.
 *
 * Restarting the controller, or Orca, must never produce:
 *   LIN-123, LIN-123-copy, LIN-123-2, please-god-final-LIN-123
 */

/**
 * Atomically claim a run for an issue, or return null if one is already active.
 * Relies on the partial unique index `idx_runs_one_active`.
 */
export function claimRun(_issueId: string): RunRecord | null {
  throw new NotImplementedError('claims.claimRun');
}

/**
 * Before creating a worktree, all four must be checked - the DB is not the
 * only place state can already exist:
 *   1. does the controller already record a worktree?
 *   2. does Orca report one for this issue?
 *   3. does git already have the branch (local or remote)?
 *   4. does GitHub already have an open PR for that branch?
 */
export function findExistingWorkspace(_issueId: string): Promise<{
  controllerWorktree: string | null;
  orcaWorktree: string | null;
  gitBranch: string | null;
  openPr: number | null;
}> {
  throw new NotImplementedError('claims.findExistingWorkspace');
}

export function releaseRun(_runId: string, _outcome: string): void {
  throw new NotImplementedError('claims.releaseRun');
}
