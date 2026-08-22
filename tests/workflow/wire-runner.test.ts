import { describe, expect, it, vi } from 'vitest';
import { createRunnerDeps, type RunnerWiring } from '../../src/workflow/wire-runner.js';

function wiring(overrides: Partial<RunnerWiring> = {}): RunnerWiring {
  return {
    config: {} as RunnerWiring['config'],
    repos: {} as RunnerWiring['repos'],
    writeToLinear: false,
    recoverReality: vi.fn(async () => ({ appliedRunIds: ['run-recovered'] })),
    advanceAll: vi.fn(async () => 2),
    projectKnowledge: vi.fn(() => ''),
    mirrorProject: vi.fn(),
    agents: {} as RunnerWiring['agents'],
    routing: {} as RunnerWiring['routing'],
    routingConfig: { aliases: {}, roles: {} } as RunnerWiring['routingConfig'],
    pressure: {} as RunnerWiring['pressure'],
    eligibility: { providers: {}, aliases: {} },
    disabled: [],
    orca: {} as RunnerWiring['orca'],
    github: {} as RunnerWiring['github'],
    dispatchDeps: {} as RunnerWiring['dispatchDeps'],
    ...overrides,
  };
}

describe('runner wiring', () => {
  it('reconciles external reality before advancing and excludes recovered runs', async () => {
    const recoverReality = vi.fn(async () => ({ appliedRunIds: ['run-1', 'run-2'] }));
    const advanceAll = vi.fn(async (skipRunIds?: ReadonlySet<string>) => {
      expect([...skipRunIds ?? []]).toEqual(['run-1', 'run-2']);
      return 3;
    });
    const deps = createRunnerDeps(wiring({ recoverReality, advanceAll }));

    await expect(deps.reconcile()).resolves.toBe(5);
    expect(recoverReality).toHaveBeenCalledOnce();
    expect(advanceAll).toHaveBeenCalledOnce();
  });

  it('does not consume the auto-curation watermark in report-only mode', async () => {
    const deps = createRunnerDeps(wiring({ writeToLinear: false }));

    await expect(deps.adoptNewIssues()).resolves.toBe(0);
  });
});
