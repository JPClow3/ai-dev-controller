import { z } from 'zod';

export const FAILURE_CLASSES = [
  'mechanical',
  'localized_logic',
  'context_insufficient',
  'architecture_integration',
  'reviewer_dispute',
  'flaky_environmental',
  'requirement_ambiguity',
  'unknown',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const ESCALATION_ACTIONS = [
  'same_model',
  'cross_family_routine',
  'complex_worker',
  'large_context',
  'orchestrator',
  'high_risk',
  'rerun_ci',
  'human',
] as const;
export type EscalationAction = (typeof ESCALATION_ACTIONS)[number];

/** A configured cycle count is a hard ceiling, not one more retry. */
export function remediationBudgetExhausted(cyclesUsed: number, limit: number): boolean {
  return cyclesUsed >= limit;
}

export const escalationConfigSchema = z
  .object({
    limits: z
      .object({
        same_model_repair: z.number().int().nonnegative(),
        worker_escalations: z.number().int().nonnegative(),
        review_remediation_cycles: z.number().int().nonnegative(),
        sol_adjudications: z.number().int().nonnegative(),
      })
      .transform((l) => ({
        sameModelRepair: l.same_model_repair,
        workerEscalations: l.worker_escalations,
        reviewRemediationCycles: l.review_remediation_cycles,
        solAdjudications: l.sol_adjudications,
      })),
    failure_routes: z.record(z.enum(FAILURE_CLASSES), z.array(z.enum(ESCALATION_ACTIONS)).min(1)),
    forbidden: z.partialRecord(z.enum(FAILURE_CLASSES), z.array(z.string())).default({}),
    cross_family_preference: z.record(z.string(), z.array(z.string())),
    review_remediation: z
      .object({
        orchestrator_validates_finding: z.boolean(),
        remediation_worker: z.literal('different_from_original_author'),
        reviewer_rechecks: z.boolean(),
        blocking_severities: z.array(z.enum(['critical', 'high', 'medium', 'low'])),
      })
      .transform((r) => ({
        orchestratorValidatesFinding: r.orchestrator_validates_finding,
        remediationWorker: r.remediation_worker,
        reviewerRechecks: r.reviewer_rechecks,
        blockingSeverities: r.blocking_severities,
      })),
    human_escalation_triggers: z.array(z.string()).min(1),
  })
  // Every failure class needs a defined route. An unrouted class would fall
  // through to "do nothing", which looks like a hang rather than an error.
  .superRefine((cfg, ctx) => {
    for (const cls of FAILURE_CLASSES) {
      if (!cfg.failure_routes[cls]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['failure_routes', cls],
          message: `no escalation route defined for failure class "${cls}"`,
        });
      }
    }
    if (!cfg.failure_routes.requirement_ambiguity?.includes('human')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure_routes', 'requirement_ambiguity'],
        message: 'requirement_ambiguity must route to "human"; no model may decide a product question',
      });
    }
  })
  .transform((cfg) => ({
    limits: cfg.limits,
    failureRoutes: cfg.failure_routes as Record<FailureClass, EscalationAction[]>,
    forbidden: cfg.forbidden as Partial<Record<FailureClass, string[]>>,
    crossFamilyPreference: cfg.cross_family_preference,
    reviewRemediation: cfg.review_remediation,
    humanEscalationTriggers: cfg.human_escalation_triggers,
  }));

export type EscalationConfig = z.infer<typeof escalationConfigSchema>;
