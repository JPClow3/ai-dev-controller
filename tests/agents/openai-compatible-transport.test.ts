import { describe, expect, it } from 'vitest';
import { openAiCompatibleTransport } from '../../src/agents/openai-compatible-transport.js';
import { ProviderQuotaExhaustedError, ProviderUnavailableError } from '../../src/routing/quota.js';
import type { ModelAlias } from '../../src/config/routing-schema.js';
import type { FetchLike } from '../../src/agents/openai-compatible-transport.js';

const alias: ModelAlias = {
  family: 'zai',
  harness: 'http',
  provider: 'zai',
  model: 'glm-5.3',
  reasoningEffort: 'high',
  contextWindow: undefined,
  profile: undefined,
};

function fetchWith(status: number, body: string): FetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
}

describe('openAiCompatibleTransport', () => {
  it('returns content and token usage on success', async () => {
    const transport = openAiCompatibleTransport({
      provider: 'zai',
      baseUrl: 'https://example.test/v4',
      apiKey: 'k',
      fetch: fetchWith(
        200,
        JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }),
      ),
    });
    const result = await transport.complete({ alias, system: 's', user: 'u', timeoutMs: 1000 });
    expect(result.text).toBe('{"ok":true}');
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it('maps 429 to quota exhaustion', async () => {
    const transport = openAiCompatibleTransport({
      provider: 'zai',
      baseUrl: 'https://example.test/v4',
      apiKey: 'k',
      fetch: fetchWith(429, '{"message":"rate limited"}'),
    });
    await expect(
      transport.complete({ alias, system: 's', user: 'u', timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(ProviderQuotaExhaustedError);
  });

  it('maps insufficient balance body to quota exhaustion', async () => {
    const transport = openAiCompatibleTransport({
      provider: 'zai',
      baseUrl: 'https://example.test/v4',
      apiKey: 'k',
      fetch: fetchWith(402, '{"message":"insufficient balance"}'),
    });
    await expect(
      transport.complete({ alias, system: 's', user: 'u', timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(ProviderQuotaExhaustedError);
  });

  it('maps authentication failures to a provider cooldown signal', async () => {
    const transport = openAiCompatibleTransport({
      provider: 'zai',
      baseUrl: 'https://example.test/v4',
      apiKey: 'k',
      fetch: fetchWith(401, '{"message":"invalid key"}'),
    });
    await expect(
      transport.complete({ alias, system: 's', user: 'u', timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
