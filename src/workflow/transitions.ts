import {
  MAINLINE_TRANSITIONS,
  EXCEPTIONAL_STATES,
  isTerminal,
  nextAfterLocalValidation,
  type CiTrigger,
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
  /** Repository CI mode. Required to leave LOCAL_VALIDATION. */
  ciTrigger?: CiTrigger;
}

/**
 * Authoritative recovery may skip stale internal states, but only when a
 * stronger external fact proves the skipped outcome. This is intentionally
 * much narrower than the ordinary state machine.
 */
export function canRecoverAuthoritatively(
  from: WorkflowState,
  to: WorkflowState,
  facts: Record<string, boolean>,
): boolean {
  if (from === to || isTerminal(from)) return false;
  // A human merge is terminal external truth, even if the controller was
  // previously waiting on that same human for another reason.
  if (to === 'MERGED') return facts['mergedByHuman'] === true;
  if (from === 'BLOCKED_HUMAN') return false;
  // Passing checks on the run's own PR prove the pushed artifact reached the
  // final-review boundary even when SQLite missed earlier writes.
  if (to === 'FINAL_REVIEW') {
    const validationPassed = facts['localValidationPassed'] === true;
    const ciPassed = facts['requiredCiPassed'] === true && facts['pullRequestExists'] === true;
    return validationPassed && (ciPassed || facts['branchPushed'] === true);
  }
  if (to === 'REMEDIATING') {
    return facts['localValidationPassed'] === true
      && facts['requiredCiFailed'] === true
      && facts['pullRequestExists'] === true;
  }
  if (to === 'PR_DRAFT_OPEN' || to === 'CI') {
    return facts['branchPushed'] === true && facts['localValidationPassed'] === true;
  }
  return false;
}

/**
 * Mechanical preconditions, independently verified before entry.
 *
 * `PR_READY` demands `requiredCiPassed` — which is why the CI trigger mode
 * matters so much. On a `pull_request` repository, CI cannot produce that fact
 * until a PR exists, so the draft PR has to open first.
 */
export const REQUIRED_FACTS: Readonly<Partial<Record<WorkflowState, readonly string[]>>> = {
  PLANNING: ['dependenciesMerged', 'capacityAvailable', 'freshBaseFetched'],
  IMPLEMENTING: ['planValidated', 'ownershipSetsDisjoint', 'worktreesCreated'],
  INTEGRATING: ['allTasksTerminal'],
  LOCAL_VALIDATION: ['integrationCommitPresent'],
  PR_DRAFT_OPEN: ['branchPushed'],
  CI: ['branchPushed'],
  FINAL_REVIEW: ['requiredCiPassed'],
  PR_READY: ['requiredCiPassed', 'noBlockingFindings', 'retryBudgetRemaining'],
  PR_OPEN: ['pullRequestIsDraft', 'provenanceBodyWritten'],
  MERGED: ['mergedByHuman'],
};

/**
 * Facts that only apply under a particular CI mode, layered on top.
 *
 * On a `pull_request` repository the CI run is attached to a pull request, so
 * entering CI requires that the PR actually exists.
 */
const CI_MODE_FACTS: Readonly<Record<CiTrigger, Partial<Record<WorkflowState, readonly string[]>>>> = {
  pull_request: { CI: ['pullRequestExists'] },
  branch_push: {},
  // With no CI, `requiredCiPassed` is satisfied by local validation instead.
  none: { FINAL_REVIEW: ['localValidationPassed'], PR_READY: ['localValidationPassed'] },
};

export function isLegalTransition(from: WorkflowState, to: WorkflowState): boolean {
  if (from === to) return false;
  if (isTerminal(from)) {
    return (MAINLINE_TRANSITIONS[from] as readonly WorkflowState[]).includes(to);
  }
  if ((EXCEPTIONAL_STATES as readonly WorkflowState[]).includes(to)) return true;
  return (MAINLINE_TRANSITIONS[from] as readonly WorkflowState[]).includes(to);
}

function requiredFactsFor(to: WorkflowState, trigger: CiTrigger | undefined): readonly string[] {
  const base = REQUIRED_FACTS[to] ?? [];
  if (!trigger) return base;
  const extra = CI_MODE_FACTS[trigger][to] ?? [];
  // With trigger `none` there is no CI, so `requiredCiPassed` is unobtainable
  // and is replaced by the local-validation fact rather than waived silently.
  const withoutCi = trigger === 'none' ? base.filter((f) => f !== 'requiredCiPassed') : base;
  return [...withoutCi, ...extra];
}

/**
 * Gate for every state change.
 *
 * Three independent checks, all of which must pass:
 *   1. the edge exists in the state machine
 *   2. leaving LOCAL_VALIDATION goes where this repository's CI mode allows
 *   3. the mechanical preconditions for the target state are proven true
 *
 * A model recommending `FINAL_REVIEW` because it believes the build is fine
 * fails check 3 unless a real CI conclusion says so.
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

  // The CI-mode rule governs FORWARD progress only. Remediation is a failure
  // path and must stay reachable from local validation regardless of how this
  // repository triggers CI.
  if (from === 'LOCAL_VALIDATION' && to !== 'REMEDIATING') {
    if (!evidence.ciTrigger) {
      throw new InvalidTransitionError(from, to, 'leaving LOCAL_VALIDATION requires the repository ciTrigger');
    }
    const expected = nextAfterLocalValidation(evidence.ciTrigger);
    if (to !== expected) {
      throw new InvalidTransitionError(
        from,
        to,
        `repository CI trigger is "${evidence.ciTrigger}", so the next state must be ${expected}`,
      );
    }
  }

  const required = requiredFactsFor(to, evidence.ciTrigger);
  if (required.length === 0) return;

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
