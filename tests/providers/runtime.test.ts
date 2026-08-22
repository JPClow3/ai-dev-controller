import { describe, expect, it } from 'vitest';
import { loadControllerConfig } from '../../src/config/load-config.js';
import { buildTransports } from '../../src/agents/transports.js';
import { buildProviderEligibility } from '../../src/providers/runtime.js';
import { defaultPressure, withOverride } from '../../src/routing/pressure.js';
import { selectModel } from '../../src/routing/selector.js';

const config = loadControllerConfig(process.cwd());

describe('provider runtime eligibility', () => {
  it('honours Command Code environment overrides and rejects ambiguous cmd', () => {
    const override = buildTransports({
      providers: config.providers,
      env: { COMMAND_CODE_BIN: 'command-code', COMMAND_CODE_PLAN: 'pro', ZAI_API_KEY: 'key' },
    });
    expect(override.transports.some((transport) => transport.name === 'command-code-cli')).toBe(true);

    const ambiguous = buildTransports({
      providers: config.providers,
      env: { COMMAND_CODE_BIN: 'cmd', ZAI_API_KEY: 'key' },
    });
    expect(ambiguous.unavailable.commandcode).toMatch(/cannot be bare "cmd"/);
  });

  it('excludes missing credentials and models above the Command Code plan', () => {
    const built = buildTransports({ providers: config.providers, env: {} });
    const eligibility = buildProviderEligibility({
      providers: config.providers,
      routing: config.routing,
      pressure: defaultPressure(config.routing),
      unavailableTransports: built.unavailable,
      env: {},
    });

    expect(eligibility.providers.zai).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/ZAI_API_KEY/) });
    expect(eligibility.aliases.luna_cc).toMatchObject({ eligible: true, state: 'ready' });
    expect(eligibility.aliases.sol_cc).toMatchObject({ eligible: false, state: 'plan_blocked' });
  });

  it('routes around an unavailable provider and fails closed when no alias remains', () => {
    const pressure = withOverride(defaultPressure(config.routing), 'chatgpt', 'EXHAUSTED');
    const eligibility = buildProviderEligibility({
      providers: config.providers,
      routing: config.routing,
      pressure,
      unavailableTransports: { zai: 'missing ZAI_API_KEY' },
      env: { COMMAND_CODE_PLAN: 'go' },
    });
    const deps = {
      routing: config.routing,
      scoring: config.scoring,
      pressure,
      eligibility,
      stats: () => null,
      random: () => 0.99,
    };

    expect(selectModel({ projectId: 'portfolio', role: 'routine_bugfix', risk: 'low' }, deps).alias).toBe('luna_cc');
    expect(() => selectModel({ projectId: 'portfolio', role: 'high_risk', risk: 'high' }, deps)).toThrow(/No eligible model/);
  });

  it('returns a provider to routing after a successful due health probe', () => {
    const eligibility = buildProviderEligibility({
      providers: config.providers,
      routing: config.routing,
      pressure: defaultPressure(config.routing),
      persisted: [{
        provider: 'zai',
        state: 'unavailable',
        auth: 'failed',
        reason: 'temporary network failure',
        nextProbeAt: '2026-09-01T00:00:00.000Z',
      }],
      probes: [{ provider: 'zai', connected: true, authOk: false, detail: 'ZAI_API_KEY configured' }],
    });
    expect(eligibility.providers.zai).toMatchObject({ state: 'ready', auth: 'unknown' });
    expect(eligibility.aliases.glm_zai).toMatchObject({ eligible: true });
  });
});
