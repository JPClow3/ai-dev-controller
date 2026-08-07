import type { RunState, LinearLabel } from '../types/index.js';
import { IllegalTransitionError, NotImplementedError } from '../util/errors.js';

/**
 * The controller's state machine.
 *
 * A model may return `{ recommended_state, reason }`. It may never write state.
 * `transition()` checks the edge is legal AND that the preconditions actually
 * hold in the database before recording anything.
 */
export const LEGAL_EDGES: Readonly<Record<RunState, readonly RunState[]>> = {
  DISCOVERED: ['CURATING', 'CANCELLED'],
  CURATING: ['WAITING_READY', 'NEEDS_CONTEXT', 'FAILED'],
  WAITING_READY: ['QUEUED', 'NEEDS_CONTEXT', 'CANCELLED'],
  QUEUED: ['DEPENDENCY_BLOCKED', 'PLANNING', 'CANCELLED'],
  DEPENDENCY_BLOCKED: ['QUEUED', 'CANCELLED'],
  PLANNING: ['IMPLEMENTING', 'BLOCKED_HUMAN', 'FAILED'],
  IMPLEMENTING: ['INTEGRATING', 'REMEDIATING', 'BLOCKED_HUMAN', 'FAILED'],
  INTEGRATING: ['LOCAL_VALIDATION', 'REMEDIATING', 'BLOCKED_HUMAN'],
  LOCAL_VALIDATION: ['CI', 'REMEDIATING'],
  CI: ['FINAL_REVIEW', 'REMEDIATING'],
  FINAL_REVIEW: ['PR_READY', 'REMEDIATING', 'BLOCKED_HUMAN'],
  REMEDIATING: ['IMPLEMENTING', 'INTEGRATING', 'LOCAL_VALIDATION', 'CI', 'FINAL_REVIEW', 'BLOCKED_HUMAN'],
  PR_READY: ['PR_OPEN', 'FAILED'],
  PR_OPEN: ['MERGED', 'REMEDIATING', 'CANCELLED'],
  MERGED: [],
  NEEDS_CONTEXT: ['CURATING', 'WAITING_READY', 'CANCELLED'],
  BLOCKED_HUMAN: ['QUEUED', 'PLANNING', 'IMPLEMENTING', 'REMEDIATING', 'CANCELLED'],
  FAILED: ['QUEUED', 'CANCELLED'],
  CANCELLED: [],
};

/** Linear sees a simplified view. Internal precision stays internal. */
export const LINEAR_PROJECTION: Readonly<Partial<Record<RunState, LinearLabel>>> = {
  DISCOVERED: 'ai-curate',
  CURATING: 'ai-curate',
  NEEDS_CONTEXT: 'ai-needs-context',
  WAITING_READY: 'ai-needs-context',
  QUEUED: 'ai-running',
  DEPENDENCY_BLOCKED: 'ai-blocked',
  PLANNING: 'ai-running',
  IMPLEMENTING: 'ai-running',
  INTEGRATING: 'ai-running',
  LOCAL_VALIDATION: 'ai-running',
  CI: 'ai-reviewing',
  FINAL_REVIEW: 'ai-reviewing',
  REMEDIATING: 'ai-running',
  PR_READY: 'ai-reviewing',
  PR_OPEN: 'ai-pr-open',
  BLOCKED_HUMAN: 'ai-blocked',
  FAILED: 'ai-blocked',
};

export function isLegalEdge(from: RunState, to: RunState): boolean {
  return (LEGAL_EDGES[from] as readonly RunState[]).includes(to);
}

export interface TransitionRequest {
  runId: string;
  from: RunState;
  to: RunState;
  /** Which model suggested this, if any. Recorded for audit; never trusted. */
  recommendedBy?: string;
  reason?: string;
}

/**
 * Preconditions that must hold in the DB before each target state is entered.
 * Implementations live in `preconditions.ts`; keep them boolean and cheap.
 */
export const REQUIRED_PRECONDITIONS: Readonly<Partial<Record<RunState, readonly string[]>>> = {
  PLANNING: ['dependencies_merged', 'capacity_available', 'fresh_base_fetched'],
  IMPLEMENTING: ['plan_validated', 'ownership_sets_disjoint', 'worktrees_created'],
  INTEGRATING: ['all_tasks_terminal'],
  LOCAL_VALIDATION: ['integration_commit_present'],
  CI: ['branch_pushed'],
  FINAL_REVIEW: ['required_ci_passed'],
  PR_READY: ['required_ci_passed', 'no_blocking_findings', 'retry_budget_remaining'],
  PR_OPEN: ['pr_created_as_draft'],
  MERGED: ['pr_merged_by_human'],
};

/** TODO(v1): verify preconditions, write state_transitions, update runs+issues. */
export function transition(_req: TransitionRequest): void {
  throw new NotImplementedError('state.transition');
}

export function assertLegal(from: RunState, to: RunState): void {
  if (!isLegalEdge(from, to)) {
    throw new IllegalTransitionError(from, to, 'edge not present in LEGAL_EDGES');
  }
}
