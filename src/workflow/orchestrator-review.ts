import {
  assessReview,
  withUnaddressedCriteria,
} from '../reviews/review.js';
import { planRemediation } from '../reviews/remediation.js';
import type { OrchestratorDeps, StepContext, StepResult } from './orchestrator-types.js';
import { log, move, recordOperationalRemediation, wholeTreeRemediation } from './orchestrator-shared.js';

export async function stepFinalReview(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const review = withUnaddressedCriteria(
    await deps.review(ctx),
    deps.repos.acceptanceCriteria(ctx.run.issueId).map((criterion) => criterion.id),
  );
  // Recorded before it is acted on, so PR_READY and any restart see the same
  // verdict rather than re-deriving one.
  deps.repos.recordReview(ctx.run.id, review);
  const assessment = assessReview(review, deps.config.escalation.reviewRemediation.blockingSeverities);

  if (assessment.inconsistencies.length > 0) {
    log.warn(`${ctx.run.issueId}: reviewer contradicted itself - ${assessment.inconsistencies.join('; ')}`);
  }

  if (!assessment.clearsForPr) {
    const plan = planRemediation(
      {
        assessment,
        cyclesUsed: deps.remediationCycles(ctx.run.id),
        originalAuthors: deps.originalAuthors(ctx.run.id),
      },
      deps.config.escalation,
    );

    if (!plan.proceed && plan.blockedReason) {
      await deps.blockForHuman(ctx, 'retry_budget_exhausted', plan.blockedReason);
      return move(ctx, deps, 'BLOCKED_HUMAN', { reason: plan.blockedReason });
    }
    if (!plan.proceed) {
      if (plan.dismissed.length === 0) {
        const reason = assessment.uncertainCriteria.length > 0
          ? `review left acceptance criteria uncertain: ${assessment.uncertainCriteria.join(', ')}`
          : 'review did not clear the pull request and produced no actionable blocking finding';
        await deps.blockForHuman(ctx, 'review_inconclusive', reason);
        return move(ctx, deps, 'BLOCKED_HUMAN', { reason });
      }
      // Every blocking finding was independently dismissed as invalid, so
      // nothing actually blocks.
      return move(ctx, deps, 'PR_READY', {
        reason: 'all findings dismissed by the orchestrator',
        mechanicalFacts: {
          requiredCiPassed: true,
          noBlockingFindings: true,
          retryBudgetRemaining: true,
          localValidationPassed: true,
        },
      });
    }

    // The plan is carried into REMEDIATING rather than discarded; dispatching
    // an empty list is what turned remediation into a no-op that span until
    // the budget ran out.
    deps.repos.recordRemediationPlan(ctx.run.id, plan.tasks);
    return move(ctx, deps, 'REMEDIATING', {
      reason: `${assessment.blocking.length} blocking finding(s)`,
      recommendedBy: review.reviewer.id,
    });
  }

  return move(ctx, deps, 'PR_READY', {
    reason: 'review clear, no blocking findings',
    recommendedBy: review.reviewer.id,
    mechanicalFacts: {
      requiredCiPassed: true,
      noBlockingFindings: true,
      retryBudgetRemaining: true,
      localValidationPassed: true,
    },
  });
}

export async function stepPrReady(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  // Re-read the recorded review so the body reflects the actual verdict even
  // if the controller restarted between FINAL_REVIEW and here.
  const recorded = deps.repos.lastReview(ctx.run.id);
  const completeReview = recorded
    ? withUnaddressedCriteria(
        recorded,
        deps.repos.acceptanceCriteria(ctx.run.issueId).map((criterion) => criterion.id),
      )
    : null;
  const assessment = completeReview
    ? assessReview(completeReview, deps.config.escalation.reviewRemediation.blockingSeverities)
    : null;

  // PR_READY is persisted and therefore must defend itself against results
  // written by an older controller or a crash between recordReview and
  // assessment. Re-run the review with current objective evidence rather than
  // publishing provenance that marks uncertain criteria as complete.
  if (!assessment?.clearsForPr) {
    if (ctx.ciTrigger === 'none') {
      const reason = 'recorded final review does not establish every acceptance criterion';
      await deps.blockForHuman(ctx, 'review_inconclusive', reason);
      return move(ctx, deps, 'BLOCKED_HUMAN', { reason });
    }
    const checks = await deps.readChecks(ctx);
    if (!checks.complete) {
      return {
        from: ctx.run.state,
        to: null,
        action: 'waiting',
        detail: `checks pending while revalidating final review: ${checks.pending.join(', ')}`,
      };
    }
    if (!checks.allRequiredPassed) {
      recordOperationalRemediation(ctx, deps, [
        wholeTreeRemediation(
          deps,
          ctx,
          `Required CI checks failed while revalidating the final review: ${checks.failed.join(', ')}. Inspect the failing check output and make the smallest correction that restores the required checks.`,
          `Inspect the failed CI check(s): ${checks.failed.join(', ')}`,
        ),
      ]);
      return move(ctx, deps, 'REMEDIATING', { reason: 'CI no longer passes while revalidating final review' });
    }
    return move(ctx, deps, 'FINAL_REVIEW', {
      reason: 'recorded final review was incomplete; re-running with objective CI evidence',
      mechanicalFacts: { requiredCiPassed: true },
    });
  }

  // `none` repositories reach review without a PR, and branch-push repos may
  // also have recovered past CI. Ensure the one draft deliverable exists
  // before writing its provenance; pull-request mode simply adopts its PR.
  await deps.ensureDraftPr(ctx);
  await deps.writeProvenanceBody(ctx, assessment);

  // Draft state is verified against the real pull request, not asserted.
  const isDraft = await deps.pullRequestIsDraft(ctx);
  if (!isDraft) {
    const reason = 'the pull request is not a draft; refusing to present it as controller output';
    await deps.blockForHuman(ctx, 'pr_not_draft', reason);
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason });
  }

  const result = move(ctx, deps, 'PR_OPEN', {
    reason: 'provenance written; ready for human review',
    mechanicalFacts: { pullRequestIsDraft: true, provenanceBodyWritten: true },
  });
  // Scoring is auxiliary learning. The durable PR_OPEN transition must never
  // be held hostage by a removed worktree or incomplete historical telemetry.
  try {
    await deps.recordScores(ctx);
  } catch (error) {
    log.warn(`${ctx.run.issueId}: scoring deferred - ${(error as Error).message}`);
  }
  return result;
}

export async function stepPrOpen(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  let count = 0;
  try {
    count = await deps.recordScores(ctx);
  } catch (error) {
    log.warn(`${ctx.run.issueId}: scoring backfill deferred - ${(error as Error).message}`);
  }
  return {
    from: ctx.run.state,
    to: null,
    action: count > 0 ? 'scored' : 'waiting',
    detail: count > 0 ? `${count} routing sample(s) recorded` : 'waiting for human merge',
  };
}
