import type { WorkflowState, CiTrigger } from '../workflow/states.js';
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

  orca: { worktreeExists: boolean; agentRunning: boolean; agentSettled: boolean } | null;
  git: { branchExists: boolean; hasCommitsBeyondBase: boolean; branchPushed: boolean } | null;
  github: {
    pullRequestNumber: number | null;
    isDraft: boolean;
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

  // 2. CI has concluded on an existing PR.
  if (observed.github?.pullRequestNumber !== null && observed.github?.checksComplete) {
    if (observed.github.requiredChecksPassed) {
      const alreadyPast = pastCi(observed.dbState);
      return {
        ...base,
        derivedState: alreadyPast ? observed.dbState : 'FINAL_REVIEW',
        action: alreadyPast ? 'noop' : 'advance',
        reason: `PR #${observed.github.pullRequestNumber} exists and required checks passed`,
        facts: { requiredCiPassed: true, pullRequestExists: true, branchPushed: true },
      };
    }
    return {
      ...base,
      derivedState: 'REMEDIATING',
      action: 'resume',
      reason: `PR #${observed.github.pullRequestNumber} has failing required checks`,
      facts: { pullRequestExists: true, branchPushed: true },
    };
  }

  // 3. A PR exists but checks are still running.
  if (observed.github?.pullRequestNumber !== null && observed.github) {
    return {
      ...base,
      derivedState: 'CI',
      action: observed.dbState === 'CI' ? 'noop' : 'advance',
      reason: `PR #${observed.github.pullRequestNumber} is open, checks still running`,
      facts: { pullRequestExists: true, branchPushed: true },
    };
  }

  // 4. Work exists on a pushed branch, but no PR yet.
  if (observed.git?.branchPushed && observed.git.hasCommitsBeyondBase) {
    const next: WorkflowState = observed.ciTrigger === 'pull_request' ? 'PR_DRAFT_OPEN' : 'CI';
    return {
      ...base,
      derivedState: next,
      action: 'advance',
      reason: `branch is pushed with commits; CI trigger is "${observed.ciTrigger}"`,
      facts: { branchPushed: true },
    };
  }

  // 5. An agent died mid-implementation. Its worktree survives.
  if (observed.orca?.worktreeExists && !observed.orca.agentRunning) {
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

  // 7. Nothing external exists. Anything past QUEUED is unexplained.
  if (observed.dbState !== 'QUEUED' && observed.dbState !== 'DISCOVERED') {
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
    reason: 'nothing started yet',
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
