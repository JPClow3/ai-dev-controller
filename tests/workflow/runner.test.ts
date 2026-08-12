import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runSchedulerTick, type RunnerDeps } from '../../src/workflow/runner.js';
import { openDatabase, type ControllerDatabase } from '../../src/state/db.js';
import { createRepositories } from '../../src/state/repositories.js';
import { loadControllerConfig } from '../../src/config/load-config.js';

const config = loadControllerConfig(process.cwd());
let db: ControllerDatabase;

beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => db.close());

function deps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  const repos = createRepositories(db);
  return {
    config,
    repos,
    reconcile: vi.fn(async () => 0),
    adoptNewIssues: vi.fn(async () => 0),
    curateIssues: vi.fn(async () => 0),
    fetchReadyIssues: vi.fn(async () => []),
    syncMergedPullRequests: vi.fn(async () => []),
    pendingWork: vi.fn(async () => []),
    capacityState: vi.fn(async () => ({ activeIssues: [], agents: [] })),
    remediationBacklog: vi.fn(async () => 0),
    providerPressures: vi.fn(async () => ['NORMAL' as const]),
    dispatch: vi.fn(async () => undefined),
    markCurationBlocked: vi.fn(async () => undefined),
    flagCycle: vi.fn(async () => undefined),
    ...overrides,
  };
}

const issue = (identifier: string, over: Partial<{ blockedBy: string[]; projectName: string; description: string; labels: string[] }> = {}) => ({
  identifier,
  projectName: 'Lorebound',
  description: '',
  labels: [] as string[],
  blockedBy: [] as string[],
  ...over,
});

describe('tick ordering', () => {
  it('reconciles before anything else', async () => {
    const order: string[] = [];
    const d = deps({
      reconcile: vi.fn(async () => {
        order.push('reconcile');
        return 2;
      }),
      syncMergedPullRequests: vi.fn(async () => {
        order.push('merges');
        return [];
      }),
      adoptNewIssues: vi.fn(async () => {
        order.push('adopt');
        return 1;
      }),
      curateIssues: vi.fn(async () => {
        order.push('curate');
        return 1;
      }),
      fetchReadyIssues: vi.fn(async () => {
        order.push('ready');
        return [];
      }),
    });

    const report = await runSchedulerTick(d);
    expect(order).toEqual(['reconcile', 'merges', 'adopt', 'curate', 'ready']);
    expect(report.reconciled).toBe(2);
    expect(report.adopted).toBe(1);
    expect(report.curated).toBe(1);
  });
});

