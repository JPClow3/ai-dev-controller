/** A provider-level cooldown that callers can persist and route around. */
export class ProviderQuotaExhaustedError extends Error {
  override readonly name = 'ProviderQuotaExhaustedError';

  constructor(
    readonly provider: string,
    readonly resetAt: Date | null,
    detail: string,
  ) {
    super(
      `${provider} quota exhausted (${detail})` +
        (resetAt ? `; retry after ${resetAt.toISOString()}` : ''),
    );
  }
}

/**
 * Codex reports a human-readable local timestamp, for example
 * "try again at Aug 15th, 2026 7:14 PM". Normalise the ordinal before asking
 * the platform parser to interpret it in the controller's local timezone.
 */
export function quotaResetAtFromOutput(output: string): Date | null {
  const match = /try again at\s+([^\r\n]+)/i.exec(output);
  if (!match?.[1]) return null;
  const normalised = match[1]
    .replace(/(\d{1,2})(st|nd|rd|th)\b/i, '$1')
    .replace(/[.\s]+$/, '');
  const millis = Date.parse(normalised);
  return Number.isFinite(millis) ? new Date(millis) : null;
}

export function isProviderQuotaExhausted(error: unknown): error is ProviderQuotaExhaustedError {
  return error instanceof ProviderQuotaExhaustedError;
}

/** Persist and activate a transport refusal before the next scheduler tick. */
export function applyQuotaCooldown(
  store: ProviderPressureStore,
  pressure: PressureMap,
  error: ProviderQuotaExhaustedError,
  now = new Date(),
): Date {
  const reported = error.resetAt;
  // A provider that omits its reset must still avoid a 45-second hot loop.
  const resetAt = reported && reported.getTime() > now.getTime()
    ? reported
    : new Date(now.getTime() + 15 * 60_000);
  const value = {
    pressure: 'EXHAUSTED' as const,
    remainingAllowance: 0,
    source: 'transport_quota',
    manualOverride: false,
    resetAt: resetAt.toISOString(),
  };
  store.setProviderPressure(error.provider, value);
  pressure[error.provider] = { provider: error.provider, ...value };
  return resetAt;
}

/**
 * Rebuild the shared mutable pressure map in-place so every selector sees
 * durable cooldowns, including after a process restart.
 */
export function refreshRuntimePressure(
  target: PressureMap,
  routing: RoutingConfig,
  persisted: PersistedProviderPressure[],
  disabled: string[],
  observed: Partial<PressureMap> = {},
): PressureMap {
  const fresh = { ...defaultPressure(routing), ...observed };
  for (const entry of persisted) fresh[entry.provider] = { ...entry };
  for (const provider of disabled) {
    fresh[provider] = {
      provider,
      pressure: 'EXHAUSTED',
      remainingAllowance: null,
      source: 'manual_override',
      manualOverride: true,
    };
  }
  for (const provider of Object.keys(target)) delete target[provider];
  Object.assign(target, fresh);
  return target;
}
import type { RoutingConfig } from '../config/routing-schema.js';
import { defaultPressure } from './pressure.js';
import type { PressureMap, ProviderPressure } from './pressure.js';

export interface PersistedProviderPressure extends ProviderPressure {
  resetAt: string | null;
}

interface ProviderPressureStore {
  setProviderPressure(
    provider: string,
    value: Omit<PersistedProviderPressure, 'provider'>,
  ): void;
}
