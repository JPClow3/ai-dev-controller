import type { ControllerConfig } from '../config/load-config.js';
import type { ControllerRepositories } from '../state/repositories.js';
import type { RunRecord, Risk } from '../state/types.js';
import type { CiTrigger, WorkflowState } from './states.js';
import { nextAfterLocalValidation } from './states.js';
import type { TransitionEvidence } from './transitions.js';
import { InvalidTransitionError } from './transitions.js';
import type { ValidationSummary } from '../validation/result.js';
import type { ChecksSummary } from '../github/checks.js';
import { assessReview, type ReviewResult, type ReviewAssessment } from '../reviews/review.js';
import { planRemediation } from '../reviews/remediation.js';
import { overlappingOwnership } from '../git/integration.js';
import { logger } from '../util/log.js';

const log = logger('orchestrator');

export interface PlanTask {
  id: string;
  summary: string;
  task_category: string;
  owns: string[];
  blocked_by?: string[];
  acceptance_criteria: string[];
  risk?: Risk;
}

export interface StepContext {
  run: RunRecord;
  projectId: string;
  ciTrigger: CiTrigger;
  risk: Risk;
  baseBranch: string;
  branch: string;
  /**
   * The parent Orca worktree, where this run's branch is actually checked out.
   *
   * Distinct from the registry's repository path, which holds the base branch.
   * Every git and validation operation after PLANNING belongs here; running
   * them in the registry path operates on the wrong tree entirely.
   */
  worktreePath: string;
}

/**
 * Side effects the orchestrator needs, each one already implemented elsewhere.
 *
 * Injected rather than imported so a step can be exercised without Orca,
 * GitHub or a model being reachable — which is the only way this is testable
 * before a pilot.
 */
export interface OrchestratorDeps {
  config: ControllerConfig;
  repos: ControllerRepositories;

  dependenciesMerged: (issueId: string) => boolean;
  fetchFreshBase: (ctx: StepContext) => Promise<string>;

  plan: (ctx: StepContext) => Promise<{ tasks: PlanTask[]; blocked?: string }>;
  createWorktrees: (ctx: StepContext, tasks: PlanTask[]) => Promise<void>;

  workersSettled: (ctx: StepContext) => Promise<{ allSettled: boolean; interrupted: string[] }>;
  /** Launches tasks whose blockers have finished; returns how many started. */
  dispatchNextWave: (ctx: StepContext) => Promise<number>;
  integrate: (ctx: StepContext) => Promise<{ conflicts: string[]; headSha: string | null }>;

  runValidation: (ctx: StepContext) => Promise<ValidationSummary>;
  pushBranch: (ctx: StepContext) => Promise<void>;
  ensureDraftPr: (ctx: StepContext) => Promise<{ number: number }>;
  readChecks: (ctx: StepContext) => Promise<ChecksSummary>;
  /** Read from GitHub, never assumed. */
  pullRequestIsDraft: (ctx: StepContext) => Promise<boolean>;

  review: (ctx: StepContext) => Promise<ReviewResult>;
  /**
   * The assessment is threaded through rather than recomputed, so the PR body
   * reports what the reviewer actually concluded. Rendering it independently
   * is how a body ends up claiming every criterion passed.
   */
  writeProvenanceBody: (ctx: StepContext, assessment: ReviewAssessment | null) => Promise<void>;

  remediationCycles: (runId: string) => number;
  originalAuthors: (runId: string) => string[];
  dispatchRemediation: (ctx: StepContext, tasks: unknown[]) => Promise<void>;

  blockForHuman: (ctx: StepContext, trigger: string, question: string) => Promise<void>;
}

export interface StepResult {
  from: WorkflowState;
  to: WorkflowState | null;
  action: string;
  detail?: string;
}

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

function move(
  ctx: StepContext,
  deps: OrchestratorDeps,
  to: WorkflowState,
  evidence: Omit<TransitionEvidence, 'ciTrigger'>,
): StepResult {
  deps.repos.transitionRun(ctx.run.id, to, { ...evidence, ciTrigger: ctx.ciTrigger });
  return { from: ctx.run.state, to, action: 'advanced', detail: evidence.reason };
}

async function stepQueued(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  if (!deps.dependenciesMerged(ctx.run.issueId)) {
    return move(ctx, deps, 'DEPENDENCY_BLOCKED', { reason: 'blockers are not merged yet' });
  }

  // Fetch happens before the transition, because `freshBaseFetched` must be a
  // fact rather than an intention.
  const baseSha = await deps.fetchFreshBase(ctx);

  return move(ctx, deps, 'PLANNING', {
    reason: `dependencies merged; base ${baseSha.slice(0, 8)} fetched`,
    mechanicalFacts: { dependenciesMerged: true, capacityAvailable: true, freshBaseFetched: true },
  });
}

