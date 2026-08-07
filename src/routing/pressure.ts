import type { Pressure } from '../types/index.js';
import { NotImplementedError } from '../util/errors.js';

/**
 * Subscription-aware scarcity, not fake dollar accounting.
 *
 * We pay flat-ish for ChatGPT Plus and Ollama Cloud Pro, so the router should
 * not pretend each token costs API money. It tracks how scarce a provider's
 * allowance currently is:
 *
 *   RESOURCE COST = provider quota consumed x current scarcity multiplier
 *
 * Effect: when Codex has been hammered, Luna's score drops and DeepSeek/Kimi
 * rise - load shifts to Ollama without anyone editing policy. The permanent
 * champion is unchanged; only today's route moves.
 *
 * v1 deliberately avoids fragile browser scraping. Sources are CLI rate-limit
 * headers, Orca usage reporting, observed failure rates, and manual override.
 */
export interface ProviderPressure {
  provider: string;
  pressure: Pressure;
  remainingAllowance: number | null;
  availableConcurrency: number | null;
  source: string;
  manualOverride: boolean;
}

export function current(): Record<string, ProviderPressure> {
  throw new NotImplementedError('pressure.current');
}

export function scarcityMultiplier(_provider: string): number {
  throw new NotImplementedError('pressure.scarcityMultiplier');
}

export function setManual(_provider: string, _pressure: Pressure): void {
  throw new NotImplementedError('pressure.setManual');
}

export async function refreshFromProviders(): Promise<void> {
  throw new NotImplementedError('pressure.refreshFromProviders');
}
