import { describe, expect, it, vi } from 'vitest';
import { createInvoker, extractJson } from '../../src/agents/invoke.js';
import { StructuredInvocationError, type StructuredTransport } from '../../src/agents/types.js';
import { loadControllerConfig } from '../../src/config/load-config.js';

const ROOT = process.cwd();
const routing = loadControllerConfig(ROOT).routing;

/** Replays scripted responses, so schema handling is testable without a live model. */
function scripted(responses: string[], provider: 'ollama' | 'chatgpt' = 'ollama'): StructuredTransport {
  let call = 0;
  return {
    name: 'scripted',
    supports: (alias) => alias.provider === provider,
    complete: vi.fn(async () => {
      const text = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return { text, usage: { inputTokens: 10, outputTokens: 20 } };
    }),
  };
}

const validCuration = JSON.stringify({
  verdict: 'curated',
  issue_id: 'UNI-142',
  repository: 'lorebound',
  title: 'Add filtering to the risk map',
  body: '# Goal\n...',
  task_category: 'routine_behavior',
  risk: 'medium',
  acceptance_criteria: [{ id: 'AC-1', statement: 'Filtering narrows the result set.' }],
});

function invoker(transport: StructuredTransport) {
  return createInvoker({
    rootDir: ROOT,
    routing,
    transports: [transport],
    readPrompt: () => 'SYSTEM PROMPT',
  });
}

describe('extractJson', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('unwraps a fenced block', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```\nhope that helps')).toEqual({ a: 1 });
  });

  it('recovers an object surrounded by prose', () => {
    expect(extractJson('Here you go: {"a":1} - done')).toEqual({ a: 1 });
  });

  it('throws when there is no object at all', () => {
    expect(() => extractJson('I cannot help with that')).toThrow(/no JSON object/);
  });
});

describe('structured invocation', () => {
  it('returns validated data on a clean first response', async () => {
    const result = await invoker(scripted([validCuration])).structured({
      alias: 'deepseek_flash',
      prompt: 'curator',
      input: 'raw issue text',
      schema: 'curated-issue',
    });

    expect(result.attempts).toBe(1);
    expect(result.alias).toBe('deepseek_flash');
    expect((result.data as { issue_id: string }).issue_id).toBe('UNI-142');
    expect(result.usage?.outputTokens).toBe(20);
  });

  it('retries once when the model returns prose instead of JSON', async () => {
    const result = await invoker(scripted(['I think we should...', validCuration])).structured({
      alias: 'deepseek_flash',
      prompt: 'curator',
      input: 'raw issue',
      schema: 'curated-issue',
    });
    expect(result.attempts).toBe(2);
  });

  it('retries with the validation errors when the schema is not satisfied', async () => {
    const incomplete = JSON.stringify({ verdict: 'curated', issue_id: 'UNI-1' });
    const transport = scripted([incomplete, validCuration]);
    const result = await invoker(transport).structured({
      alias: 'deepseek_flash',
      prompt: 'curator',
      input: 'raw issue',
      schema: 'curated-issue',
    });

    expect(result.attempts).toBe(2);
    const second = (transport.complete as ReturnType<typeof vi.fn>).mock.calls[1]![0] as { user: string };
    expect(second.user).toMatch(/did not satisfy the required schema/);
  });

  it('gives up rather than grinding, and reports every failure', async () => {
    const junk = JSON.stringify({ verdict: 'curated', issue_id: 'UNI-1' });
    await expect(
      invoker(scripted([junk])).structured({
        alias: 'deepseek_flash',
        prompt: 'curator',
        input: 'raw issue',
        schema: 'curated-issue',
        maxAttempts: 2,
      }),
    ).rejects.toThrow(StructuredInvocationError);
  });

  it('never returns data that failed schema validation', async () => {
    // A needs_context verdict without the needs_context block is invalid and
    // must not reach the controller as if it were usable.
    const bad = JSON.stringify({ verdict: 'needs_context', issue_id: 'UNI-1' });
    await expect(
      invoker(scripted([bad])).structured({
        alias: 'deepseek_flash',
        prompt: 'curator',
        input: 'x',
        schema: 'curated-issue',
        maxAttempts: 1,
      }),
    ).rejects.toThrow(StructuredInvocationError);
  });

  it('rejects an unknown alias before making any call', async () => {
    await expect(
      invoker(scripted([validCuration])).structured({
        alias: 'not_a_real_alias',
        prompt: 'curator',
        input: 'x',
        schema: 'curated-issue',
      }),
    ).rejects.toThrow(/Unknown routing alias/);
  });

  it('refuses when no transport supports the alias provider', async () => {
    await expect(
      invoker(scripted([validCuration], 'ollama')).structured({
        alias: 'luna_high',
        prompt: 'curator',
        input: 'x',
        schema: 'curated-issue',
      }),
    ).rejects.toThrow(/No transport supports provider "chatgpt"/);
  });
});

describe('transport selection', () => {
  it('routes ollama and chatgpt aliases to different transports', () => {
    const ollamaOnly = scripted([validCuration], 'ollama');
    const codexOnly = scripted([validCuration], 'chatgpt');
    expect(ollamaOnly.supports(routing.aliases['deepseek_flash']!)).toBe(true);
    expect(ollamaOnly.supports(routing.aliases['luna_high']!)).toBe(false);
    expect(codexOnly.supports(routing.aliases['luna_high']!)).toBe(true);
    expect(codexOnly.supports(routing.aliases['glm_5_2']!)).toBe(false);
  });
});
