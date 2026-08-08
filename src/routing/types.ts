import type { Risk } from '../state/types.js';
import type { FailureClass } from '../config/escalation-schema.js';

export type Pressure = 'LOW' | 'NORMAL' | 'HIGH' | 'EXHAUSTED';

export interface RoutingInput {
  /** Registry project id; routing statistics are per-repository. */
  projectId: string;
  /** Key from config/routing.yaml -> roles. */
  role: string;
  risk: Risk;
  /** Approximate context the task needs, gating small-window models. */
  contextEstimate?: number;
  /** Aliases already tried on this task, never re-selected. */
  excludeAliases?: string[];
}

export interface RoutingDecision {
  alias: string;
  reason: 'champion' | 'challenger' | 'pressure_shift' | 'escalation' | 'locked_high_risk';
  isChallenger: boolean;
  utility: number;
  rejected: Array<{ alias: string; why: string }>;
}

export interface HumanBlock {
  block: true;
  trigger: string;
  question: string;
}

export interface EscalationInput {
  projectId: string;
  role: string;
  risk: Risk;
  failureClass: FailureClass;
  previousAliases: string[];
  /** Counts consumed so far, checked against config/escalation.yaml limits. */
  budget: {
    sameModelRepairs: number;
    workerEscalations: number;
    reviewRemediationCycles: number;
    solAdjudications: number;
  };
}

/** Per-alias evidence used to score utility. Empty until samples accumulate. */
export interface AliasStats {
  samples: number;
  compositeAvg: number | null;
  successRate: number | null;
  medianMinutes: number | null;
}

export interface AuthorshipSummary {
  /** Changed lines attributed to each model family. */
  byFamily: Record<string, number>;
}

export function isHumanBlock(x: RoutingDecision | HumanBlock): x is HumanBlock {
  return (x as HumanBlock).block === true;
}
