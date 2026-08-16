import { describe, expect, it, vi } from 'vitest';
import { createInvoker, extractJson } from '../../src/agents/invoke.js';
import { StructuredInvocationError, type StructuredTransport } from '../../src/agents/types.js';
import { loadControllerConfig } from '../../src/config/load-config.js';

const ROOT = process.cwd();
const routing = loadControllerConfig(ROOT).routing;

/** Replays scripted responses, so schema handling is testable without a live model. */
function scripted(responses: string[], provider: 'chatgpt' = 'chatgpt'): StructuredTransport {
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

  /**
   * Regression: `codex exec` prints a banner, echoes the reply, then prints a
   * token summary and the reply again. Slicing first `{` to last `}` spans
   * both objects plus the prose between them and never parses.
   */
  it('handles codex exec output that repeats the object', () => {
    const stdout = [
      'OpenAI Codex v0.144.6',
      '--------',
      'model: gpt-5.6-luna',
      '--------',
      'codex',
      '{"verdict":"approve"}',
      'tokens used',
      '11.080',
      '{"verdict":"approve"}',
    ].join('\n');
    expect(extractJson(stdout)).toEqual({ verdict: 'approve' });
  });

  it('takes the last complete object when several are present', () => {
    expect(extractJson('{"a":1}\nthen\n{"b":2}')).toEqual({ b: 2 });
  });

  it('is not confused by braces inside strings', () => {
    expect(extractJson('{"note":"a } brace","ok":true}')).toEqual({ note: 'a } brace', ok: true });
  });

  it('handles nested objects', () => {
    expect(extractJson('noise {"a":{"b":{"c":1}}} more')).toEqual({ a: { b: { c: 1 } } });
  });
});

describe('structured invocation', () => {
  it('returns validated data on a clean first response', async () => {
    const result = await invoker(scripted([validCuration])).structured({
      alias: 'luna_high',
      prompt: 'curator',
      input: 'raw issue text',
      schema: 'curated-issue',
    });

    expect(result.attempts).toBe(1);
    expect(result.alias).toBe('luna_high');
    expect((result.data as { issue_id: string }).issue_id).toBe('UNI-142');
    expect(result.usage?.outputTokens).toBe(20);
  });

  it('retries once when the model returns prose instead of JSON', async () => {
    const result = await invoker(scripted(['I think we should...', validCuration])).structured({
      alias: 'luna_high',
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
      alias: 'luna_high',
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
        alias: 'luna_high',
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
        alias: 'luna_high',
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
    const unsupportingTransport: StructuredTransport = {
      name: 'unsupported',
      supports: () => false,
      complete: vi.fn(),
    };
    await expect(
      createInvoker({
        rootDir: ROOT,
        routing,
        transports: [unsupportingTransport],
        readPrompt: () => 'SYSTEM PROMPT',
      }).structured({
        alias: 'luna_high',
        prompt: 'curator',
        input: 'x',
        schema: 'curated-issue',
      }),
    ).rejects.toThrow(/No transport supports provider "chatgpt"/);
  });
});

describe('transport selection', () => {
  it('routes aliases based on transport provider support', () => {
    const chatgptOnly = scripted([validCuration], 'chatgpt');
    expect(chatgptOnly.supports(routing.aliases['luna_high']!)).toBe(true);
    expect(chatgptOnly.supports(routing.aliases['sol_high']!)).toBe(true);
  });
});
