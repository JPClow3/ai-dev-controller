/**
 * Shared workflow vocabulary.
 *
 * This module deliberately has no dependency on adapters or orchestration so
 * configuration, persistence and Linear can describe controller state without
 * importing up through the workflow implementation.
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
  'BLOCKED_HUMAN',
  'FAILED',
  'CANCELLED',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** Terminal states release the issue's active-run claim. */
export const TERMINAL_STATES = ['MERGED', 'FAILED', 'CANCELLED'] as const satisfies readonly WorkflowState[];
export type TerminalState = (typeof TERMINAL_STATES)[number];

export const EXCEPTIONAL_STATES = [
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

export const CI_TRIGGERS = ['pull_request', 'branch_push', 'none'] as const;
export type CiTrigger = (typeof CI_TRIGGERS)[number];

export const AI_LIFECYCLE_LABELS = [
  'ai-curate',
  'ai-ready',
  'ai-running',
  'ai-blocked',
  'ai-reviewing',
  'ai-pr-open',
] as const;
export type AiLifecycleLabel = (typeof AI_LIFECYCLE_LABELS)[number];
