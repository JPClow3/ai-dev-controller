import {
  remediationBudgetExhausted,
  type EscalationConfig,
  type EscalationAction,
} from '../config/escalation-schema.js';
import type { RoutingConfig } from '../config/routing-schema.js';
import { selectModel, type SelectorDeps } from './selector.js';
import type { EscalationInput, HumanBlock, RoutingDecision } from './types.js';

/**
 * The model diagnoses the failure. The controller decides what is legal.
 *
 * A classifier can say "just retry with Sol" all it likes; if the failure class
 * is `mechanical`, config/escalation.yaml forbids Sol and the recommendation is
 * discarded. That boundary is what stops an agent money furnace.
 */
export function nextEscalation(
  input: EscalationInput,
  deps: SelectorDeps & { escalation: EscalationConfig },
): RoutingDecision | HumanBlock {
  const { escalation, routing } = deps;

  // Requirement ambiguity is never a model's to resolve.
  if (input.failureClass === 'requirement_ambiguity') {
    return {
      block: true,
      trigger: 'unresolved_requirement',
      question: 'The correct behaviour is undetermined by the issue and the repository documentation.',
    };
  }

  if (budgetExhausted(input, escalation)) {
    return {
      block: true,
      trigger: 'retry_budget_exhausted',
      question: `Retry budget exhausted for ${input.role} after ${input.previousAliases.length} attempt(s): ${input.previousAliases.join(', ')}.`,
    };
  }

  const ladder = escalation.failureRoutes[input.failureClass] ?? ['human'];
  const forbidden = new Set(escalation.forbidden[input.failureClass] ?? []);
  const forbidsAll = forbidden.has('*');

  for (const action of ladder) {
    if (action === 'human') break;

    const alias = resolveAction(action, input, deps);
    if (!alias) continue;
    if (forbidsAll || forbidden.has(alias)) continue;
    if (input.previousAliases.includes(alias) && action !== 'same_model') continue;

    // Every Sol reasoning tier is rationed separately from worker escalation.
    const isSol = alias.startsWith('sol_') || routing.aliases[alias]?.model === 'gpt-5.6-sol';
    if (isSol && input.budget.solAdjudications >= escalation.limits.solAdjudications) {
      continue;
    }

    const spec = routing.aliases[alias];
    if (!spec) continue;

    return {
      alias,
      reason: 'escalation',
      isChallenger: false,
      utility: 0,
      rejected: [],
    };
  }

  return {
    block: true,
    trigger: 'retry_budget_exhausted',
    question: `No legal escalation remains for failure class "${input.failureClass}" on ${input.role}.`,
  };
}

function budgetExhausted(input: EscalationInput, escalation: EscalationConfig): boolean {
  return (
    input.budget.workerEscalations >= escalation.limits.workerEscalations ||
    remediationBudgetExhausted(
      input.budget.reviewRemediationCycles,
      escalation.limits.reviewRemediationCycles,
    )
  );
}

/** Maps a legal action to a concrete alias, or null when it cannot apply. */
function resolveAction(
  action: EscalationAction,
  input: EscalationInput,
  deps: SelectorDeps & { escalation: EscalationConfig },
): string | null {
  const { routing, escalation } = deps;
  const last = input.previousAliases[input.previousAliases.length - 1];

  switch (action) {
    case 'same_model':
      // One repair attempt only, and only for genuinely mechanical failures.
      if (!last) return null;
      return input.budget.sameModelRepairs < escalation.limits.sameModelRepair ? last : null;

    case 'cross_family_routine': {
      // The action name predates the OpenAI pilot. The preference now switches
      // model tier or reasoning effort so the same attempt is not repeated.
      const lastFamily = last ? routing.aliases[last]?.family : undefined;
      const preferred = lastFamily ? (escalation.crossFamilyPreference[lastFamily] ?? []) : [];
      const pick = preferred.find(
        (alias) => routing.aliases[alias] && !input.previousAliases.includes(alias),
      );
      if (pick) return pick;
      return pickFromRole('routine_behavior', input, deps);
    }

    case 'complex_worker':
      return pickFromRole('multi_file_feature', input, deps);

    case 'large_context':
      // Not "think harder" — more of the repository in view.
      return pickFromRole('large_context', input, deps);

    case 'orchestrator':
      return pickFromRole('orchestrator', input, deps);

    case 'high_risk':
      return routing.roles['high_risk']?.champion ?? null;

    case 'rerun_ci':
      return null;

    case 'human':
      return null;
  }
}

function pickFromRole(
  role: string,
  input: EscalationInput,
  deps: SelectorDeps & { escalation: EscalationConfig },
): string | null {
  if (!deps.routing.roles[role]) return null;
  try {
    const decision = selectModel(
      {
        projectId: input.projectId,
        role,
        risk: input.risk,
        excludeAliases: input.previousAliases,
      },
      deps,
    );
    return decision.alias;
  } catch {
    return null;
  }
}

/** Escalation ladders are per class; this exposes them for the CLI. */
export function legalActionsFor(
  failureClass: EscalationInput['failureClass'],
  escalation: EscalationConfig,
): EscalationAction[] {
  return escalation.failureRoutes[failureClass] ?? ['human'];
}

export type { RoutingConfig };
