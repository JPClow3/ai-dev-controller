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
export interface OrcaRateLimitWindow {
  usedPercent?: number;
  /** Epoch milliseconds. A reading past its own reset describes a spent window. */
  resetsAt?: number | null;
}

export interface OrcaRateLimits {
  codex?: {
    weekly?: OrcaRateLimitWindow | null;
    session?: OrcaRateLimitWindow | null;
  };
}

/**
 * Orca caches its last reading, so a window can be reported at 100% long after
 * it reset. Taking that at face value declared the only usable provider
 * EXHAUSTED and throttled the whole controller against a quota that had
 * already refilled — an expired reading carries no information, so it is
 * dropped rather than believed.
 */
export function pressureFromOrca(rateLimits: OrcaRateLimits, now = Date.now()): Partial<PressureMap> {
  const fresh = (window: OrcaRateLimitWindow | null | undefined): number | undefined => {
    if (!window || window.usedPercent === undefined) return undefined;
    if (window.resetsAt != null && window.resetsAt <= now) return undefined;
    return window.usedPercent;
  };

  const used = fresh(rateLimits.codex?.weekly) ?? fresh(rateLimits.codex?.session);
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
