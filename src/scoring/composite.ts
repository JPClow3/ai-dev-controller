import type { ScoringConfig } from '../config/scoring-schema.js';
import type { CriterionVerdict, Severity } from '../state/types.js';

export interface AttemptMetrics {
  role: string;
  criteria: Array<{ id: string; verdict: CriterionVerdict; evidence?: string }>;
  remediationCycles: number;
  /** Objective remote-CI evidence, or neutral 0.5 when the repository has none. */
  ciScore: number;
  findings: Array<{ severity: Severity }>;
  churnPenalty: number;
  /** Normalised 0..1 provider-quota consumption, not API dollars. */
  resourceCost: number;
  wallClockMinutes: number;
}

export interface ScoreComponents {
  acceptanceCoverage: number;
  firstPassCi: number;
  reviewerDefects: number;
  unnecessaryChurn: number;
  resourceCost: number;
  wallClock: number;
}

export interface CompositeScore extends ScoreComponents {
  composite: number;
  weights: ScoringConfig['weights'];
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Composite score, weights from config/scoring.yaml:
 *   35% acceptance coverage, 25% first-pass CI, 15% reviewer defects,
 *   10% churn, 10% resource cost, 5% wall clock.
 *
 * Every component is expressed as "higher is better" before weighting, so the
 * penalties are inverted here rather than in six separate call sites.
 */
export function scoreAttempt(metrics: AttemptMetrics, config: ScoringConfig): CompositeScore {
  const components = componentsOf(metrics, config);
  const w = config.weights;

  const composite =
    components.acceptanceCoverage * w.acceptanceCoverage +
    components.firstPassCi * w.firstPassCi +
    components.reviewerDefects * w.reviewerDefects +
    components.unnecessaryChurn * w.unnecessaryChurn +
    components.resourceCost * w.resourceCost +
    components.wallClock * w.wallClock;

  return { ...components, composite: clamp(composite), weights: w };
}

export function componentsOf(metrics: AttemptMetrics, config: ScoringConfig): ScoreComponents {
  return {
    acceptanceCoverage: acceptanceCoverage(metrics, config),
    firstPassCi: clamp(metrics.ciScore),
    reviewerDefects: reviewerDefects(metrics, config),
    unnecessaryChurn: clamp(1 - metrics.churnPenalty),
    resourceCost: clamp(1 - metrics.resourceCost),
    wallClock: wallClock(metrics, config),
  };
}

/**
 * Acceptance coverage, the heaviest single component.
 *
 * An unevidenced PASS scores as UNCERTAIN when the config demands evidence —
 * otherwise a model could win simply by claiming success, which is the exact
 * failure this system is built to resist.
 */
function acceptanceCoverage(metrics: AttemptMetrics, config: ScoringConfig): number {
  if (metrics.criteria.length === 0) return 0;

  const total = metrics.criteria.reduce((sum, criterion) => {
    const requiresEvidence = config.acceptance.requireEvidence;
    const unevidencedPass =
      requiresEvidence && criterion.verdict === 'PASS' && !criterion.evidence?.trim();
    const verdict: CriterionVerdict = unevidencedPass ? 'UNCERTAIN' : criterion.verdict;
    return sum + config.acceptance.points[verdict];
  }, 0);

  return clamp(total / metrics.criteria.length);
}

/** Severity is consequence, not effort: one critical outweighs many lows. */
function reviewerDefects(metrics: AttemptMetrics, config: ScoringConfig): number {
  const penalty = metrics.findings.reduce(
    (sum, f) => sum + (config.reviewerDefects.severityPenalty[f.severity] ?? 0),
    0,
  );
  return clamp(1 - penalty);
}

/** Small weight by design: better code is worth another five minutes. */
function wallClock(metrics: AttemptMetrics, config: ScoringConfig): number {
  const target = config.wallClock.targetMinutesByRole[metrics.role];
  if (!target || target <= 0) return 0.5;
  const overrun = Math.max(0, metrics.wallClockMinutes / target - 1);
  return clamp(1 - overrun * config.wallClock.penaltyPerTargetMultiple);
}

/**
 * Normalised provider-quota consumption.
 *
 * Both providers are flat-rate, so cost is share-of-allowance scaled by how
 * scarce that allowance currently is — not a theoretical dollar figure.
 */
export function resourceCost(input: {
  tokensUsed: number;
  rollingP90Tokens: number;
  scarcityMultiplier: number;
}): number {
  if (input.rollingP90Tokens <= 0) return 0;
  return clamp((input.tokensUsed / input.rollingP90Tokens) * input.scarcityMultiplier);
}
