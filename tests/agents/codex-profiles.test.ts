import { afterEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { codexTransport } from '../../src/agents/codex-profiles.js';
import type { ModelAlias } from '../../src/config/routing-schema.js';

vi.mock('execa', () => ({ execa: vi.fn() }));
const run = vi.mocked(execa);
const alias = { provider: 'chatgpt', profile: 'gpt-luna-low' } as ModelAlias;

afterEach(() => vi.clearAllMocks());

describe('Codex CLI transport', () => {
  it('uses stdin and the output file rather than scraping a noisy CLI transcript', async () => {
    run.mockImplementation((async (_bin: string, args: string[]) => {
      const path = args[args.indexOf('--output-last-message') + 1] as string;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, '{"verdict":"approve"}', 'utf8');
      return { stdout: 'tokens used\n11,080' } as never;
    }) as never);
    const result = await codexTransport('codex-test').complete({
      alias, system: 'system', user: 'user', timeoutMs: 1000, schema: { type: 'object' },
    });
    expect(result).toEqual({ text: '{"verdict":"approve"}', usage: { outputTokens: 11080 } });
    expect(run).toHaveBeenCalledWith('codex-test', expect.arrayContaining(['-', '--output-schema']), expect.objectContaining({ input: 'system\n\n---\n\nuser' }));
  });

  it('classifies quota output as an exhausted provider', async () => {
    run.mockRejectedValue({ stderr: 'HTTP 429 rate limit', stdout: '' });
    await expect(codexTransport().complete({ alias, system: '', user: '', timeoutMs: 1 })).rejects.toMatchObject({ name: 'ProviderQuotaExhaustedError' });
  });
});
