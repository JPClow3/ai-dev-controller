import type { CompositeScore, ScoreComponents } from '../types/index.js';
import { NotImplementedError } from '../util/errors.js';

/**
 * Composite score, weights from config/scoring.yaml:
 *
 *   35%  acceptance-criteria coverage   (reviewer must cite evidence)
 *   25%  CI success without remediation
 *   15%  reviewer defect severity       (critical >> high >> medium >> low)
 *   10%  unnecessary code churn
 *   10%  effective resource cost        (subscription pressure, not API dollars)
 *    5%  wall-clock time                (small on purpose - better code is
 *                                        worth another five minutes)
 */

export interface ScoreInput {
  attemptId: number;
  criteria: Array<{ id: string; verdict: string; evidence?: string }>;
  remediationCycles: number;
  findings: Array<{ severity: string }>;
  churnSignals: Record<string, number>;
  resourceCost: number;
  wallClockSeconds: number;
  taskCategory: string;
}

export function components(_input: ScoreInput): ScoreComponents {
  throw new NotImplementedError('composite.components');
}

export function score(_input: ScoreInput): CompositeScore {
  throw new NotImplementedError('composite.score');
}

/** Recompute routing_stats rollups after an attempt is scored. */
export function recordAttemptScore(_attemptId: number, _score: CompositeScore): void {
  throw new NotImplementedError('composite.recordAttemptScore');
}
