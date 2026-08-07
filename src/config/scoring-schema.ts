import { z } from 'zod';

/** Score weights must describe a whole. A drifting total silently rescales
 *  every model comparison, so this is a hard failure rather than a warning. */
const weightsSchema = z
  .object({
    acceptance_coverage: z.number(),
    first_pass_ci: z.number(),
    reviewer_defects: z.number(),
    unnecessary_churn: z.number(),
    resource_cost: z.number(),
    wall_clock: z.number(),
  })
  .refine(
    (w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) <= 0.001,
    (w) => ({
      message: `scoring weights must sum to 1.0 (got ${Object.values(w)
        .reduce((a, b) => a + b, 0)
        .toFixed(4)})`,
    }),
  )
  .transform((w) => ({
    acceptanceCoverage: w.acceptance_coverage,
    firstPassCi: w.first_pass_ci,
    reviewerDefects: w.reviewer_defects,
    unnecessaryChurn: w.unnecessary_churn,
    resourceCost: w.resource_cost,
    wallClock: w.wall_clock,
  }));

const promotionSchema = z
  .object({
    low_risk: z.object({
      automatic: z.boolean(),
      minimum_challenger_samples: z.number().int().positive(),
      minimum_score_advantage: z.number(),
      minimum_success_rate: z.number(),
    }),
    medium_risk: z.object({
      automatic: z.literal(false),
      propose_after_samples: z.number().int().positive(),
    }),
    high_risk: z.object({
      automatic: z.literal(false),
      experimentation: z.literal(false),
    }),
  })
  .transform((p) => ({
    lowRisk: {
      automatic: p.low_risk.automatic,
      minimumChallengerSamples: p.low_risk.minimum_challenger_samples,
      minimumScoreAdvantage: p.low_risk.minimum_score_advantage,
      minimumSuccessRate: p.low_risk.minimum_success_rate,
    },
    mediumRisk: {
      automatic: p.medium_risk.automatic,
      proposeAfterSamples: p.medium_risk.propose_after_samples,
    },
    highRisk: {
      automatic: p.high_risk.automatic,
      experimentation: p.high_risk.experimentation,
    },
  }));

export const scoringConfigSchema = z
  .object({
    weights: weightsSchema,
    promotion: promotionSchema,
    champion_challenger: z
      .object({
        exploration_rate: z.number().min(0).max(1),
        eligible_risk: z.array(z.enum(['low', 'medium', 'high'])),
        dual_run: z.literal(false),
      })
      .transform((c) => ({
        explorationRate: c.exploration_rate,
        eligibleRisk: c.eligible_risk,
        dualRun: c.dual_run,
      })),
    acceptance: z
      .object({
        verdicts: z.array(z.enum(['PASS', 'PARTIAL', 'FAIL', 'UNCERTAIN'])),
        points: z.object({
          PASS: z.number(),
          PARTIAL: z.number(),
          FAIL: z.number(),
          UNCERTAIN: z.number(),
        }),
        require_evidence: z.boolean(),
      })
      .transform((a) => ({
        verdicts: a.verdicts,
        points: a.points,
        requireEvidence: a.require_evidence,
      })),
    first_pass_ci: z
      .object({ penalty_per_remediation_cycle: z.number() })
      .transform((f) => ({ penaltyPerRemediationCycle: f.penalty_per_remediation_cycle })),
    reviewer_defects: z
      .object({
        severity_penalty: z.object({
          critical: z.number(),
          high: z.number(),
          medium: z.number(),
          low: z.number(),
        }),
      })
      .transform((r) => ({ severityPenalty: r.severity_penalty })),
    churn: z
      .object({ penalty: z.record(z.string(), z.number()) })
      .transform((c) => ({ penalty: c.penalty })),
    wall_clock: z
      .object({
        target_minutes_by_role: z.record(z.string(), z.number()),
        penalty_per_target_multiple: z.number(),
      })
      .transform((w) => ({
        targetMinutesByRole: w.target_minutes_by_role,
        penaltyPerTargetMultiple: w.penalty_per_target_multiple,
      })),
  })
  .transform((s) => ({
    weights: s.weights,
    promotion: s.promotion,
    championChallenger: s.champion_challenger,
    acceptance: s.acceptance,
    firstPassCi: s.first_pass_ci,
    reviewerDefects: s.reviewer_defects,
    churn: s.churn,
    wallClock: s.wall_clock,
  }));

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;
export type ScoreWeights = ScoringConfig['weights'];
