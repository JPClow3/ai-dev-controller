import { describe, expect, it } from 'vitest';
import {
  computeReadyWave,
  computeAllWaves,
  detectDependencyCycles,
  unsatisfiedBlockers,
  type SchedulableIssue,
} from '../../src/scheduler/dag.js';

/**
 * The graph from the design:
 *
 *   A ------------+
 *                 +--> D --> F
 *   B --> C ------+
 *         |
 *         +----------> E
 */
function graph(overrides: Partial<Record<string, Partial<SchedulableIssue>>> = {}): SchedulableIssue[] {
  const base: Record<string, SchedulableIssue> = {
    A: { identifier: 'A', blockedBy: [], merged: false, ready: true },
    B: { identifier: 'B', blockedBy: [], merged: false, ready: true },
    C: { identifier: 'C', blockedBy: ['B'], merged: false, ready: true },
    D: { identifier: 'D', blockedBy: ['A', 'C'], merged: false, ready: true },
    E: { identifier: 'E', blockedBy: ['C'], merged: false, ready: true },
    F: { identifier: 'F', blockedBy: ['D'], merged: false, ready: true },
  };
  for (const [id, patch] of Object.entries(overrides)) {
    base[id] = { ...base[id]!, ...patch };
  }
  return Object.values(base);
}

describe('computeReadyWave', () => {
  it('starts with the issues that have no blockers', () => {
    expect(computeReadyWave(graph()).issues).toEqual(['A', 'B']);
  });

  it('opens the next issue only once its blocker is merged', () => {
    expect(computeReadyWave(graph({ B: { merged: true } })).issues).toEqual(['A', 'C']);
  });

  it('waits for every blocker, not just one', () => {
    const wave = computeReadyWave(graph({ B: { merged: true }, C: { merged: true } }));
    expect(wave.issues).toEqual(['A', 'E']);
    expect(wave.blocked.find((b) => b.identifier === 'D')?.waitingOn).toEqual(['A']);
  });

  it('reaches the final issue only after the whole chain merges', () => {
    const wave = computeReadyWave(
      graph({ A: { merged: true }, B: { merged: true }, C: { merged: true }, D: { merged: true } }),
    );
    expect(wave.issues).toContain('F');
  });

  it('reports what each blocked issue is waiting on', () => {
    const blocked = computeReadyWave(graph()).blocked;
    expect(blocked.find((b) => b.identifier === 'D')?.waitingOn.sort()).toEqual(['A', 'C']);
  });
});

describe('a dependency is satisfied only by a merge', () => {
  it.each([
    ['worker finished', { merged: false }],
    ['tests passed', { merged: false }],
    ['PR opened but unmerged', { merged: false }],
    ['reviewer approved', { merged: false }],
  ])('does not unblock downstream work when the blocker only %s', (_label, state) => {
    const issues = graph({ B: state });
    expect(computeReadyWave(issues).issues).not.toContain('C');
    const all = new Map(issues.map((i) => [i.identifier, i]));
    expect(unsatisfiedBlockers(all.get('C')!, all)).toEqual(['B']);
  });

  it('unblocks only on merged: true', () => {
    expect(computeReadyWave(graph({ B: { merged: true } })).issues).toContain('C');
  });

  it('treats an unknown blocker as unsatisfied rather than ignoring it', () => {
    const issues: SchedulableIssue[] = [
      { identifier: 'X', blockedBy: ['GHOST-1'], merged: false, ready: true },
    ];
    expect(computeReadyWave(issues).issues).toEqual([]);
  });
});

describe('ready gating', () => {
  it('never schedules an issue that lacks ai-ready', () => {
    expect(computeReadyWave(graph({ A: { ready: false } })).issues).toEqual(['B']);
  });

  it('never reschedules a merged issue', () => {
    expect(computeReadyWave(graph({ A: { merged: true } })).issues).not.toContain('A');
  });
});

describe('detectDependencyCycles', () => {
  it('finds A -> B -> C -> A', () => {
    const issues: SchedulableIssue[] = [
      { identifier: 'A', blockedBy: ['C'], merged: false, ready: true },
      { identifier: 'B', blockedBy: ['A'], merged: false, ready: true },
      { identifier: 'C', blockedBy: ['B'], merged: false, ready: true },
    ];
    const cycles = detectDependencyCycles(issues);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(['A', 'B', 'C']);
  });

  it('refuses to schedule anything inside a cycle', () => {
    const issues: SchedulableIssue[] = [
      { identifier: 'A', blockedBy: ['C'], merged: false, ready: true },
      { identifier: 'B', blockedBy: ['A'], merged: false, ready: true },
      { identifier: 'C', blockedBy: ['B'], merged: false, ready: true },
      { identifier: 'Z', blockedBy: [], merged: false, ready: true },
    ];
    const wave = computeReadyWave(issues);
    expect(wave.issues).toEqual(['Z']);
  });

  it('reports no cycles for an acyclic graph', () => {
    expect(detectDependencyCycles(graph())).toEqual([]);
  });

  it('detects a self-dependency', () => {
    const issues: SchedulableIssue[] = [
      { identifier: 'A', blockedBy: ['A'], merged: false, ready: true },
    ];
    expect(detectDependencyCycles(issues)).toEqual([['A']]);
  });
});

describe('computeAllWaves', () => {
  it('projects the design document wave sequence', () => {
    const waves = computeAllWaves(graph());
    expect(waves.map((w) => w.issues)).toEqual([['A', 'B'], ['C'], ['D', 'E'], ['F']]);
  });
});
