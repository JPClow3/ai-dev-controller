import type { RoutingConfig } from '../config/routing-schema.js';
import type { ScoringConfig } from '../config/scoring-schema.js';
import { scarcityMultiplier, isUsable, type PressureMap } from './pressure.js';
import type { AliasStats, AuthorshipSummary, RoutingDecision, RoutingInput } from './types.js';

export interface SelectorDeps {
  routing: RoutingConfig;
  scoring: ScoringConfig;
  pressure: PressureMap;
  /** Per-repository, per-role evidence. Empty map means "no evidence yet". */
  stats: (projectId: string, role: string, alias: string) => AliasStats | null;
  /** Injected so exploration is deterministic in tests. */
  random?: () => number;
}

/**
 * We route task types, not whole issues.
 *
 * One issue can use multiple tiers: Luna carries curation, planning and
 * routine work and is the deliberate default for cost, and Sol handles
 * orchestration review and high-risk work. Within each role challengers vary
 * reasoning effort on the same model.
 */
export function selectModel(input: RoutingInput, deps: SelectorDeps): RoutingDecision {
  const { routing } = deps;
  const requestedRole = routing.roles[input.role];
  if (!requestedRole) throw new Error(`Unknown routing role "${input.role}"`);

  const gate = routing.risk_gates[input.risk];
  const lockedRole = gate?.lockedRole;
  const effectiveRoleName = lockedRole ?? input.role;
  const role = routing.roles[effectiveRoleName];
  if (!role) throw new Error(`Unknown locked routing role "${effectiveRoleName}"`);
  const effectiveInput =
    effectiveRoleName === input.role ? input : { ...input, role: effectiveRoleName };

  const rejected: Array<{ alias: string; why: string }> = [];
  const excluded = new Set(input.excludeAliases ?? []);

  const candidates = [role.champion, ...role.challengers].filter((alias) => {
    if (excluded.has(alias)) {
      rejected.push({ alias, why: 'already attempted on this task' });
      return false;
    }
    const spec = routing.aliases[alias];
    if (!spec) {
      rejected.push({ alias, why: 'not a declared alias' });
      return false;
    }
    if (!isUsable(deps.pressure, spec.provider)) {
      rejected.push({ alias, why: `provider ${spec.provider} is EXHAUSTED` });
      return false;
    }
    if (
      input.contextEstimate !== undefined &&
      spec.contextWindow !== undefined &&
      spec.contextWindow < input.contextEstimate
    ) {
      rejected.push({ alias, why: `context window ${spec.contextWindow} < required ${input.contextEstimate}` });
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    throw new Error(
      `No eligible model for role "${effectiveRoleName}". Rejected: ${rejected
        .map((r) => `${r.alias} (${r.why})`)
        .join('; ')}`,
    );
  }

  const scored = candidates
    .map((alias) => ({ alias, utility: utilityOf(alias, effectiveInput, deps) }))
    .sort((a, b) => b.utility - a.utility);

  const best = scored[0]!;
  const championEligible = candidates.includes(role.champion);

  // Exploration only on low risk, and never when the champion is unavailable —
  // a forced substitution is not an experiment and must not be scored as one.
  const explore =
    championEligible &&
    !lockedRole &&
    (gate?.allowChallenger ?? false) &&
    deps.scoring.championChallenger.eligibleRisk.includes(input.risk) &&
    role.challengers.length > 0 &&
    (deps.random ?? Math.random)() < deps.scoring.championChallenger.explorationRate;

  if (explore) {
    const challenger = scored.find((s) => s.alias !== role.champion);
    if (challenger) {
      return { alias: challenger.alias, reason: 'challenger', isChallenger: true, utility: challenger.utility, rejected };
    }
  }

  const reason: RoutingDecision['reason'] = lockedRole
    ? 'locked_high_risk'
    : best.alias === role.champion
      ? 'champion'
      : 'pressure_shift';

  return { alias: best.alias, reason, isChallenger: false, utility: best.utility, rejected };
}

/**
 * utility = expected_score − scarcity_penalty − latency_penalty − token_penalty
 *
 * With no samples yet, the champion gets a small prior so the configured
 * hypothesis wins until evidence overturns it.
 */
export function utilityOf(alias: string, input: RoutingInput, deps: SelectorDeps): number {
  const spec = deps.routing.aliases[alias]!;
  const role = deps.routing.roles[input.role]!;
  const weights = deps.routing.pressure.utilityWeights;

  const stats = deps.stats(input.projectId, input.role, alias);
  const expected =
    stats?.compositeAvg != null && stats.samples > 0
      ? stats.compositeAvg
      : alias === role.champion
        ? 0.6
        : 0.5;

  const multiplier = scarcityMultiplier(deps.routing, deps.pressure[spec.provider]?.pressure ?? 'NORMAL');
  const scarcity = (multiplier - 1) * weights.scarcityPenalty;

  const target = deps.scoring.wallClock.targetMinutesByRole[input.role];
  const latency =
    stats?.medianMinutes != null && target
      ? Math.max(0, stats.medianMinutes / target - 1) * weights.latencyPenalty
      : 0;

  return expected * weights.expectedScore - scarcity - latency - tokenPenaltyOf(stats, weights.tokenPenalty);
}

/**
 * Where the configured token penalty saturates. A structured call on this
 * controller runs from a few thousand to a few tens of thousands of output
 * tokens, so an alias averaging 50k burns the full penalty.
 */
export const TOKEN_SATURATION_TOKENS = 50_000;

/**
 * Tokens are a consideration, not a price: within a flat subscription they
 * are the budget actually being spent. Two aliases with equal scores and
 * latency diverge on verbosity, and the quieter one wins.
 */
export function tokenPenaltyOf(
  stats: Pick<AliasStats, 'avgOutputTokens'> | null,
  weight: number,
): number {
  if (!stats?.avgOutputTokens || stats.avgOutputTokens <= 0 || weight <= 0) return 0;
  return Math.min(1, stats.avgOutputTokens / TOKEN_SATURATION_TOKENS) * weight;
}

/**
 * Independent reviewer selection, by authorship rather than a rigid rule.
 * Candidate construction keeps final review on Sol; this ranking still
 * supports multi-family/manual candidate sets and deterministic fallbacks.
 */
export function selectReviewer(
  authorship: AuthorshipSummary,
  candidates: string[],
  routing: RoutingConfig,
  strategy: 'opposite_family_from_authors' | 'least_involved_family',
): string {
  if (candidates.length === 0) throw new Error('No reviewer candidates supplied');

  const total = Object.values(authorship.byFamily).reduce((a, b) => a + b, 0);
  const share = (family: string) => (total === 0 ? 0 : (authorship.byFamily[family] ?? 0) / total);

  const dominant = Object.entries(authorship.byFamily).sort((a, b) => b[1] - a[1])[0]?.[0];

  const ranked = [...candidates].sort((a, b) => {
    const fa = routing.aliases[a]?.family ?? '';
    const fb = routing.aliases[b]?.family ?? '';
    return share(fa) - share(fb);
  });

  if (strategy === 'opposite_family_from_authors' && dominant) {
    const outside = ranked.find((alias) => routing.aliases[alias]?.family !== dominant);
    if (outside) return outside;
  }
  return ranked[0]!;
}

/** Changed lines per family, from integrated worker attempts. */
export function authorshipByFamily(
  attempts: Array<{ alias: string; changedLines: number }>,
  routing: RoutingConfig,
): AuthorshipSummary {
  const byFamily: Record<string, number> = {};
  for (const attempt of attempts) {
    const family = routing.aliases[attempt.alias]?.family;
    if (!family) continue;
    byFamily[family] = (byFamily[family] ?? 0) + attempt.changedLines;
  }
  return { byFamily };
}
