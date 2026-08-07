import type { Risk } from '../types/index.js';
import { NotImplementedError } from '../util/errors.js';

/**
 * Champion promotion. Each repository learns independently, so the answer is
 * never "Luna is better than DeepSeek" - it is "Luna/high/Codex currently
 * performs better on routine_bugfix inside hefesto".
 *
 * low     automatic, >=12 challenger samples, >=8% advantage, >=70% success
 * medium  proposal only
 * high    locked, no experimentation
 */

export interface PromotionCandidate {
  projectId: string;
  taskCategory: string;
  incumbent: string;
  challenger: string;
  samples: number;
  scoreAdvantage: number;
  successRate: number;
}

export function evaluate(_projectId?: string): PromotionCandidate[] {
  throw new NotImplementedError('promotion.evaluate');
}

export function isEligibleForAutomatic(_risk: Risk, _c: PromotionCandidate): boolean {
  throw new NotImplementedError('promotion.isEligibleForAutomatic');
}

/** Writes routing_history with rationale and a rollback reference. */
export function promote(_c: PromotionCandidate, _automatic: boolean): void {
  throw new NotImplementedError('promotion.promote');
}

export function rollback(_historyId: number): void {
  throw new NotImplementedError('promotion.rollback');
}
