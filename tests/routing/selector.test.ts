import { describe, expect, it } from 'vitest';
import { selectModel, selectReviewer, authorshipByFamily } from '../../src/routing/selector.js';
import { nextEscalation } from '../../src/routing/escalation.js';
import { defaultPressure, pressureFromOrca, withOverride } from '../../src/routing/pressure.js';
import { loadControllerConfig } from '../../src/config/load-config.js';
import { isHumanBlock, type AliasStats } from '../../src/routing/types.js';

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
    expect(d.alias).toBe('kimi_code');
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

  /**
   * The behaviour the design asks for: pressure moves today's route without
   * touching the stored champion.
   */
  it('shifts off an exhausted provider without changing the champion', () => {
    const pressure = withOverride(defaultPressure(routing), 'chatgpt', 'EXHAUSTED');
    const d = selectModel({ projectId: 'lorebound', role: 'routine_bugfix', risk: 'low' }, deps({ pressure }));

    expect(d.alias).toBe('kimi_code');
    expect(d.reason).toBe('pressure_shift');
    expect(d.rejected.some((r) => r.alias === 'luna_high' && /EXHAUSTED/.test(r.why))).toBe(true);
    // The configured champion is untouched.
    expect(routing.roles['routine_bugfix']!.champion).toBe('luna_high');
  });

  it('does not count a forced substitution as a challenger experiment', () => {
    const pressure = withOverride(defaultPressure(routing), 'chatgpt', 'EXHAUSTED');
    const d = selectModel(
      { projectId: 'lorebound', role: 'routine_bugfix', risk: 'low' },
      deps({ pressure, random: () => 0.01 }),
    );
    expect(d.isChallenger).toBe(false);
  });

  it('rejects a model whose context window is too small', () => {
    const d = selectModel(
      { projectId: 'lorebound', role: 'large_context', risk: 'low', contextEstimate: 900_000 },
      deps(),
    );
    expect(d.alias).toBe('glm_5_2');
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
      alias === 'kimi_code'
        ? { samples: 20, compositeAvg: 0.9, successRate: 0.9, medianMinutes: 10 }
        : { samples: 20, compositeAvg: 0.4, successRate: 0.5, medianMinutes: 10 };

    const d = selectModel({ projectId: 'lorebound', role: 'routine_bugfix', risk: 'low' }, deps({ stats }));
    expect(d.alias).toBe('kimi_code');
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
    previousAliases: ['deepseek_flash'],
    budget: { sameModelRepairs: 0, workerEscalations: 0, reviewRemediationCycles: 0, solAdjudications: 0 },
  };

  const escDeps = { ...deps(), escalation };

  it('gives a mechanical failure one repair with the same model', () => {
    const d = nextEscalation({ ...base, failureClass: 'mechanical' }, escDeps);
    expect(isHumanBlock(d)).toBe(false);
    if (!isHumanBlock(d)) expect(d.alias).toBe('deepseek_flash');
  });

  it('does not offer the same model a second repair', () => {
    const d = nextEscalation(
      { ...base, failureClass: 'mechanical', budget: { ...base.budget, sameModelRepairs: 1 } },
      escDeps,
    );
    if (!isHumanBlock(d)) expect(d.alias).not.toBe('deepseek_flash');
  });

  it('never lets a mechanical failure reach Sol', () => {
    const d = nextEscalation(
      { ...base, failureClass: 'mechanical', budget: { ...base.budget, sameModelRepairs: 1 } },
      escDeps,
    );
    if (!isHumanBlock(d)) expect(d.alias).not.toBe('sol_xhigh');
  });

  it('switches family on a localized logic failure', () => {
    const d = nextEscalation({ ...base, failureClass: 'localized_logic' }, escDeps);
    expect(isHumanBlock(d)).toBe(false);
    if (!isHumanBlock(d)) {
      expect(routing.aliases[d.alias]!.family).not.toBe('deepseek');
    }
  });

  it('answers missing context with more context, not more thinking', () => {
    const d = nextEscalation({ ...base, failureClass: 'context_insufficient' }, escDeps);
    if (!isHumanBlock(d)) expect(d.alias).toBe('glm_5_2');
  });

  it('sends architecture failures to the orchestrator tier', () => {
    const d = nextEscalation({ ...base, failureClass: 'architecture_integration' }, escDeps);
    if (!isHumanBlock(d)) expect(['terra_high', 'glm_5_2', 'sol_xhigh']).toContain(d.alias);
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
    if (!isHumanBlock(d)) expect(d.alias).not.toBe('sol_xhigh');
  });
});
