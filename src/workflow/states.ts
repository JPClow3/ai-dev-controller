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

/** Terminal states release the issue's active-run claim. */
export const TERMINAL_STATES = ['MERGED', 'FAILED', 'CANCELLED'] as const satisfies readonly WorkflowState[];
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** Reachable from any active state when evidence carries a machine-readable reason. */
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

/** Mainline progression. Exceptional states are added on top by the guard. */
export const MAINLINE_TRANSITIONS: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  DISCOVERED: ['CURATING'],
  CURATING: ['WAITING_READY'],
  WAITING_READY: ['QUEUED'],
  QUEUED: ['DEPENDENCY_BLOCKED', 'PLANNING'],
  DEPENDENCY_BLOCKED: ['QUEUED'],
  PLANNING: ['IMPLEMENTING'],
  IMPLEMENTING: ['INTEGRATING'],
  INTEGRATING: ['LOCAL_VALIDATION'],
  LOCAL_VALIDATION: ['CI'],
  CI: ['FINAL_REVIEW'],
  FINAL_REVIEW: ['REMEDIATING', 'PR_READY'],
  REMEDIATING: ['IMPLEMENTING', 'INTEGRATING', 'LOCAL_VALIDATION', 'CI', 'FINAL_REVIEW'],
  PR_READY: ['PR_OPEN'],
  PR_OPEN: ['MERGED'],
  MERGED: [],
  // Recovery paths back into the mainline after a human intervenes.
  NEEDS_CONTEXT: ['CURATING', 'WAITING_READY'],
  BLOCKED_HUMAN: ['QUEUED', 'PLANNING', 'IMPLEMENTING', 'REMEDIATING'],
  FAILED: ['QUEUED'],
  CANCELLED: [],
};

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
 * What Linear is allowed to see. Several internal states collapse onto one
 * label on purpose.
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
