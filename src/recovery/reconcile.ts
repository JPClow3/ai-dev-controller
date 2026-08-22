import type { WorkflowState, CiTrigger } from '../domain/workflow.js';
import { isLegalTransition } from '../workflow/transitions.js';

/**
 * Observed reality for one run, gathered from the four external systems.
 *
 * The controller database is memory, not truth. On restart every non-terminal
 * run is re-derived from what actually exists, because a crash between "did
 * the thing" and "recorded the thing" is the normal case, not the exception.
 */
export interface ObservedRun {
  runId: string;
  issueId: string;
  dbState: WorkflowState;
  ciTrigger: CiTrigger;
  /** Durable result written before a branch push side effect. */
  localValidationPassed?: boolean;

  orca: {
    worktreeExists: boolean;
    /** Durable tasks and every first-wave worker worktree were recorded. */
    planningComplete?: boolean;
    /** At least one persisted task still needs launch, harvest or retry. */
    implementationPending?: boolean;
    agentRunning: boolean;
    agentSettled: boolean;
  } | null;
  git: {
    branchExists: boolean;
    hasCommitsBeyondBase: boolean;
    branchPushed: boolean;
    /** A harvested worker patch has not reached the parent branch yet. */
    integrationPending?: boolean;
  } | null;
  github: {
    pullRequestNumber: number | null;
    /** Present when a pull request exists and can be durably adopted. */
    url?: string;
    isDraft: boolean;
    headBranch?: string;
    baseBranch?: string;
    merged: boolean;
    checksComplete: boolean;
    requiredChecksPassed: boolean;
  } | null;
  linear: { label: string | null } | null;
}

export type ReconcileAction = 'advance' | 'resume' | 'relaunch' | 'block' | 'noop';

export interface ReconciliationReport {
  runId: string;
  issueId: string;
  dbState: WorkflowState;
  derivedState: WorkflowState;
  action: ReconcileAction;
  reason: string;
  /** Facts to pass to the transition guard, all independently observed. */
  facts: Record<string, boolean>;
}

/**
 * Derives where a run actually is.
 *
 * Ordered most-progressed first: a merged PR outranks passing checks, which
 * outrank an open PR, which outranks a pushed branch. Reading it the other way
 * round would re-do finished work.
 */
