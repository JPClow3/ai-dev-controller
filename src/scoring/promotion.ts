import type { ScoringConfig } from '../config/scoring-schema.js';
import type { Risk } from '../state/types.js';

export interface CandidateStats {
  alias: string;
  samples: number;
  compositeAvg: number;
  successRate: number;
}

export interface PromotionInput {
  projectId: string;
  role: string;
  risk: Risk;
  incumbent: CandidateStats;
  challenger: CandidateStats;
}

export type PromotionDecision =
  | { action: 'promote'; automatic: true; reason: string; advantage: number }
  | { action: 'propose'; automatic: false; reason: string; advantage: number }
  | { action: 'hold'; reason: string; advantage: number };

/**
 * Champion promotion.
 *
 * Each repository learns independently, so the conclusion is never "Luna beats
 * DeepSeek" — it is "luna_high/Codex currently performs better on
 * routine_bugfix inside lorebound".
 *
 *   low     automatic, >=12 samples, >=8% advantage, >=70% success
 *   medium  proposal only
 *   high    locked, never promoted or experimented on
 */
export function evaluatePromotion(input: PromotionInput, config: ScoringConfig): PromotionDecision {
  const advantage = input.challenger.compositeAvg - input.incumbent.compositeAvg;

  if (input.risk === 'high') {
    return {
      action: 'hold',
      reason: 'high-risk routing is locked: no automatic promotion, no experimentation',
      advantage,
    };
  }

  if (input.risk === 'medium') {
    const rules = config.promotion.mediumRisk;
    if (input.challenger.samples < rules.proposeAfterSamples) {
      return {
        action: 'hold',
        reason: `medium risk needs ${rules.proposeAfterSamples} samples to propose (have ${input.challenger.samples})`,
        advantage,
      };
    }
    if (advantage <= 0) {
      return { action: 'hold', reason: 'challenger is not ahead', advantage };
    }
    return {
      action: 'propose',
      automatic: false,
      reason: `challenger leads by ${(advantage * 100).toFixed(1)}% over ${input.challenger.samples} samples; medium risk requires your approval`,
      advantage,
    };
  }

  const rules = config.promotion.lowRisk;
  const reasons: string[] = [];
  if (input.challenger.samples < rules.minimumChallengerSamples) {
    reasons.push(`only ${input.challenger.samples}/${rules.minimumChallengerSamples} samples`);
  }
  if (advantage < rules.minimumScoreAdvantage) {
    reasons.push(
      `advantage ${(advantage * 100).toFixed(1)}% below the ${(rules.minimumScoreAdvantage * 100).toFixed(0)}% threshold`,
    );
  }
  if (input.challenger.successRate < rules.minimumSuccessRate) {
    reasons.push(
      `success rate ${(input.challenger.successRate * 100).toFixed(0)}% below ${(rules.minimumSuccessRate * 100).toFixed(0)}%`,
    );
  }

  if (reasons.length > 0) {
    return { action: 'hold', reason: reasons.join('; '), advantage };
  }

  if (!rules.automatic) {
    return { action: 'propose', automatic: false, reason: 'automatic promotion disabled', advantage };
  }

  return {
    action: 'promote',
    automatic: true,
    reason: `+${(advantage * 100).toFixed(1)} composite advantage over ${input.challenger.samples} samples, ${(input.challenger.successRate * 100).toFixed(0)}% success`,
    advantage,
  };
}

export interface PromotionRecord {
  projectId: string;
  role: string;
  fromAlias: string;
  toAlias: string;
  changeType: 'promotion' | 'proposal' | 'rollback' | 'manual';
  automatic: boolean;
  samples: number;
  scoreAdvantage: number;
  reason: string;
}

/**
 * Every routing change is journalled with its rationale and remains
 * reversible. A champion that silently changed and cannot be explained is
 * worse than no learning at all.
 */
export function toRecord(input: PromotionInput, decision: PromotionDecision): PromotionRecord | null {
  if (decision.action === 'hold') return null;
  return {
    projectId: input.projectId,
    role: input.role,
    fromAlias: input.incumbent.alias,
    toAlias: input.challenger.alias,
    changeType: decision.action === 'promote' ? 'promotion' : 'proposal',
    automatic: decision.action === 'promote',
    samples: input.challenger.samples,
    scoreAdvantage: decision.advantage,
    reason: decision.reason,
  };
}
