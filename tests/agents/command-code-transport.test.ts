import { describe, expect, it } from 'vitest';
import { commandCodeTransport, lastResultFrame } from '../../src/agents/command-code-transport.js';
import { ProviderQuotaExhaustedError, ProviderUnavailableError } from '../../src/routing/quota.js';
import type { ModelAlias } from '../../src/config/routing-schema.js';

const alias: ModelAlias = {
  family: 'openai',
  harness: 'command-code',
  provider: 'commandcode',
  model: 'gpt-5.6-luna',
  reasoningEffort: 'medium',
  contextWindow: undefined,
  profile: undefined,
};

describe('commandCodeTransport', () => {
  it('parses the final result frame and returns usage', async () => {
    const transport = commandCodeTransport({
      bin: 'fake',
      run: async () => ({
        stdout:
          '{"type":"event"}\n{"type":"result","subtype":"success","usage":{"input":10,"output":20},"finalText":"{\\"ok\\":true}"}',
        stderr: '',
        exitCode: 0,
      }),
    });
    const result = await transport.complete({ alias, system: 's', user: 'u', timeoutMs: 1000 });
    expect(result.text).toBe('{"ok":true}');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it('maps exit 5 to quota exhaustion', async () => {
    const transport = commandCodeTransport({
      run: async () => ({ stdout: '', stderr: 'rate limit', exitCode: 5 }),
    });
    await expect(
      transport.complete({ alias, system: 's', user: 'u', timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(ProviderQuotaExhaustedError);
  });

  it('maps exit 10 to insufficient credits', async () => {
    const transport = commandCodeTransport({
      run: async () => ({ stdout: '', stderr: 'no credits', exitCode: 10 }),
    });
    await expect(
      transport.complete({ alias, system: 's', user: 'u', timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(ProviderQuotaExhaustedError);
  });

  it('extracts the last result frame from a mixed stream', () => {
    const frame = lastResultFrame('banner\n{"type":"event"}\nnot json\n{"type":"result","subtype":"success","finalText":"x"}');
    expect(frame?.finalText).toBe('x');
  });

  it('maps authentication failures to a provider cooldown signal', async () => {
    const transport = commandCodeTransport({
      run: async () => ({ stdout: '', stderr: 'login required', exitCode: 3 }),
    });
    await expect(
      transport.complete({ alias, system: 's', user: 'u', timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
