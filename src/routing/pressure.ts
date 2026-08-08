import type { RoutingConfig } from '../config/routing-schema.js';
import type { Pressure } from './types.js';

/**
 * Subscription-aware scarcity, not fake dollar accounting.
 *
 * Both providers are flat-rate, so a token does not cost API money — it costs
 * a share of a finite allowance. The router tracks how scarce that allowance
 * currently is and lets load drift to whichever family has room, without
 * anyone editing policy and without changing the stored champion.
 */
export interface ProviderPressure {
  provider: string;
  pressure: Pressure;
  remainingAllowance: number | null;
  source: string;
  manualOverride: boolean;
}

export type PressureMap = Record<string, ProviderPressure>;

export function defaultPressure(routing: RoutingConfig): PressureMap {
  const providers = new Set(Object.values(routing.aliases).map((a) => a.provider));
  const map: PressureMap = {};
  for (const provider of providers) {
    map[provider] = {
      provider,
      pressure: routing.pressure.default,
      remainingAllowance: null,
      source: 'default',
      manualOverride: false,
    };
  }
  return map;
}

export function scarcityMultiplier(routing: RoutingConfig, pressure: Pressure): number {
  return routing.pressure.scarcityMultiplier[pressure] ?? 1;
}

/**
 * Derives provider pressure from `orca account list --json`.
 *
 * Orca already reports real rate-limit windows, so no browser scraping is
 * needed — which the design explicitly wanted to avoid.
 */
export interface OrcaRateLimits {
  codex?: { weekly?: { usedPercent?: number } | null; session?: { usedPercent?: number } | null };
}

export function pressureFromOrca(rateLimits: OrcaRateLimits): Partial<PressureMap> {
  const used = rateLimits.codex?.weekly?.usedPercent ?? rateLimits.codex?.session?.usedPercent;
  if (used === undefined) return {};

  const pressure: Pressure =
    used >= 100 ? 'EXHAUSTED' : used >= 80 ? 'HIGH' : used >= 40 ? 'NORMAL' : 'LOW';

  return {
    chatgpt: {
      provider: 'chatgpt',
      pressure,
      remainingAllowance: Math.max(0, 100 - used) / 100,
      source: 'orca_account_rate_limits',
      manualOverride: false,
    },
  };
}

export function withOverride(map: PressureMap, provider: string, pressure: Pressure): PressureMap {
  return {
    ...map,
    [provider]: {
      provider,
      pressure,
      remainingAllowance: null,
      source: 'manual_override',
      manualOverride: true,
    },
  };
}

/** An EXHAUSTED provider is unusable, not merely expensive. */
export function isUsable(map: PressureMap, provider: string): boolean {
  return (map[provider]?.pressure ?? 'NORMAL') !== 'EXHAUSTED';
}
