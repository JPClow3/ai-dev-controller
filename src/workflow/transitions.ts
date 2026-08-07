import {
  MAINLINE_TRANSITIONS,
  EXCEPTIONAL_STATES,
  isTerminal,
  type WorkflowState,
} from './states.js';

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: WorkflowState,
    readonly to: WorkflowState,
    readonly reason: string,
  ) {
    super(`Invalid transition ${from} -> ${to}: ${reason}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Why a transition is happening.
 *
 * `recommendedBy` records which model *suggested* the move. It is written to
 * the audit trail and never trusted: a model can say "CI passed", but only a
 * GitHub check conclusion in `mechanicalFacts` can prove it.
 */
export interface TransitionEvidence {
  reason: string;
  recommendedBy?: string;
  mechanicalFacts?: Record<string, unknown>;
}

/** Mechanical preconditions that must be independently verified before entry. */
export const REQUIRED_FACTS: Readonly<Partial<Record<WorkflowState, readonly string[]>>> = {
  PLANNING: ['dependenciesMerged', 'capacityAvailable', 'freshBaseFetched'],
  IMPLEMENTING: ['planValidated', 'ownershipSetsDisjoint', 'worktreesCreated'],
  INTEGRATING: ['allTasksTerminal'],
  LOCAL_VALIDATION: ['integrationCommitPresent'],
  CI: ['branchPushed'],
  FINAL_REVIEW: ['requiredCiPassed'],
  PR_READY: ['requiredCiPassed', 'noBlockingFindings', 'retryBudgetRemaining'],
  PR_OPEN: ['pullRequestIsDraft'],
  MERGED: ['mergedByHuman'],
};

export function isLegalTransition(from: WorkflowState, to: WorkflowState): boolean {
  if (from === to) return false;
  if (isTerminal(from)) {
    // Only FAILED offers a way back, and states.ts encodes that.
    return (MAINLINE_TRANSITIONS[from] as readonly WorkflowState[]).includes(to);
  }
  if ((EXCEPTIONAL_STATES as readonly WorkflowState[]).includes(to)) return true;
  return (MAINLINE_TRANSITIONS[from] as readonly WorkflowState[]).includes(to);
}

/**
 * Gate for every state change.
 *
 * Two independent checks, and both must pass:
 *   1. the edge exists in the state machine
 *   2. the mechanical preconditions for the target state are proven true
 *
 * A model recommending `FINAL_REVIEW` because it believes the build is fine
 * fails check 2 unless a real CI conclusion says so.
 */
export function assertTransitionAllowed(
  from: WorkflowState,
  to: WorkflowState,
  evidence: TransitionEvidence,
): void {
  if (!isLegalTransition(from, to)) {
    throw new InvalidTransitionError(from, to, 'edge not present in the state machine');
  }

  if ((EXCEPTIONAL_STATES as readonly WorkflowState[]).includes(to)) {
    if (!evidence.reason || evidence.reason.trim().length === 0) {
      throw new InvalidTransitionError(from, to, 'exceptional states require a machine-readable reason');
    }
    return;
  }

  const required = REQUIRED_FACTS[to];
  if (!required) return;

  const facts = evidence.mechanicalFacts ?? {};
  const missing = required.filter((key) => facts[key] !== true);
  if (missing.length > 0) {
    throw new InvalidTransitionError(
      from,
      to,
      `unproven mechanical preconditions: ${missing.join(', ')}`,
    );
  }
}
