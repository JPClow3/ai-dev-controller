import { nextAfterLocalValidation } from './states.js';
import { failureDigest } from '../validation/local.js';
import type { ChecksSummary } from '../github/checks.js';
import type { OrchestratorDeps, StepContext, StepResult } from './orchestrator-types.js';
import { move, recordOperationalRemediation, wholeTreeRemediation } from './orchestrator-shared.js';

export async function stepLocalValidation(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const summary = await deps.runValidation(ctx);

  // Setup establishes whether the worktree can be evaluated at all. Sending a
  // package-manager/auth/network failure to a code-fix worker would hide the
  // real repository problem and burn a remediation cycle.
  const setupFailure = summary.results.find((result) => result.name === 'setup' && result.required && !result.passed);
  if (setupFailure) {
    const reason = `validation setup failed: ${setupFailure.command}`;
    await deps.blockForHuman(ctx, 'setup_failed', reason);
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason });
  }

  if (!summary.passed) {
    recordOperationalRemediation(ctx, deps, [
      wholeTreeRemediation(
        deps,
        ctx,
        `Required local validation failed. Diagnose and fix only the failures below.\n\n${failureDigest(summary)}`,
        summary.results.filter((result) => !result.passed).map((result) => result.command).join(' && '),
      ),
    ]);
    return move(ctx, deps, 'REMEDIATING', {
      reason: `local validation failed: ${summary.failedRequired.join(', ')}`,
    });
  }

  // A repository that declared no commands has proven nothing. Treating that
  // as success would let unvalidated code proceed on a technicality.
  if (summary.results.length === 0 && ctx.ciTrigger === 'none') {
    await deps.blockForHuman(
      ctx,
      'no_validation_available',
      'This repository declares no validation commands and has no CI, so nothing can verify the change.',
    );
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason: 'no validation commands and no CI' });
  }

  await deps.pushBranch(ctx);
  const next = nextAfterLocalValidation(ctx.ciTrigger);

  return move(ctx, deps, next, {
    reason: `local validation passed; CI trigger is "${ctx.ciTrigger}"`,
    mechanicalFacts: {
      branchPushed: true,
      localValidationPassed: true,
      requiredCiPassed: ctx.ciTrigger === 'none' ? true : undefined,
    } as Record<string, boolean>,
  });
}

export async function stepPrDraftOpen(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  // The PR exists only so CI has something to run against; Linear still shows
  // ai-running, because this is not the finished deliverable.
  const pr = await deps.ensureDraftPr(ctx);

  return move(ctx, deps, 'CI', {
    reason: `draft PR #${pr.number} opened as the CI trigger`,
    mechanicalFacts: { branchPushed: true, pullRequestExists: true },
  });
}

export async function stepCi(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  // Branch-push CI can start without a PR, but the common check reader and the
  // eventual deliverable need one. Creation is idempotent and remains draft.
  if (ctx.ciTrigger === 'branch_push') await deps.ensureDraftPr(ctx);
  const checks: ChecksSummary = await deps.readChecks(ctx);

  if (!checks.complete) {
    return { from: ctx.run.state, to: null, action: 'waiting', detail: `checks pending: ${checks.pending.join(', ')}` };
  }
  if (!checks.allRequiredPassed) {
    if (await deps.retryEnvironmentalCi(ctx, checks)) {
      return {
        from: ctx.run.state,
        to: null,
        action: 'waiting',
        detail: `environmental CI failure rerun requested: ${checks.failed.join(', ')}`,
      };
    }
    recordOperationalRemediation(ctx, deps, [
      wholeTreeRemediation(
        deps,
        ctx,
        `Required CI checks failed: ${checks.failed.join(', ')}. Inspect the failing check output and make the smallest correction that restores the required checks.`,
        `Inspect the failed CI check(s): ${checks.failed.join(', ')}`,
      ),
    ]);
    return move(ctx, deps, 'REMEDIATING', { reason: `required checks failed: ${checks.failed.join(', ')}` });
  }

  return move(ctx, deps, 'FINAL_REVIEW', {
    reason: 'required checks passed',
    mechanicalFacts: { requiredCiPassed: true },
  });
}

