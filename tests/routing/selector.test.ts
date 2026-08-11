import { describe, expect, it } from 'vitest';
import { selectModel, selectReviewer, authorshipByFamily } from '../../src/routing/selector.js';
import { nextEscalation } from '../../src/routing/escalation.js';
import { defaultPressure, pressureFromOrca, withOverride } from '../../src/routing/pressure.js';
import { loadControllerConfig } from '../../src/config/load-config.js';
import { isHumanBlock, type AliasStats } from '../../src/routing/types.js';
import { forcePilotAlias } from '../../src/routing/forced.js';

const config = loadControllerConfig(process.cwd());
const { routing, scoring, escalation } = config;

function deps(overrides: Partial<Parameters<typeof selectModel>[1]> = {}) {
  return {
    routing,
    scoring,
    pressure: defaultPressure(routing),
    stats: () => null as AliasStats | null,
    random: () => 0.99, // above exploration_rate, so no experiment by default
    ...overrides,
  };
}

describe('selectModel', () => {
  it('a pilot alias override preserves every role referenced by a safety lock', () => {
    const forced = forcePilotAlias(routing, 'luna_low');
    expect(forced.roles['routine_bugfix']!.champion).toBe('luna_low');
    expect(forced.roles['high_risk']).toEqual(routing.roles['high_risk']);
  });

  it('picks the configured champion when there is no evidence yet', () => {
    const d = selectModel({ projectId: 'lorebound', role: 'routine_bugfix', risk: 'low' }, deps());
    expect(d.alias).toBe('luna_high');
    expect(d.reason).toBe('champion');
    expect(d.isChallenger).toBe(false);
  });

  it('explores a challenger at the configured rate on low-risk work', () => {
    const d = selectModel(
      { projectId: 'lorebound', role: 'routine_bugfix', risk: 'low' },
      deps({ random: () => 0.01 }),
    );
    expect(d.isChallenger).toBe(true);
    expect(d.alias).toBe('luna_medium');
  });

  it('never experiments on medium risk', () => {
    const d = selectModel(
      { projectId: 'lorebound', role: 'routine_bugfix', risk: 'medium' },
      deps({ random: () => 0.01 }),
    );
    expect(d.isChallenger).toBe(false);
  });

  it('locks high risk to the high_risk role, ignoring the requested role', () => {
    const d = selectModel(
      { projectId: 'lorebound', role: 'routine_bugfix', risk: 'high' },
      deps({ random: () => 0.01 }),
    );
    expect(d.alias).toBe('sol_xhigh');
    expect(d.reason).toBe('locked_high_risk');
    expect(d.isChallenger).toBe(false);
  });

  it('fails closed when the provider for the locked high-risk role is exhausted', () => {
    const pressure = withOverride(defaultPressure(routing), 'chatgpt', 'EXHAUSTED');
    expect(() =>
      selectModel(
        { projectId: 'lorebound', role: 'routine_bugfix', risk: 'high' },
        deps({ pressure }),
      ),
    ).toThrow(/No eligible model for role "high_risk"/);
  });

  it('does not re-select an excluded alias through the high-risk lock', () => {
    expect(() =>
      selectModel(
        {
          projectId: 'lorebound',
          role: 'routine_bugfix',
          risk: 'high',
          excludeAliases: ['sol_xhigh'],
        },
        deps(),
      ),
    ).toThrow(/already attempted on this task/);
  });

  /**
   * The behaviour the design asks for: pressure moves today's route without
   * touching the stored champion.
   */
  it('fails closed when the OpenAI provider is exhausted without changing the champion', () => {
    const pressure = withOverride(defaultPressure(routing), 'chatgpt', 'EXHAUSTED');
    expect(() =>
      selectModel({ projectId: 'lorebound', role: 'routine_bugfix', risk: 'low' }, deps({ pressure })),
    ).toThrow(/No eligible model/);
    expect(routing.roles['routine_bugfix']!.champion).toBe('luna_high');
  });

  it('does not count a forced substitution as a challenger experiment', () => {
    const d = selectModel(
      { projectId: 'lorebound', role: 'routine_bugfix', risk: 'low', excludeAliases: ['luna_high'] },
      deps({ random: () => 0.01 }),
    );
    expect(d.isChallenger).toBe(false);
    expect(d.alias).toBe('luna_medium');
  });

  it('uses Terra as the large-context worker', () => {
    const d = selectModel(
      { projectId: 'lorebound', role: 'large_context', risk: 'low', contextEstimate: 900_000 },
      deps(),
    );
    expect(d.alias).toBe('terra_high');
  });

  it('will not re-select an alias already tried on this task', () => {
    const d = selectModel(
      { projectId: 'lorebound', role: 'routine_bugfix', risk: 'low', excludeAliases: ['luna_high'] },
      deps(),
    );
    expect(d.alias).not.toBe('luna_high');
  });

  it('throws rather than silently running nothing when every candidate is out', () => {
    let pressure = withOverride(defaultPressure(routing), 'chatgpt', 'EXHAUSTED');
    pressure = withOverride(pressure, 'ollama', 'EXHAUSTED');
    expect(() =>
      selectModel({ projectId: 'lorebound', role: 'routine_bugfix', risk: 'low' }, deps({ pressure })),
    ).toThrow(/No eligible model/);
  });

  it('prefers a better-scoring challenger once evidence exists', () => {
    const stats = (_p: string, _r: string, alias: string): AliasStats | null =>
      alias === 'luna_xhigh'
        ? { samples: 20, compositeAvg: 0.9, successRate: 0.9, medianMinutes: 10 }
        : { samples: 20, compositeAvg: 0.4, successRate: 0.5, medianMinutes: 10 };

    const d = selectModel({ projectId: 'lorebound', role: 'routine_bugfix', risk: 'low' }, deps({ stats }));
    expect(d.alias).toBe('luna_xhigh');
  });
});

