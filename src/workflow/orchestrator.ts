import { InvalidTransitionError } from './transitions.js';
import {
  stepDependencyBlocked,
  stepImplementing,
  stepIntegrating,
  stepPlanning,
  stepQueued,
} from './orchestrator-queue.js';
import {
  stepCi,
  stepLocalValidation,
  stepPrDraftOpen,
} from './orchestrator-validation.js';
import {
  stepFinalReview,
  stepPrOpen,
  stepPrReady,
} from './orchestrator-review.js';
import { stepRemediating } from './orchestrator-remediation.js';
import { log } from './orchestrator-shared.js';
import type {
  OrchestratorDeps,
  StepContext,
  StepResult,
} from './orchestrator-types.js';

export type { OrchestratorDeps, PlanTask, StepContext, StepResult } from './orchestrator-types.js';

/**
 * Advances one run by exactly one state.
 *
 * One step per call, not a loop: every step is a resumption point, so a crash
 * mid-issue leaves a state the reconciler can read rather than an unknown
 * position inside a long-running function.
 *
 * The orchestrator never writes state directly — every move goes through
 * `transitionRun`, which re-checks the edge and the mechanical preconditions.
 */
export async function advanceRun(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const from = ctx.run.state;

  try {
    switch (from) {
      case 'QUEUED':
        return await stepQueued(ctx, deps);
      case 'DEPENDENCY_BLOCKED':
        return stepDependencyBlocked(ctx, deps);
      case 'PLANNING':
        return await stepPlanning(ctx, deps);
      case 'IMPLEMENTING':
        return await stepImplementing(ctx, deps);
      case 'INTEGRATING':
        return await stepIntegrating(ctx, deps);
      case 'LOCAL_VALIDATION':
        return await stepLocalValidation(ctx, deps);
      case 'PR_DRAFT_OPEN':
        return await stepPrDraftOpen(ctx, deps);
      case 'CI':
        return await stepCi(ctx, deps);
      case 'FINAL_REVIEW':
        return await stepFinalReview(ctx, deps);
      case 'PR_READY':
        return await stepPrReady(ctx, deps);
      case 'PR_OPEN':
        return await stepPrOpen(ctx, deps);
      case 'REMEDIATING':
        return await stepRemediating(ctx, deps);
      default:
        return { from, to: null, action: 'idle', detail: `nothing to do in ${from}` };
    }
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      // A guard refusal is information, not a crash: it means a precondition
      // the controller requires is genuinely not met yet.
      log.warn(`${ctx.run.issueId}: ${err.message}`);
      return { from, to: null, action: 'refused', detail: err.message };
    }
    throw err;
  }
}
