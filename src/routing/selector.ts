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
 * One issue routinely uses four models: cleanup on DeepSeek, planning on Terra,
 * a mechanical change on DeepSeek, complex frontend work on Kimi. That is the
 * point — the system must never collapse into "the GPT pipeline" or "the
 * Ollama pipeline".
 */
export function selectModel(input: RoutingInput, deps: SelectorDeps): RoutingDecision {
  const { routing } = deps;
  const role = routing.roles[input.role];
  if (!role) throw new Error(`Unknown routing role "${input.role}"`);

  const rejected: Array<{ alias: string; why: string }> = [];
  const excluded = new Set(input.excludeAliases ?? []);

  // High risk is locked: no experimentation, ever.
  const gate = routing.risk_gates[input.risk];
  const lockedRole = gate?.lockedRole;
  if (lockedRole && lockedRole !== input.role) {
    const locked = routing.roles[lockedRole];
    if (locked) {
      return {
        alias: locked.champion,
        reason: 'locked_high_risk',
        isChallenger: false,
        utility: Number.POSITIVE_INFINITY,
        rejected,
      };
    }
  }

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
      `No eligible model for role "${input.role}". Rejected: ${rejected
        .map((r) => `${r.alias} (${r.why})`)
        .join('; ')}`,
    );
  }

  const scored = candidates
    .map((alias) => ({ alias, utility: utilityOf(alias, input, deps) }))
    .sort((a, b) => b.utility - a.utility);

  const best = scored[0]!;
  const championEligible = candidates.includes(role.champion);

  // Exploration only on low risk, and never when the champion is unavailable —
  // a forced substitution is not an experiment and must not be scored as one.
  const explore =
    championEligible &&
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

  const reason: RoutingDecision['reason'] =
    best.alias === role.champion ? 'champion' : championEligible ? 'pressure_shift' : 'pressure_shift';

  return { alias: best.alias, reason, isChallenger: false, utility: best.utility, rejected };
}

/**
 * utility = expected_score − scarcity_penalty − latency_penalty
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

  return expected * weights.expectedScore - scarcity - latency;
}

/**
 * Independent reviewer selection, by authorship rather than a rigid rule.
 *
 * The reviewer comes from the family least involved in writing the code, so a
 * family does not grade its own homework.
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
