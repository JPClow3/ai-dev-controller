import { z } from 'zod';

export const MODEL_FAMILIES = ['openai', 'deepseek', 'kimi', 'glm'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/** A worker's identity is model + reasoning effort + harness. The alias key
 *  encodes all three, so `luna_high` and `luna_xhigh` compete separately. */
const aliasSchema = z
  .object({
    family: z.enum(MODEL_FAMILIES),
    harness: z.string(),
    // `ollama` (cloud) and `ollama_local` are separate providers because their
    // availability is unrelated: cloud models are subscription-gated and can
    // return 403 while a locally pulled model on the same daemon works fine.
    // Collapsing them would disable both whenever one is unusable.
    provider: z.enum(['chatgpt', 'ollama', 'ollama_local']),
    profile: z.string(),
    /**
     * Underlying model tag, for providers called over HTTP rather than through
     * the Codex harness. The Codex profile name does not carry it, and
     * hardcoding a lookup table means every new model needs a code change.
     */
    model: z.string().optional(),
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    context_window: z.number().int().positive().optional(),
    usage_class: z.enum(['low', 'medium', 'high']).optional(),
  })
  .transform((a) => ({
    family: a.family,
    harness: a.harness,
    provider: a.provider,
    profile: a.profile,
    model: a.model,
    reasoningEffort: a.reasoning_effort,
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
    for (const [name, alias] of Object.entries(cfg.aliases)) {
      if (alias.provider !== 'chatgpt') continue;
      if (!alias.model) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['aliases', name, 'model'],
          message: 'ChatGPT aliases must declare their OpenAI model',
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
        const champion = cfg.aliases[spec.champion];
        const contender = cfg.aliases[challenger];
        if (champion?.model && contender?.model && champion.model !== contender.model) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['roles', role, 'challengers'],
            message: `challenger "${challenger}" must use the champion model "${champion.model}"`,
          });
        }
        if (
          champion?.reasoningEffort &&
          contender?.reasoningEffort &&
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