describe('ai-ready implementation queue', () => {
  it('dispatches an unblocked ready issue', async () => {
    const dispatch = vi.fn(async () => undefined);
    const report = await runSchedulerTick(
      deps({ fetchReadyIssues: vi.fn(async () => [issue('UNI-1')]), dispatch }),
    );
    expect(report.readyIssues).toEqual(['UNI-1']);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('starts nothing when no issue carries ai-ready', async () => {
    const dispatch = vi.fn(async () => undefined);
    const report = await runSchedulerTick(deps({ dispatch }));
    expect(report.readyIssues).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('dependencies still gate on merge', () => {
  it('holds an issue whose blocker has not merged', async () => {
    const report = await runSchedulerTick(
      deps({ fetchReadyIssues: vi.fn(async () => [issue('UNI-2', { blockedBy: ['UNI-1'] })]) }),
    );
    expect(report.readyIssues).toEqual([]);
    expect(report.blockedIssues[0]).toEqual({ identifier: 'UNI-2', waitingOn: ['UNI-1'] });
  });

  it('releases it once the blocker PR is merged', async () => {
    const report = await runSchedulerTick(
      deps({
        fetchReadyIssues: vi.fn(async () => [issue('UNI-2', { blockedBy: ['UNI-1'] })]),
        syncMergedPullRequests: vi.fn(async () => ['UNI-1']),
      }),
    );
    expect(report.readyIssues).toEqual(['UNI-2']);
  });
});

describe('repository resolution', () => {
  it('marks an unresolvable issue as blocked instead of guessing', async () => {
    const markCurationBlocked = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    const report = await runSchedulerTick(
      deps({
        fetchReadyIssues: vi.fn(async () => [issue('UNI-9', { projectName: 'No Such Project' })]),
        markCurationBlocked,
        dispatch,
      }),
    );

    expect(report.curationBlocked).toEqual(['UNI-9']);
    expect(markCurationBlocked).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('cycles', () => {
  it('flags a cycle and schedules none of its members', async () => {
    const flagCycle = vi.fn(async () => undefined);
    const report = await runSchedulerTick(
      deps({
        fetchReadyIssues: vi.fn(async () => [
          issue('A', { blockedBy: ['C'] }),
          issue('B', { blockedBy: ['A'] }),
          issue('C', { blockedBy: ['B'] }),
        ]),
        flagCycle,
      }),
    );
    expect(report.cycles).toHaveLength(1);
    expect(report.readyIssues).toEqual([]);
    expect(flagCycle).toHaveBeenCalledOnce();
  });
});

describe('capacity', () => {
  it('stops at the active-issue limit within a single tick', async () => {
    const dispatch = vi.fn(async () => undefined);
    const report = await runSchedulerTick(
      deps({
        fetchReadyIssues: vi.fn(async () =>
          ['UNI-1', 'UNI-2', 'UNI-3', 'UNI-4', 'UNI-5', 'UNI-6'].map((id) => issue(id)),
        ),
        dispatch,
      }),
    );

    // 4 active issues is the configured limit.
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(report.dispatched).toHaveLength(4);
    expect(report.skipped.every((s) => s.why.includes('active_issues'))).toBe(true);
  });

  it('starts nothing when the agent pool is already full', async () => {
    const dispatch = vi.fn(async () => undefined);
    const agents = Array.from({ length: 7 }, (_, i) => ({
      issueId: `X-${i}`,
      repositoryId: `r${i}`,
      aliasId: 'luna_high',
      provider: 'ollama' as const,
      heavy: false,
      luna: false,
    }));

    await runSchedulerTick(
      deps({
        fetchReadyIssues: vi.fn(async () => [issue('UNI-1')]),
        capacityState: vi.fn(async () => ({ activeIssues: [], agents })),
        dispatch,
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('finishing beats starting', () => {
  it('drops new starts while throttled but keeps completion work', async () => {
    const dispatch = vi.fn(async () => undefined);
    const report = await runSchedulerTick(
      deps({
        fetchReadyIssues: vi.fn(async () => [issue('UNI-NEW')]),
        pendingWork: vi.fn(async () => [
          { kind: 'FINAL_REVIEW_PR' as const, issueId: 'UNI-OLD', enqueuedAt: '2026-01-01T00:00:00.000Z' },
        ]),
        remediationBacklog: vi.fn(async () => 5),
        dispatch,
      }),
    );

    expect(report.throttled).toBe(true);
    expect(report.dispatched.map((d) => d.issueId)).toEqual(['UNI-OLD']);
  });

  it('orders near-finished work ahead of new issues', async () => {
    const dispatched: string[] = [];
    await runSchedulerTick(
      deps({
        fetchReadyIssues: vi.fn(async () => [issue('UNI-NEW')]),
        pendingWork: vi.fn(async () => [
          { kind: 'FINAL_REVIEW_PR' as const, issueId: 'UNI-PR', enqueuedAt: '2026-01-02T00:00:00.000Z' },
          { kind: 'CI_REMEDIATION' as const, issueId: 'UNI-CI', enqueuedAt: '2026-01-02T00:00:00.000Z' },
        ]),
        dispatch: vi.fn(async (item) => {
          dispatched.push(item.issueId);
        }),
      }),
    );
    expect(dispatched).toEqual(['UNI-PR', 'UNI-CI', 'UNI-NEW']);
  });
});
