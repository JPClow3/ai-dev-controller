import type { OrcaWorkspaceStatus } from '../orca/worktrees.js';
import {
  type AiLifecycleLabel,
  type CiTrigger,
  type WorkflowState,
} from '../domain/workflow.js';

export {
  AI_LIFECYCLE_LABELS,
  CI_TRIGGERS,
  EXCEPTIONAL_STATES,
  isExceptional,
  isTerminal,
  TERMINAL_STATES,
  type AiLifecycleLabel,
  type CiTrigger,
  type TerminalState,
  type WorkflowState,
  WORKFLOW_STATES,
} from '../domain/workflow.js';

/**
 * Controller workflow states.
 *
 * Deliberately more precise than the Linear labels. Internal churn like
 * "worker retry 2" or "waiting on GLM review" belongs here, not in the issue
 * tracker — Linear stays readable because it only ever sees the projection.
 */
/**
 * Mainline progression.
 *
 * `LOCAL_VALIDATION` has two successors because the CI trigger differs by
 * repository. `PR_DRAFT_OPEN` exists only to make CI run; the PR at that point
 * is a stub and Linear still shows `ai-running`. It is not the finished
 * deliverable — that is `PR_OPEN`.
 */
export const MAINLINE_TRANSITIONS: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  DISCOVERED: ['CURATING'],
  CURATING: ['WAITING_READY'],
  WAITING_READY: ['QUEUED'],
  QUEUED: ['DEPENDENCY_BLOCKED', 'PLANNING'],
  DEPENDENCY_BLOCKED: ['QUEUED'],
  PLANNING: ['IMPLEMENTING'],
  // Every stage that can produce a failure must be able to reach REMEDIATING.
  // Without these edges an interrupted worker, a cherry-pick conflict, a red
  // test run or a failed CI check has nowhere legal to go, and the run stalls
  // in place looking like it is merely waiting.
  IMPLEMENTING: ['INTEGRATING', 'REMEDIATING'],
  INTEGRATING: ['LOCAL_VALIDATION', 'REMEDIATING'],
  // branch_push -> CI directly; pull_request -> open the draft PR first;
  // none -> skip CI entirely, local validation is the authority.
  LOCAL_VALIDATION: ['CI', 'PR_DRAFT_OPEN', 'FINAL_REVIEW', 'REMEDIATING'],
  PR_DRAFT_OPEN: ['CI', 'REMEDIATING'],
  CI: ['FINAL_REVIEW', 'REMEDIATING'],
  FINAL_REVIEW: ['REMEDIATING', 'PR_READY'],
  REMEDIATING: ['IMPLEMENTING', 'INTEGRATING', 'LOCAL_VALIDATION', 'CI', 'FINAL_REVIEW'],
  // FINAL_REVIEW is a recovery edge for a persisted review that proves
  // incomplete or inconsistent when PR_READY revalidates it after restart.
  PR_READY: ['FINAL_REVIEW', 'PR_OPEN'],
  PR_OPEN: ['MERGED'],
  MERGED: [],
  BLOCKED_HUMAN: ['QUEUED', 'PLANNING', 'IMPLEMENTING', 'REMEDIATING'],
  FAILED: ['QUEUED'],
  CANCELLED: [],
};

/** The legal successor of LOCAL_VALIDATION for a given repository. */
export function nextAfterLocalValidation(trigger: CiTrigger): WorkflowState {
  switch (trigger) {
    case 'pull_request':
      return 'PR_DRAFT_OPEN';
    case 'branch_push':
      return 'CI';
    case 'none':
      return 'FINAL_REVIEW';
  }
}

/**
 * What Linear is allowed to see.
 *
 * `PR_DRAFT_OPEN` maps to `ai-running`, not `ai-pr-open`: that PR is scaffolding
 * for CI, and telling you a PR is ready when it has not been reviewed would be
 * the exact false signal this system exists to avoid.
 *
 * `WAITING_READY` is the short durable boundary after curation. It projects to
 * `ai-ready`, which the scheduler consumes automatically on the same or next
 * tick.
 */
export const LINEAR_PROJECTION: Readonly<Record<WorkflowState, AiLifecycleLabel | null>> = {
  DISCOVERED: 'ai-curate',
  CURATING: 'ai-curate',
  WAITING_READY: 'ai-ready',
  QUEUED: 'ai-running',
  PLANNING: 'ai-running',
  IMPLEMENTING: 'ai-running',
  INTEGRATING: 'ai-running',
  LOCAL_VALIDATION: 'ai-running',
  PR_DRAFT_OPEN: 'ai-running',
  REMEDIATING: 'ai-running',
  CI: 'ai-reviewing',
  FINAL_REVIEW: 'ai-reviewing',
  PR_READY: 'ai-reviewing',
  PR_OPEN: 'ai-pr-open',
  DEPENDENCY_BLOCKED: 'ai-blocked',
  BLOCKED_HUMAN: 'ai-blocked',
  FAILED: 'ai-blocked',
  MERGED: null,
  CANCELLED: null,
};

export function projectToLinear(state: WorkflowState): AiLifecycleLabel | null {
  return LINEAR_PROJECTION[state];
}

/**
 * What the Orca workspace board is allowed to see.
 *
 * The board is coarser than the state machine on purpose — its columns exist
 * so a human can see at a glance what is worth looking at, not to mirror
 * internal churn. `in-progress` covers everything from queue to local
 * validation, `in-review` starts the moment CI or a reviewer sees the change,
 * and `completed` is reserved for runs whose PR merged (or was cancelled —
 * the board has no "abandoned" column, and leaving cancelled work pinned in
 * a live column is the stale-board problem again).
 *
 * Blocked and failed runs go back to `todo`: they are waiting on a human,
 * which is exactly what that column is for.
 */
export const ORCA_BOARD_PROJECTION: Readonly<Record<WorkflowState, OrcaWorkspaceStatus>> = {
  DISCOVERED: 'todo',
  CURATING: 'todo',
  WAITING_READY: 'todo',
  QUEUED: 'in-progress',
  PLANNING: 'in-progress',
  IMPLEMENTING: 'in-progress',
  INTEGRATING: 'in-progress',
  LOCAL_VALIDATION: 'in-progress',
  PR_DRAFT_OPEN: 'in-progress',
  REMEDIATING: 'in-progress',
  CI: 'in-review',
  FINAL_REVIEW: 'in-review',
  PR_READY: 'in-review',
  PR_OPEN: 'in-review',
  MERGED: 'completed',
  DEPENDENCY_BLOCKED: 'todo',
  BLOCKED_HUMAN: 'todo',
  FAILED: 'todo',
  CANCELLED: 'completed',
};

export function projectToOrcaBoard(state: WorkflowState): OrcaWorkspaceStatus {
  return ORCA_BOARD_PROJECTION[state];
}