async function stepPlanning(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const result = await deps.plan(ctx);

  if (result.blocked) {
    await deps.blockForHuman(ctx, 'unresolved_requirement', result.blocked);
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason: result.blocked });
  }

  // Prevention, not reconciliation: overlapping parallel tasks are the main
  // avoidable source of agent merge conflicts.
  const clashes = overlappingOwnership(
    result.tasks.map((t) => ({ id: t.id, owns: t.owns, blockedBy: t.blocked_by ?? [] })),
  );
  if (clashes.length > 0) {
    const detail = clashes.map((c) => `${c.a} and ${c.b} both own ${c.globs.join(', ')}`).join('; ');
    await deps.blockForHuman(ctx, 'plan_ownership_conflict', detail);
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason: `plan has overlapping ownership: ${detail}` });
  }

  await deps.createWorktrees(ctx, result.tasks);

  return move(ctx, deps, 'IMPLEMENTING', {
    reason: `${result.tasks.length} task(s) planned with disjoint ownership`,
    mechanicalFacts: { planValidated: true, ownershipSetsDisjoint: true, worktreesCreated: true },
  });
}

async function stepImplementing(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const { allSettled, interrupted } = await deps.workersSettled(ctx);
  if (!allSettled) {
    return { from: ctx.run.state, to: null, action: 'waiting', detail: 'workers still running' };
  }
  if (interrupted.length > 0) {
    return move(ctx, deps, 'REMEDIATING', {
      reason: `interrupted worker(s): ${interrupted.join(', ')}`,
    });
  }

  // A wave finishing is not the plan finishing. Tasks held back behind a
  // blocker become runnable exactly here, and integrating without them would
  // ship half a plan while reporting that every task reached a terminal state.
  const started = await deps.dispatchNextWave(ctx);
  if (started > 0) {
    return { from: ctx.run.state, to: null, action: 'waiting', detail: `${started} task(s) dispatched in the next wave` };
  }

  return move(ctx, deps, 'INTEGRATING', {
    reason: 'all workers reached a terminal state',
    mechanicalFacts: { allTasksTerminal: true },
  });
}

async function stepIntegrating(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const { conflicts, headSha } = await deps.integrate(ctx);

  if (conflicts.length > 0) {
    // Resolved in the parent, never by letting workers touch each other's trees.
    return move(ctx, deps, 'REMEDIATING', {
      reason: `integration conflicts in ${conflicts.join(', ')}`,
    });
  }
  if (!headSha) {
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason: 'no worker produced any commit' });
  }

  return move(ctx, deps, 'LOCAL_VALIDATION', {
    reason: `integrated at ${headSha.slice(0, 8)}`,
    mechanicalFacts: { integrationCommitPresent: true },
  });
}

async function stepLocalValidation(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const summary = await deps.runValidation(ctx);

  if (!summary.passed) {
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

async function stepPrDraftOpen(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  // The PR exists only so CI has something to run against; Linear still shows
  // ai-running, because this is not the finished deliverable.
  const pr = await deps.ensureDraftPr(ctx);

  return move(ctx, deps, 'CI', {
    reason: `draft PR #${pr.number} opened as the CI trigger`,
    mechanicalFacts: { branchPushed: true, pullRequestExists: true },
  });
}

async function stepCi(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const checks = await deps.readChecks(ctx);

  if (!checks.complete) {
    return { from: ctx.run.state, to: null, action: 'waiting', detail: `checks pending: ${checks.pending.join(', ')}` };
  }
  if (!checks.allRequiredPassed) {
    return move(ctx, deps, 'REMEDIATING', { reason: `required checks failed: ${checks.failed.join(', ')}` });
  }

  return move(ctx, deps, 'FINAL_REVIEW', {
    reason: 'required checks passed',
    mechanicalFacts: { requiredCiPassed: true },
  });
}

async function stepFinalReview(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const review = await deps.review(ctx);
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
      // Every finding was dismissed as invalid, so nothing actually blocks.
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

async function stepPrReady(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  // Re-read the recorded review so the body reflects the actual verdict even
  // if the controller restarted between FINAL_REVIEW and here.
  const recorded = deps.repos.lastReview(ctx.run.id);
  const assessment = recorded
    ? assessReview(recorded, deps.config.escalation.reviewRemediation.blockingSeverities)
    : null;

  await deps.writeProvenanceBody(ctx, assessment);

  // Draft state is verified against the real pull request, not asserted.
  const isDraft = await deps.pullRequestIsDraft(ctx);
  if (!isDraft) {
    const reason = 'the pull request is not a draft; refusing to present it as controller output';
    await deps.blockForHuman(ctx, 'pr_not_draft', reason);
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason });
  }

  return move(ctx, deps, 'PR_OPEN', {
    reason: 'provenance written; ready for human review',
    mechanicalFacts: { pullRequestIsDraft: true, provenanceBodyWritten: true },
  });
}

async function stepRemediating(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const cycles = deps.remediationCycles(ctx.run.id);
  if (cycles > deps.config.escalation.limits.reviewRemediationCycles) {
    const reason = `remediation budget exhausted after ${cycles} cycle(s)`;
    await deps.blockForHuman(ctx, 'retry_budget_exhausted', reason);
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason });
  }

  const pending = deps.repos.pendingRemediation(ctx.run.id);
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
