/**
 * Controller workflow states.
 *
 * Deliberately more precise than the Linear labels. Internal churn like
 * "worker retry 2" or "waiting on GLM review" belongs here, not in the issue
 * tracker — Linear stays readable because it only ever sees the projection.
 */
export const WORKFLOW_STATES = [
  'DISCOVERED',
  'CURATING',
  'WAITING_READY',
  'QUEUED',
  'DEPENDENCY_BLOCKED',
  'PLANNING',
  'IMPLEMENTING',
  'INTEGRATING',
  'LOCAL_VALIDATION',
  'PR_DRAFT_OPEN',
  'CI',
  'FINAL_REVIEW',
  'REMEDIATING',
  'PR_READY',
  'PR_OPEN',
  'MERGED',
  'NEEDS_CONTEXT',
  'BLOCKED_HUMAN',
  'FAILED',
  'CANCELLED',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/**
 * How a repository's CI is actually triggered. Measured, not assumed.
 *
 *   pull_request  workflows fire on `pull_request` (or only on push to the
 *                 base branch). Pushing `ai/...` triggers nothing, so the
 *                 draft PR must open FIRST, purely as the CI trigger.
 *   branch_push   workflows fire on a push to any branch, so CI can run
 *                 before a PR exists.
 *   none          the repository has no CI. Local validation becomes the
 *                 authority — a deliberate, visible relaxation.
 */
export const CI_TRIGGERS = ['pull_request', 'branch_push', 'none'] as const;
export type CiTrigger = (typeof CI_TRIGGERS)[number];

/** Terminal states release the issue's active-run claim. */
export const TERMINAL_STATES = ['MERGED', 'FAILED', 'CANCELLED'] as const satisfies readonly WorkflowState[];
export type TerminalState = (typeof TERMINAL_STATES)[number];

export const EXCEPTIONAL_STATES = [
  'NEEDS_CONTEXT',
  'BLOCKED_HUMAN',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly WorkflowState[];

export function isTerminal(state: WorkflowState): state is TerminalState {
  return (TERMINAL_STATES as readonly WorkflowState[]).includes(state);
}

export function isExceptional(state: WorkflowState): boolean {
  return (EXCEPTIONAL_STATES as readonly WorkflowState[]).includes(state);
}

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
  IMPLEMENTING: ['INTEGRATING'],
  INTEGRATING: ['LOCAL_VALIDATION'],
  // branch_push -> CI directly; pull_request -> open the draft PR first;
  // none -> skip CI entirely, local validation is the authority.
  LOCAL_VALIDATION: ['CI', 'PR_DRAFT_OPEN', 'FINAL_REVIEW'],
  PR_DRAFT_OPEN: ['CI'],
  CI: ['FINAL_REVIEW'],
  FINAL_REVIEW: ['REMEDIATING', 'PR_READY'],
  REMEDIATING: ['IMPLEMENTING', 'INTEGRATING', 'LOCAL_VALIDATION', 'CI', 'FINAL_REVIEW'],
  PR_READY: ['PR_OPEN'],
  PR_OPEN: ['MERGED'],
  MERGED: [],
  NEEDS_CONTEXT: ['CURATING', 'WAITING_READY'],
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

export const AI_LIFECYCLE_LABELS = [
  'ai-curate',
  'ai-needs-context',
  'ai-ready',
  'ai-running',
  'ai-blocked',
  'ai-reviewing',
  'ai-pr-open',
] as const;
export type AiLifecycleLabel = (typeof AI_LIFECYCLE_LABELS)[number];

/**
 * What Linear is allowed to see.
 *
 * `PR_DRAFT_OPEN` maps to `ai-running`, not `ai-pr-open`: that PR is scaffolding
 * for CI, and telling you a PR is ready when it has not been reviewed would be
 * the exact false signal this system exists to avoid.
 *
 * `ai-ready` is absent: it is a human input, never a controller output.
 */
export const LINEAR_PROJECTION: Readonly<Record<WorkflowState, AiLifecycleLabel | null>> = {
  DISCOVERED: 'ai-curate',
  CURATING: 'ai-curate',
  WAITING_READY: 'ai-needs-context',
  NEEDS_CONTEXT: 'ai-needs-context',
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
