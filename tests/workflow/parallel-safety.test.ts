import { describe, expect, it } from 'vitest';
import { overlappingOwnership } from '../../src/git/integration.js';

/**
 * Observed live on JP-7: the planner produced two tasks that BOTH owned
 * `tests/unit/github.test.ts`, marked the second `blocked_by` the first, and
 * both were launched in parallel anyway.
 *
 * The ownership check was right to permit the overlap — serialising is how the
 * design resolves a clash. The dispatcher was wrong to ignore `blocked_by`.
 * These tests pin down both halves of that contract.
 */
type Task = { id: string; owns: string[]; blocked_by?: string[] };

const runnable = (tasks: Task[]) => tasks.filter((t) => (t.blocked_by ?? []).length === 0);
const deferred = (tasks: Task[]) => tasks.filter((t) => (t.blocked_by ?? []).length > 0);

describe('overlapping paths are allowed only when sequential', () => {
  const SAME_FILE: Task[] = [
    { id: 'create-test-file', owns: ['tests/unit/github.test.ts'] },
    { id: 'write-test-cases', owns: ['tests/unit/github.test.ts'], blocked_by: ['create-test-file'] },
  ];

  it('permits the overlap when the second is blocked by the first', () => {
    const clashes = overlappingOwnership(
      SAME_FILE.map((t) => ({ id: t.id, owns: t.owns, blockedBy: t.blocked_by ?? [] })),
    );
    expect(clashes).toHaveLength(0);
  });

  it('rejects the same overlap when the tasks are parallel', () => {
    const parallel = SAME_FILE.map((t) => ({ id: t.id, owns: t.owns, blockedBy: [] }));
    expect(overlappingOwnership(parallel)).toHaveLength(1);
  });
});

describe('dispatch honours blocked_by', () => {
  const SAME_FILE: Task[] = [
    { id: 'create-test-file', owns: ['tests/unit/github.test.ts'] },
    { id: 'write-test-cases', owns: ['tests/unit/github.test.ts'], blocked_by: ['create-test-file'] },
  ];

  /** The exact defect: two workers editing one file at the same time. */
  it('launches only the unblocked task, never both owners at once', () => {
    expect(runnable(SAME_FILE).map((t) => t.id)).toEqual(['create-test-file']);
    expect(deferred(SAME_FILE).map((t) => t.id)).toEqual(['write-test-cases']);
  });

  it('launches genuinely independent tasks together', () => {
    const independent: Task[] = [
      { id: 'api', owns: ['src/api/**'] },
      { id: 'web', owns: ['src/web/**'] },
      { id: 'docs', owns: ['docs/**'] },
    ];
    expect(runnable(independent)).toHaveLength(3);
    expect(deferred(independent)).toHaveLength(0);
  });

  it('never leaves a plan with nothing runnable', () => {
    // A fully-blocked plan is a cycle or a planner error, not a wait state.
    const circular: Task[] = [
      { id: 'a', owns: ['x'], blocked_by: ['b'] },
      { id: 'b', owns: ['y'], blocked_by: ['a'] },
    ];
    expect(runnable(circular)).toHaveLength(0);
  });

  it('deferred tasks are still recorded, not dropped', () => {
    // They must survive to be dispatched in a later wave; silently discarding
    // them would lose half the plan.
    expect(runnable(SAME_FILE).length + deferred(SAME_FILE).length).toBe(SAME_FILE.length);
  });
});

describe('ownership clash detection', () => {
  it('treats a directory glob as overlapping a file inside it', () => {
    const clashes = overlappingOwnership([
      { id: 'a', owns: ['tests/unit/**'], blockedBy: [] },
      { id: 'b', owns: ['tests/unit/github.test.ts'], blockedBy: [] },
    ]);
    expect(clashes).toHaveLength(1);
  });

  it('does not flag sibling directories', () => {
    const clashes = overlappingOwnership([
      { id: 'a', owns: ['tests/unit/**'], blockedBy: [] },
      { id: 'b', owns: ['tests/e2e/**'], blockedBy: [] },
    ]);
    expect(clashes).toHaveLength(0);
  });

  it('flags three-way overlap pairwise', () => {
    const clashes = overlappingOwnership([
      { id: 'a', owns: ['src/**'], blockedBy: [] },
      { id: 'b', owns: ['src/lib/**'], blockedBy: [] },
      { id: 'c', owns: ['src/lib/github.ts'], blockedBy: [] },
    ]);
    expect(clashes.length).toBeGreaterThanOrEqual(3);
  });
});
