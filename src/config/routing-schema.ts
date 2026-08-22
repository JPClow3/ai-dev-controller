import { z } from 'zod';
import { PROVIDER_IDS, type ProviderId } from './providers-schema.js';

/**
 * Model families are used for review-independence: a family should not grade
 * its own homework. Families are deliberately broad so one provider adding a
 * model does not require a schema change.
 */
export const MODEL_FAMILIES = ['openai', 'zai', 'anthropic', 'moonshot', 'deepseek'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/** A worker's identity is model + reasoning effort + harness + provider. The
 *  alias key encodes all four, so `luna_high` (ChatGPT via Codex) and
 *  `luna_cc` (ChatGPT via Command Code) compete separately. */
const aliasSchema = z
  .object({
    family: z.enum(MODEL_FAMILIES),
    harness: z.string(),
    provider: z.enum(PROVIDER_IDS),
    /** Codex profile name; only meaningful for the codex-cli transport. */
    profile: z.string().optional(),
    /** Underlying model tag. Required everywhere so routing stats and the TUI
     *  can group usage by model rather than by transport. */
    model: z.string(),
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    context_window: z.number().int().positive().optional(),
  })
  .transform((a) => ({
    family: a.family,
    harness: a.harness,
    provider: a.provider,
    profile: a.profile,
    model: a.model,
    reasoningEffort: a.reasoning_effort,
    contextWindow: a.context_window,
  }));

const roleSchema = z
  .object({
    champion: z.string(),
    challengers: z.array(z.string()).default([]),
  })
  .transform((r) => ({ champion: r.champion, challengers: r.challengers }));

export const PRESSURE_STATES = ['LOW', 'NORMAL', 'HIGH', 'EXHAUSTED'] as const;

export const routingConfigSchema = z
  .object({
    aliases: z.record(z.string(), aliasSchema),
    roles: z.record(z.string(), roleSchema),
    risk_gates: z.object({
      low: z
        .object({ allow_challenger: z.boolean(), locked_role: z.string().optional() })
        .transform((g) => ({ allowChallenger: g.allow_challenger, lockedRole: g.locked_role })),
      medium: z
        .object({ allow_challenger: z.boolean(), locked_role: z.string().optional() })
        .transform((g) => ({ allowChallenger: g.allow_challenger, lockedRole: g.locked_role })),
      high: z
        .object({ allow_challenger: z.boolean(), locked_role: z.string().optional() })
        .transform((g) => ({ allowChallenger: g.allow_challenger, lockedRole: g.locked_role })),
    }),
    review: z
      .object({
        integration: z.object({ strategy: z.literal('opposite_family_from_authors') }),
        final: z.object({ strategy: z.literal('least_involved_family') }),
        escalation: z.string(),
      })
      .transform((r) => ({
        integrationStrategy: r.integration.strategy,
        finalStrategy: r.final.strategy,
        escalation: r.escalation,
      })),
    pressure: z
      .object({
        states: z.array(z.enum(PRESSURE_STATES)),
        default: z.enum(PRESSURE_STATES),
        scarcity_multiplier: z.record(z.enum(PRESSURE_STATES), z.number()),
        utility_weights: z.object({
          expected_score: z.number(),
          scarcity_penalty: z.number(),
          latency_penalty: z.number(),
          token_penalty: z.number().default(0.2),
        }),
        sources: z.array(z.string()),
      })
      .transform((p) => ({
        states: p.states,
        default: p.default,
        scarcityMultiplier: p.scarcity_multiplier,
        utilityWeights: {
          expectedScore: p.utility_weights.expected_score,
          scarcityPenalty: p.utility_weights.scarcity_penalty,
          latencyPenalty: p.utility_weights.latency_penalty,
          tokenPenalty: p.utility_weights.token_penalty,
        },
        sources: p.sources,
      })),
  })
  // Every champion and challenger must name a real alias. A typo here would
  // otherwise surface as a routing failure at dispatch time, mid-issue.
  .superRefine((cfg, ctx) => {
    const known = new Set(Object.keys(cfg.aliases));
    for (const [name, alias] of Object.entries(cfg.aliases)) {
      if (alias.provider === 'chatgpt') {
        if (!alias.profile) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['aliases', name, 'profile'],
            message: 'ChatGPT aliases must declare their Codex profile',
          });
        }
        if (!alias.reasoningEffort) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['aliases', name, 'reasoning_effort'],
            message: 'ChatGPT aliases must declare reasoning_effort',
          });
        }
      }
    }
    for (const [role, spec] of Object.entries(cfg.roles)) {
      if (!known.has(spec.champion)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roles', role, 'champion'],
          message: `unknown alias "${spec.champion}"`,
        });
      }
      for (const challenger of spec.challengers) {
        if (!known.has(challenger)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['roles', role, 'challengers'],
            message: `unknown alias "${challenger}"`,
          });
          continue;
        }
        const champion = cfg.aliases[spec.champion];
        const contender = cfg.aliases[challenger];
        if (!champion || !contender) continue;

        // Same-provider challengers keep the experiment to one variable:
        // reasoning depth. Cross-provider challengers are allowed to change
        // provider and model at once, because the whole point is a fallback
        // to a different account/model when one provider is exhausted.
        if (champion.provider === contender.provider) {
          if (champion.model !== contender.model) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['roles', role, 'challengers'],
              message: `challenger "${challenger}" must use the champion model "${champion.model}" when both use provider "${champion.provider}"`,
            });
          }
          if (
            champion.reasoningEffort &&
            contender.reasoningEffort &&
            champion.reasoningEffort === contender.reasoningEffort
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['roles', role, 'challengers'],
              message: `challenger "${challenger}" must use a different reasoning effort`,
            });
          }
        }
      }
    }
    for (const [risk, gate] of Object.entries(cfg.risk_gates)) {
      if (gate.lockedRole && !cfg.roles[gate.lockedRole]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['risk_gates', risk, 'locked_role'],
          message: `unknown role "${gate.lockedRole}"`,
        });
      }
    }
    if (cfg.risk_gates.high.allowChallenger) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['risk_gates', 'high', 'allow_challenger'],
        message: 'high-risk routing cannot allow challengers',
      });
    }
    if (!known.has(cfg.review.escalation)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['review', 'escalation'],
        message: `unknown alias "${cfg.review.escalation}"`,
      });
    }
  });

export type RoutingConfig = z.infer<typeof routingConfigSchema>;
export type ModelAlias = RoutingConfig['aliases'][string];
export type { ProviderId };
