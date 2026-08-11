import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ROLES, createAgents, reviewerCandidates } from '../../src/agents/roles.js';
import { loadControllerConfig } from '../../src/config/load-config.js';
import type { Invoker } from '../../src/agents/invoke.js';
import { ProviderQuotaExhaustedError } from '../../src/routing/quota.js';

const ROOT = process.cwd();
const config = loadControllerConfig(ROOT);

function fakeInvoker() {
  const structured = vi.fn(async (req: {
    alias: string;
    prompt: string;
    schema: string;
    timeoutMs?: number;
    maxAttempts?: number;
  }) => ({
    data: { ok: true, ...req },
    alias: req.alias,
    attempts: 1,
    wallClockMs: 1,
    raw: '{}',
  }));
  return { invoker: { structured } as unknown as Invoker, structured };
}

/**
 * These bind prompt files, schema files and routing roles by string. A typo in
 * any of the three is invisible until the moment that agent runs, which would
 * be mid-issue.
 */
describe('every agent role points at things that exist', () => {
  it('names a prompt file that is on disk', () => {
    for (const [role, spec] of Object.entries(AGENT_ROLES)) {
      expect(existsSync(join(ROOT, 'prompts', `${spec.prompt}.md`)), `${role} -> ${spec.prompt}.md`).toBe(true);
    }
  });

  it('names a schema file that is on disk', () => {
    for (const [role, spec] of Object.entries(AGENT_ROLES)) {
      expect(
        existsSync(join(ROOT, 'schemas', `${spec.schema}.schema.json`)),
        `${role} -> ${spec.schema}.schema.json`,
      ).toBe(true);
    }
  });

  it('names a routing role declared in routing.yaml', () => {
    for (const [role, spec] of Object.entries(AGENT_ROLES)) {
      expect(config.routing.roles[spec.routingRole], `${role} -> ${spec.routingRole}`).toBeDefined();
    }
  });

  it('covers the pipeline stages that actually call a model', () => {
    expect(Object.keys(AGENT_ROLES).sort()).toEqual([
      'classifier',
      'curator',
      'finalReviewer',
      'integrationReviewer',
      'planner',
    ]);
  });
});

describe('agent calls', () => {
  it('sends the right prompt and schema for each role', async () => {
    const { invoker, structured } = fakeInvoker();
    const agents = createAgents(invoker, config.routing);

    await agents.curate('deepseek_flash', 'raw issue');
    expect(structured.mock.calls[0]![0]).toMatchObject({
      alias: 'deepseek_flash',
      prompt: 'curator',
      schema: 'curated-issue',
    });

    await agents.plan('terra_high', 'contract');
    expect(structured.mock.calls[1]![0]).toMatchObject({
      prompt: 'planner',
      schema: 'implementation-plan',
    });

    await agents.classifyFailure('deepseek_flash', 'evidence');
    expect(structured.mock.calls[2]![0]).toMatchObject({ prompt: 'failure-classifier', schema: 'failure' });
  });

  it('gives planning and review a longer budget than curation', async () => {
    const { invoker, structured } = fakeInvoker();
    const agents = createAgents(invoker, config.routing);

    await agents.curate('deepseek_flash', 'x');
    await agents.plan('terra_high', 'x');

    expect(structured.mock.calls[0]![0].timeoutMs).toBeUndefined();
    expect(structured.mock.calls[1]![0].timeoutMs).toBe(300_000);
  });
});

describe('final review independence', () => {
  it('picks a Sol reviewer outside the Luna/Terra implementation tier', async () => {
    const { invoker } = fakeInvoker();
    const agents = createAgents(invoker, config.routing);

    const { alias } = await agents.reviewFinal(
      { byFamily: { openai: 500, deepseek: 10 } },
      reviewerCandidates(config.routing),
      'packet',
    );
    expect(config.routing.aliases[alias]!.model).toBe('gpt-5.6-sol');
  });

  it('draws final-review candidates only from orchestrator and high-risk tiers', () => {
    const candidates = reviewerCandidates(config.routing);
    expect(candidates.length).toBeGreaterThan(0);
    for (const alias of candidates) expect(config.routing.aliases[alias]).toBeDefined();
    // local_smoke is not referenced by any role, so it must never review.
    expect(candidates).not.toContain('local_smoke');
    expect(candidates).toEqual(['sol_high', 'sol_medium', 'sol_xhigh']);
  });

  it('falls back to another eligible alias when one reviewer profile exhausts quota', async () => {
    const structured = vi.fn(async (request: { alias: string }) => {
      if (request.alias === 'luna_low') throw new Error('Codex quota exhausted for profile gpt-luna-low');
      return { data: { verdict: 'approve' }, alias: request.alias, attempts: 1, wallClockMs: 1, raw: '{}' };
    });
    const agents = createAgents({ structured } as unknown as Invoker, config.routing);

    const result = await agents.reviewFinal(
      { byFamily: { openai: 1 } },
      ['luna_low', 'terra_high'],
      'packet',
    );

    expect(result.alias).toBe('terra_high');
    expect(structured.mock.calls.map((call) => call[0].alias)).toEqual(['luna_low', 'terra_high']);
  });

  it('preserves a shared provider cooldown when every reviewer exhausts quota', async () => {
    const resetAt = new Date('2026-08-15T22:14:00.000Z');
    const structured = vi.fn(async (request: { alias: string }) => {
      throw new ProviderQuotaExhaustedError('chatgpt', resetAt, request.alias);
    });
    const agents = createAgents({ structured } as unknown as Invoker, config.routing);

    await expect(
      agents.reviewFinal(
        { byFamily: { openai: 1 } },
        ['luna_low', 'terra_high'],
        'packet',
      ),
    ).rejects.toMatchObject({
      name: 'ProviderQuotaExhaustedError',
      provider: 'chatgpt',
      resetAt,
    });
    expect(structured).toHaveBeenCalledOnce();
  });
});