describe('provider pressure from Orca', () => {
  it('reads a real exhausted quota', () => {
    const p = pressureFromOrca({ codex: { weekly: { usedPercent: 100 } } });
    expect(p['chatgpt']?.pressure).toBe('EXHAUSTED');
    expect(p['chatgpt']?.source).toBe('orca_account_rate_limits');
  });

  it('maps usage bands', () => {
    expect(pressureFromOrca({ codex: { weekly: { usedPercent: 10 } } })['chatgpt']?.pressure).toBe('LOW');
    expect(pressureFromOrca({ codex: { weekly: { usedPercent: 50 } } })['chatgpt']?.pressure).toBe('NORMAL');
    expect(pressureFromOrca({ codex: { weekly: { usedPercent: 85 } } })['chatgpt']?.pressure).toBe('HIGH');
  });

  it('reports nothing rather than guessing when Orca has no data', () => {
    expect(pressureFromOrca({})).toEqual({});
  });
});

describe('reviewer independence', () => {
  it('keeps a GPT-dominant implementation away from a GPT reviewer', () => {
    const authorship = authorshipByFamily(
      [
        { alias: 'luna_high', changedLines: 300 },
        { alias: 'terra_high', changedLines: 100 },
        { alias: 'deepseek_flash', changedLines: 20 },
      ],
      routing,
    );
    const reviewer = selectReviewer(
      authorship,
      ['glm_5_2', 'terra_high', 'luna_high'],
      routing,
      'least_involved_family',
    );
    expect(routing.aliases[reviewer]!.family).not.toBe('openai');
    expect(reviewer).toBe('glm_5_2');
  });

  it('sends an Ollama-dominant implementation to a GPT reviewer', () => {
    const authorship = authorshipByFamily(
      [
        { alias: 'deepseek_flash', changedLines: 400 },
        { alias: 'kimi_code', changedLines: 200 },
      ],
      routing,
    );
    const reviewer = selectReviewer(
      authorship,
      ['terra_high', 'kimi_code', 'deepseek_flash'],
      routing,
      'least_involved_family',
    );
    expect(routing.aliases[reviewer]!.family).toBe('openai');
  });
});

describe('nextEscalation', () => {
  const base = {
    projectId: 'lorebound',
    role: 'routine_bugfix',
    risk: 'low' as const,
    previousAliases: ['luna_high'],
    budget: { sameModelRepairs: 0, workerEscalations: 0, reviewRemediationCycles: 0, solAdjudications: 0 },
  };

  const escDeps = { ...deps(), escalation };

  it('gives a mechanical failure one repair with the same model', () => {
    const d = nextEscalation({ ...base, failureClass: 'mechanical' }, escDeps);
    expect(isHumanBlock(d)).toBe(false);
    if (!isHumanBlock(d)) expect(d.alias).toBe('luna_high');
  });

  it('does not offer the same model a second repair', () => {
    const d = nextEscalation(
      { ...base, failureClass: 'mechanical', budget: { ...base.budget, sameModelRepairs: 1 } },
      escDeps,
    );
    if (!isHumanBlock(d)) expect(d.alias).not.toBe('luna_high');
  });

  it('never lets a mechanical failure reach Sol', () => {
    const d = nextEscalation(
      { ...base, failureClass: 'mechanical', budget: { ...base.budget, sameModelRepairs: 1 } },
      escDeps,
    );
    if (!isHumanBlock(d)) expect(d.alias).not.toBe('sol_xhigh');
  });

  it('switches alias or thinking level on a localized logic failure', () => {
    const d = nextEscalation({ ...base, failureClass: 'localized_logic' }, escDeps);
    expect(isHumanBlock(d)).toBe(false);
    if (!isHumanBlock(d)) {
      expect(d.alias).not.toBe('luna_high');
    }
  });

  it('answers missing context with more context, not more thinking', () => {
    const d = nextEscalation({ ...base, failureClass: 'context_insufficient' }, escDeps);
    if (!isHumanBlock(d)) expect(d.alias).toBe('terra_high');
  });

  it('sends architecture failures to the orchestrator tier', () => {
    const d = nextEscalation({ ...base, failureClass: 'architecture_integration' }, escDeps);
    if (!isHumanBlock(d)) expect(['sol_medium', 'sol_high', 'sol_xhigh']).toContain(d.alias);
  });

  it('always blocks on requirement ambiguity, no matter the budget', () => {
    const d = nextEscalation({ ...base, failureClass: 'requirement_ambiguity' }, escDeps);
    expect(isHumanBlock(d)).toBe(true);
    if (isHumanBlock(d)) expect(d.trigger).toBe('unresolved_requirement');
  });

  it('blocks once the escalation budget is spent, rather than burning more compute', () => {
    const d = nextEscalation(
      { ...base, failureClass: 'localized_logic', budget: { ...base.budget, workerEscalations: 2 } },
      escDeps,
    );
    expect(isHumanBlock(d)).toBe(true);
    if (isHumanBlock(d)) expect(d.trigger).toBe('retry_budget_exhausted');
  });

  it('rations Sol adjudications separately', () => {
    const d = nextEscalation(
      {
        ...base,
        failureClass: 'reviewer_dispute',
        budget: { ...base.budget, solAdjudications: 1 },
      },
      escDeps,
    );
    expect(isHumanBlock(d)).toBe(true);
  });
});