export function reconcileRun(observed: ObservedRun): ReconciliationReport {
  const base = { runId: observed.runId, issueId: observed.issueId, dbState: observed.dbState };

  // 1. Merged is terminal and unambiguous.
  if (observed.github?.merged) {
    return {
      ...base,
      derivedState: 'MERGED',
      action: observed.dbState === 'MERGED' ? 'noop' : 'advance',
      reason: 'GitHub reports the pull request is merged',
      facts: { mergedByHuman: true },
    };
  }

  // A human block is a gate, not a stale execution state. Only the explicit
  // operator resume path may reopen it; unattended observations must not.
  if (observed.dbState === 'BLOCKED_HUMAN') {
    return {
      ...base,
      derivedState: 'BLOCKED_HUMAN',
      action: 'noop',
      reason: 'waiting for explicit human resume',
      facts: {},
    };
  }

  // IMPLEMENTING owns worker harvesting. A PR may still carry green checks
  // for the previously pushed commit while a remediation worker is changing
  // the next one; those checks cannot prove the in-flight attempt. Keep the
  // run here until the ordinary step records the worker result and advances.
  if (
    observed.dbState === 'IMPLEMENTING'
    && observed.orca?.worktreeExists
    && (
      observed.orca.implementationPending === true
      || observed.orca.agentRunning
      || !observed.orca.agentSettled
    )
  ) {
    if (observed.orca.agentRunning) {
      return {
        ...base,
        derivedState: 'IMPLEMENTING',
        action: 'noop',
        reason: 'implementation worker is still running',
        facts: {},
      };
    }
    const interrupted = !observed.orca.agentSettled;
    return {
      ...base,
      derivedState: 'IMPLEMENTING',
      action: interrupted ? 'relaunch' : 'resume',
      reason: interrupted
        ? 'worktree exists but the worker stopped unexpectedly; harvest the interrupted attempt first'
        : 'worker settled; harvest its result before considering prior GitHub checks',
      facts: {},
    };
  }

  // A remediation commit can be harvested immediately before a crash. The PR
  // still reports green checks for its older head, so those checks cannot
  // advance INTEGRATING until every recorded worker patch is on the parent.
  if (observed.dbState === 'INTEGRATING' && observed.git?.integrationPending) {
    return {
      ...base,
      derivedState: 'INTEGRATING',
      action: 'resume',
      reason: 'a recorded worker commit is still pending integration',
      facts: {},
    };
  }

  // 2. CI has concluded on an existing PR.
  if (observed.github?.pullRequestNumber !== null && observed.github?.checksComplete) {
    if (observed.github.requiredChecksPassed) {
      const alreadyPast = pastCi(observed.dbState);
      return {
        ...base,
        derivedState: alreadyPast ? observed.dbState : 'FINAL_REVIEW',
        action: alreadyPast ? 'noop' : 'advance',
        reason: `PR #${observed.github.pullRequestNumber} exists and required checks passed`,
        facts: {
          requiredCiPassed: true,
          pullRequestExists: true,
          branchPushed: true,
          localValidationPassed: observed.localValidationPassed === true,
        },
      };
    }
    return {
      ...base,
      derivedState: 'REMEDIATING',
      action: 'resume',
      reason: `PR #${observed.github.pullRequestNumber} has failing required checks`,
      facts: {
        requiredCiFailed: true,
        pullRequestExists: true,
        branchPushed: true,
        localValidationPassed: observed.localValidationPassed === true,
      },
    };
  }

  // 3. A PR exists but checks are still running.
  if (observed.github?.pullRequestNumber !== null && observed.github) {
    return {
      ...base,
      derivedState: 'CI',
      action: observed.dbState === 'CI' ? 'noop' : 'advance',
      reason: `PR #${observed.github.pullRequestNumber} is open, checks still running`,
      facts: {
        pullRequestExists: true,
        branchPushed: true,
        localValidationPassed: observed.localValidationPassed === true,
      },
    };
  }

  // 4. Work exists on a pushed branch, but no PR yet.
  if (observed.git?.branchPushed && observed.git.hasCommitsBeyondBase) {
    const next: WorkflowState = observed.ciTrigger === 'pull_request'
      ? 'PR_DRAFT_OPEN'
      : observed.ciTrigger === 'branch_push'
        ? 'CI'
        : 'FINAL_REVIEW';
    return {
      ...base,
      derivedState: next,
      action: 'advance',
      reason: `branch is pushed with commits; CI trigger is "${observed.ciTrigger}"`,
      facts: {
        branchPushed: true,
        localValidationPassed: observed.localValidationPassed === true,
      },
    };
  }

  // The parent worktree is created before QUEUED -> PLANNING, so its mere
  // presence is normal planning state, not evidence that a worker died. Only
  // persisted tasks with every first-wave worktree attached prove the three
  // guarded preconditions for entering IMPLEMENTING after a crash.
  if (observed.dbState === 'PLANNING' && observed.orca?.worktreeExists) {
    if (observed.orca.planningComplete) {
      return {
        ...base,
        derivedState: 'IMPLEMENTING',
        action: 'advance',
        reason: 'persisted tasks and first-wave worker worktrees prove planning completed',
        facts: {
          planValidated: true,
          ownershipSetsDisjoint: true,
          worktreesCreated: true,
        },
      };
    }
    return {
      ...base,
      derivedState: 'PLANNING',
      action: 'noop',
      reason: 'parent worktree exists but worker planning is not durably complete',
      facts: {},
    };
  }

  // 5. A worker died mid-implementation. Its worktree survives. Other
  // states also keep the parent worktree, but their persisted state owns the
  // next action (for example REMEDIATING must consume its recorded plan).
  if (
    observed.dbState === 'IMPLEMENTING'
    && observed.orca?.worktreeExists
    && !observed.orca.agentRunning
  ) {
    const interrupted = !observed.orca.agentSettled;
    return {
      ...base,
      derivedState: 'IMPLEMENTING',
      action: interrupted ? 'relaunch' : 'resume',
      reason: interrupted
        ? 'worktree exists but the agent terminal stopped unexpectedly; treat as an interrupted attempt'
        : 'worktree exists and the agent finished; resume integration',
      facts: {},
    };
  }

  // 6. Agent still running: leave it alone.
  if (observed.orca?.agentRunning) {
    return {
      ...base,
      derivedState: observed.dbState,
      action: 'noop',
      reason: 'agent is still running',
      facts: {},
    };
  }

  // 7. Nothing external exists. Anything past QUEUED is unexplained — but
  // only when all three execution systems were actually observed. `null`
  // means unavailable/unknown, not absent. Treating an Orca or GitHub outage
  // as proof of absence would block healthy work during the very startup path
  // that is meant to recover it.
  const executionRealityKnown = observed.orca !== null && observed.git !== null && observed.github !== null;
  const noExecutionArtifacts = executionRealityKnown
    && observed.orca!.worktreeExists === false
    && observed.git!.branchExists === false
    && observed.github!.pullRequestNumber === null;
  if (noExecutionArtifacts && observed.dbState !== 'QUEUED' && observed.dbState !== 'DISCOVERED') {
    return {
      ...base,
      derivedState: 'BLOCKED_HUMAN',
      action: 'block',
      reason: `database says ${observed.dbState} but no worktree, branch or pull request exists`,
      facts: {},
    };
  }

  return {
    ...base,
    derivedState: observed.dbState,
    action: 'noop',
    reason: executionRealityKnown ? 'nothing started yet' : 'external reality could not be fully observed',
    facts: {},
  };
}

/** States at or beyond CI completion. */
function pastCi(state: WorkflowState): boolean {
  return (['FINAL_REVIEW', 'PR_READY', 'PR_OPEN', 'MERGED', 'REMEDIATING'] as WorkflowState[]).includes(state);
}

/**
 * Only reconciliations the state machine actually permits are applied.
 *
 * Recovery is not a licence to bypass the guard — an illegal derived state is
 * reported and left for a human rather than forced.
 */
export function applicable(report: ReconciliationReport): boolean {
  if (report.action === 'noop') return false;
  if (report.derivedState === report.dbState) return false;
  return isLegalTransition(report.dbState, report.derivedState);
}

export function reconcileAll(runs: ObservedRun[]): ReconciliationReport[] {
  return runs.map(reconcileRun);
}
