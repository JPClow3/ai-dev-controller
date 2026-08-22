import { describe, expect, it, vi } from 'vitest';
import {
  applyProviderUnavailableCooldown,
  applyQuotaCooldown,
  ProviderUnavailableError,
  ProviderQuotaExhaustedError,
  QUOTA_RECHECK_INTERVAL_MS,
  quotaResetAtFromOutput,
  refreshRuntimePressure,
} from '../../src/routing/quota.js';
import { defaultPressure } from '../../src/routing/pressure.js';
import { loadControllerConfig } from '../../src/config/load-config.js';

const routing = loadControllerConfig(process.cwd()).routing;

describe('Codex quota exhaustion', () => {
  it('extracts the provider reset time from Codex CLI output', () => {
    const resetAt = quotaResetAtFromOutput(
      "You've hit your usage limit. Purchase more credits or try again at Aug 15th, 2026 7:14 PM.",
    );

    expect(resetAt).not.toBeNull();
    expect(resetAt?.getFullYear()).toBe(2026);
    expect(resetAt?.getMonth()).toBe(7);
    expect(resetAt?.getDate()).toBe(15);
    expect(resetAt?.getHours()).toBe(19);
    expect(resetAt?.getMinutes()).toBe(14);
  });

  it('keeps provider and reset metadata on the typed error', () => {
    const resetAt = new Date('2026-08-15T22:14:00.000Z');
    const error = new ProviderQuotaExhaustedError('chatgpt', resetAt, 'gpt-terra-high');

    expect(error.provider).toBe('chatgpt');
    expect(error.resetAt).toEqual(resetAt);
    expect(error.message).toContain('gpt-terra-high');
  });

  it('persists a bounded cooldown and immediately removes the provider from routing', () => {
    const pressure = defaultPressure(routing);
    const setProviderPressure = vi.fn();
    const resetAt = new Date('2026-08-15T22:14:00.000Z');
    const now = new Date('2026-08-09T02:40:00.000Z');

    applyQuotaCooldown(
      { setProviderPressure },
      pressure,
      new ProviderQuotaExhaustedError('chatgpt', resetAt, 'reviewers'),
      now,
    );

    expect(pressure['chatgpt']).toMatchObject({
      pressure: 'EXHAUSTED',
      source: 'transport_quota',
      remainingAllowance: 0,
    });
    expect(setProviderPressure).toHaveBeenCalledWith(
      'chatgpt',
      expect.objectContaining({
        resetAt: new Date(now.getTime() + QUOTA_RECHECK_INTERVAL_MS).toISOString(),
      }),
    );
  });

  it('honours a provider reset that occurs before the periodic recheck', () => {
    const pressure = defaultPressure(routing);
    const setProviderPressure = vi.fn();
    const now = new Date('2026-08-09T02:40:00.000Z');
    const resetAt = new Date(now.getTime() + 5 * 60_000);

    const retryAt = applyQuotaCooldown(
      { setProviderPressure },
      pressure,
      new ProviderQuotaExhaustedError('chatgpt', resetAt, 'reviewers'),
      now,
    );

    expect(retryAt).toEqual(resetAt);
    expect(setProviderPressure).toHaveBeenCalledWith(
      'chatgpt',
      expect.objectContaining({ resetAt: resetAt.toISOString() }),
    );
  });

  it('persists a short cooldown for provider authentication or transport failures', () => {
    const pressure = defaultPressure(routing);
    const setProviderPressure = vi.fn();
    const now = new Date('2026-08-09T02:40:00.000Z');
    const retryAt = applyProviderUnavailableCooldown(
      { setProviderPressure },
      pressure,
      new ProviderUnavailableError('zai', 'HTTP 401', 60_000),
      now,
    );

    expect(retryAt).toEqual(new Date('2026-08-09T02:41:00.000Z'));
    expect(pressure.zai).toMatchObject({ pressure: 'EXHAUSTED', source: 'transport_unavailable' });
  });

  it('restores a fresh map from durable cooldowns after a restart', () => {
    const pressure = defaultPressure(routing);
    refreshRuntimePressure(pressure, routing, [
      {
        provider: 'chatgpt',
        pressure: 'EXHAUSTED',
        remainingAllowance: 0,
        source: 'transport_quota',
        manualOverride: false,
        resetAt: '2026-08-15T22:14:00.000Z',
      },
    ], ['disabled_provider']);

    expect(pressure['chatgpt']?.pressure).toBe('EXHAUSTED');
    expect(pressure['disabled_provider']?.pressure).toBe('EXHAUSTED');
  });
});
