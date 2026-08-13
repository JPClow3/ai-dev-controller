import { remediationBudgetExhausted } from '../config/escalation-schema.js';
import { failureDigest } from '../validation/local.js';
import type { OrchestratorDeps, StepContext, StepResult } from './orchestrator-types.js';
import { move, recordOperationalRemediation, wholeTreeRemediation } from './orchestrator-shared.js';

export async function stepRemediating(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const cycles = deps.remediationCycles(ctx.run.id);
  if (remediationBudgetExhausted(cycles, deps.config.escalation.limits.reviewRemediationCycles)) {
    const reason = `remediation budget exhausted after ${cycles} cycle(s)`;
    await deps.blockForHuman(ctx, 'retry_budget_exhausted', reason);
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason });
  }

  let pending = deps.repos.pendingRemediation(ctx.run.id);
  if (pending.length === 0) {
    // Older runs can have reached REMEDIATING before operational remediation
    // packets were persisted. Local validation is durable evidence, so rebuild
    // the one whole-tree repair task instead of leaving those runs stranded.
    const validation = deps.repos.lastValidation(ctx.run.id);
    if (validation && !validation.passed) {
      recordOperationalRemediation(ctx, deps, [
        wholeTreeRemediation(
          deps,
          ctx,
          `Required local validation failed. Diagnose and fix only the failures below.\n\n${failureDigest(validation)}`,
          validation.results.filter((result) => !result.passed).map((result) => result.command).join(' && '),
        ),
      ]);
      pending = deps.repos.pendingRemediation(ctx.run.id);
    }
  }
  if (pending.length === 0) {
    const reason = 'remediation requested but no remediation tasks were recorded';
    await deps.blockForHuman(ctx, 'remediation_empty', reason);
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason });
  }
  await deps.dispatchRemediation(ctx, pending);

  return move(ctx, deps, 'IMPLEMENTING', {
    reason: `remediation cycle ${cycles + 1} dispatched`,
    mechanicalFacts: { planValidated: true, ownershipSetsDisjoint: true, worktreesCreated: true },
  });
}
