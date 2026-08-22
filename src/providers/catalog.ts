import type { ModelFamily } from '../config/routing-schema.js';
import type { PlanTier } from '../config/providers-schema.js';

export interface CatalogEntry {
  id: string;
  family: ModelFamily;
  minPlan: PlanTier;
}

const PLAN_RANK: Record<PlanTier, number> = { go: 0, goat: 1, pro: 2, max: 3 };

/**
 * Static model catalog for plan gating. These are the exact model ids the
 * Command Code product accepts; ids are never invented at runtime.
 */
export const MODEL_CATALOG: readonly CatalogEntry[] = [
  { id: 'gpt-5.6-luna', family: 'openai', minPlan: 'go' },
  { id: 'gpt-5.6-terra', family: 'openai', minPlan: 'pro' },
  { id: 'gpt-5.6-sol', family: 'openai', minPlan: 'pro' },
  { id: 'claude-sonnet-5', family: 'anthropic', minPlan: 'pro' },
  { id: 'claude-sonnet-4-6', family: 'anthropic', minPlan: 'pro' },
  { id: 'zai-org/GLM-5.2', family: 'zai', minPlan: 'go' },
  { id: 'zai-org/GLM-5.2-Fast', family: 'zai', minPlan: 'go' },
  { id: 'moonshotai/Kimi-K3', family: 'moonshot', minPlan: 'go' },
  { id: 'moonshotai/Kimi-K2.7-Code', family: 'moonshot', minPlan: 'go' },
  { id: 'deepseek/deepseek-v4-pro', family: 'deepseek', minPlan: 'go' },
  { id: 'deepseek/deepseek-v4-flash', family: 'deepseek', minPlan: 'go' },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return MODEL_CATALOG.find((entry) => entry.id === id);
}

export function planAllowsModel(plan: PlanTier, model: string): boolean {
  const entry = catalogEntry(model);
  // Command Code plan hints are an admission-control policy. Sending an
  // unknown model to a subscription is indistinguishable from sending a model
  // above the plan: both consume a worker attempt before the provider can
  // reject it. Keep unknown entries out of routing until the catalog is
  // intentionally updated.
  if (!entry) return false;
  return PLAN_RANK[plan] >= PLAN_RANK[entry.minPlan];
}
