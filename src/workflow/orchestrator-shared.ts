import type { TransitionEvidence } from './transitions.js';
import type { RemediationTask } from '../reviews/remediation.js';
import { logger } from '../util/log.js';
import type { OrchestratorDeps, StepContext, StepResult } from './orchestrator-types.js';
import type { WorkflowState } from './states.js';

export const log = logger('orchestrator');

export function move(
  ctx: StepContext,
  deps: OrchestratorDeps,
  to: WorkflowState,
  evidence: Omit<TransitionEvidence, 'ciTrigger'>,
): StepResult {
  deps.repos.transitionRun(ctx.run.id, to, { ...evidence, ciTrigger: ctx.ciTrigger });
  return { from: ctx.run.state, to, action: 'advanced', detail: evidence.reason };
}

/**
 * Every path into REMEDIATING must leave a durable, runnable packet behind.
 * Final-review findings already arrive as file-scoped tasks; mechanical
 * validation and CI failures are not file-scoped, so they run as one worker
 * over the integrated tree to keep ownership disjoint and the diagnosis intact.
 */
export function wholeTreeRemediation(
  deps: OrchestratorDeps,
  ctx: StepContext,
  instruction: string,
  suggestedValidation: string,
): RemediationTask {
  return {
    findingIndex: 0,
    file: '.',
    acceptanceCriterion: null,
    instruction,
    suggestedValidation,
    excludeAliases: deps.originalAuthors(ctx.run.id),
  };
}

export function recordOperationalRemediation(
  ctx: StepContext,
  deps: OrchestratorDeps,
  tasks: RemediationTask[],
): void {
  if (tasks.length === 0) throw new Error(`${ctx.run.issueId}: remediation requires at least one task`);
  deps.repos.recordRemediationPlan(ctx.run.id, tasks);
}

