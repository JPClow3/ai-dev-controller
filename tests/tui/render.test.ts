import { describe, expect, it } from 'vitest';
import { buildSnapshot, type DashboardSnapshot } from '../../src/tui/snapshot.js';
import { renderDashboard } from '../../src/tui/render.js';
import type { ProvidersConfig } from '../../src/config/providers-schema.js';

const providers: ProvidersConfig = {
  providers: {
    chatgpt: {
      transport: 'codex-cli',
      displayName: 'ChatGPT',
      enabled: true,
      monthlyTokenLimit: null,
      bin: 'codex',
    },
    commandcode: {
      transport: 'command-code-cli',
      displayName: 'Command Code',
      enabled: true,
      monthlyTokenLimit: null,
      bin: 'cmd',
      plan: 'go',
    },
    zai: {
      transport: 'openai-compatible-http',
      displayName: 'Z.AI',
      enabled: true,
      monthlyTokenLimit: null,
      baseUrl: 'https://example.test/v4',
      apiKeyEnv: 'ZAI_API_KEY',
    },
    opencode: {
      transport: 'opencode-cli',
      displayName: 'OpenCode',
      enabled: false,
      monthlyTokenLimit: null,
      bin: 'opencode',
    },
    cline_pass: {
      transport: 'manual',
      displayName: 'Cline Pass',
      enabled: false,
      monthlyTokenLimit: null,
    },
  },
};

describe('renderDashboard', () => {
  it('renders providers and roles without throwing', () => {
    const snapshot: DashboardSnapshot = buildSnapshot({
      providerConfigs: providers.providers,
      probes: [
        { provider: 'commandcode', connected: true, authOk: true, detail: 'ok' },
        { provider: 'zai', connected: false, authOk: false, detail: 'missing ZAI_API_KEY' },
      ],
      pressures: {
        commandcode: { pressure: 'NORMAL', remainingAllowance: 0.5 },
        zai: { pressure: 'EXHAUSTED', remainingAllowance: 0 },
      },
      usage: [
        { provider: 'commandcode', calls: 2, inputTokens: 100, outputTokens: 200 },
        { provider: 'zai', calls: 0, inputTokens: 0, outputTokens: 0 },
      ],
      usageHistory: [{ day: '2026-08-18', provider: 'commandcode', tokens: 300 }],
      routing: {
        aliases: {
          luna_cc: { provider: 'commandcode' },
          glm_zai: { provider: 'zai' },
        },
        roles: {
          planning: { champion: 'luna_cc', challengers: ['glm_zai'] },
        },
      },
      now: () => new Date('2026-08-18T00:00:00Z'),
    });

    const out = renderDashboard(snapshot);
    expect(out).toContain('PROVIDERS');
    expect(out).toContain('Command Code');
    expect(out).toContain('ROLE ROUTING');
    expect(out).toContain('glm_zai(zai)');
  });
});
