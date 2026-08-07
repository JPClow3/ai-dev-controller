import { z } from 'zod';

export const MODEL_FAMILIES = ['openai', 'deepseek', 'kimi', 'glm'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/** A worker's identity is model + reasoning effort + harness. The alias key
 *  encodes all three, so `luna_high` and `luna_xhigh` compete separately. */
const aliasSchema = z
  .object({
    family: z.enum(MODEL_FAMILIES),
    harness: z.string(),
    provider: z.enum(['chatgpt', 'ollama']),
    profile: z.string(),
    context_window: z.number().int().positive().optional(),
    usage_class: z.enum(['low', 'medium', 'high']).optional(),
  })
  .transform((a) => ({
    family: a.family,
    harness: a.harness,
    provider: a.provider,
    profile: a.profile,
    contextWindow: a.context_window,
    usageClass: a.usage_class,
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
    risk_gates: z.record(
      z.enum(['low', 'medium', 'high']),
      z
        .object({
          allow_challenger: z.boolean(),
          locked_role: z.string().optional(),
        })
        .transform((g) => ({ allowChallenger: g.allow_challenger, lockedRole: g.locked_role })),
    ),
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
        },
        sources: p.sources,
      })),
  })
  // Every champion and challenger must name a real alias. A typo here would
  // otherwise surface as a routing failure at dispatch time, mid-issue.
  .superRefine((cfg, ctx) => {
    const known = new Set(Object.keys(cfg.aliases));
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
        }
      }
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
