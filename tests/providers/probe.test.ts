import { describe, expect, it } from 'vitest';
import { probeProviders } from '../../src/providers/probe.js';
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
      bin: 'cc',
      plan: 'go',
    },
    zai: {
      transport: 'openai-compatible-http',
      displayName: 'Z.AI',
      enabled: true,
      monthlyTokenLimit: null,
      baseUrl: 'https://api.z.ai/api/paas/v4',
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

describe('probeProviders', () => {
  it('reports disabled providers and missing HTTP keys', async () => {
    const results = await probeProviders({
      providers,
      env: {},
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });
    const opencode = results.find((r) => r.provider === 'opencode');
    const cline = results.find((r) => r.provider === 'cline_pass');
    const zai = results.find((r) => r.provider === 'zai');
    expect(opencode?.connected).toBe(false);
    expect(cline?.connected).toBe(false);
    expect(zai?.connected).toBe(false);
    expect(zai?.detail).toContain('missing ZAI_API_KEY');
  });

  it('reports configured HTTP key as connected without auth proof', async () => {
    const results = await probeProviders({
      providers,
      env: { ZAI_API_KEY: 'secret' },
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });
    const zai = results.find((r) => r.provider === 'zai');
    expect(zai?.connected).toBe(true);
    expect(zai?.authOk).toBe(false);
  });
});
