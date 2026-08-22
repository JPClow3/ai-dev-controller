import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { openDatabase, type ControllerDatabase } from '../../src/state/db.js';
import { createRepositories, type ControllerRepositories } from '../../src/state/repositories.js';
import { InvalidTransitionError } from '../../src/workflow/transitions.js';

let db: ControllerDatabase;
let repos: ControllerRepositories;

const proven = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, true]));

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  repos.upsertProject({
    id: 'climagro-django',
    enabled: true,
    repoPath: 'H:/Code/UniRV/climagro-django',
    githubSlug: 'AgroHub-Uni-RV/climagro-django',
    baseBranch: 'main',
    linearProject: 'Unirv',
    knowledgeStatus: 'unverified',
    maxAgents: 5,
    routingProfile: 'default',
  });
  repos.upsertIssue({ id: 'UNI-142', projectId: 'climagro-django', title: 'Add filtering to risk map' });
});

afterEach(() => db.close());

describe('migrations', () => {
  it('are idempotent', () => {
    const second = openDatabase(':memory:');
    expect(() => createRepositories(second)).not.toThrow();
    second.close();
  });

  it('creates the active-run uniqueness index', () => {
    const idx = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='ux_runs_active_issue'`)
      .get();
    expect(idx).toBeTruthy();
  });

  it('persists singleton controller watermarks', () => {
    expect(repos.getControllerMeta('linear.auto_curate_after')).toBeNull();
    repos.setControllerMeta('linear.auto_curate_after', '2026-08-11T12:00:00.000Z');
    expect(repos.getControllerMeta('linear.auto_curate_after')).toBe('2026-08-11T12:00:00.000Z');
    repos.setControllerMeta('linear.auto_curate_after', '2026-08-11T13:00:00.000Z');
    expect(repos.getControllerMeta('linear.auto_curate_after')).toBe('2026-08-11T13:00:00.000Z');
  });

  it('persists provider cooldowns and expires transport-derived ones', () => {
    repos.setProviderPressure('chatgpt', {
      pressure: 'EXHAUSTED',
      remainingAllowance: 0,
      source: 'transport_quota',
      manualOverride: false,
      resetAt: '2026-08-15T22:14:00.000Z',
    });

    expect(repos.activeProviderPressures(new Date('2026-08-15T22:13:59.000Z'))).toEqual([
      expect.objectContaining({ provider: 'chatgpt', pressure: 'EXHAUSTED' }),
    ]);
    expect(repos.activeProviderPressures(new Date('2026-08-15T22:14:00.000Z'))).toEqual([]);
    expect(
      db.raw.prepare('SELECT provider FROM provider_pressure WHERE provider = ?').get('chatgpt'),
    ).toBeUndefined();
  });
});

describe('claimIssueRun', () => {
  it('claims an issue exactly once', () => {
    const first = repos.claimIssueRun('UNI-142', 'climagro-django');
    expect(first).not.toBeNull();
    expect(first?.state).toBe('QUEUED');

    const second = repos.claimIssueRun('UNI-142', 'climagro-django');
    expect(second).toBeNull();
  });

  it('allows a fresh claim only after the previous run reaches a terminal state', () => {
    const first = repos.claimIssueRun('UNI-142', 'climagro-django');
    expect(first).not.toBeNull();

    repos.transitionRun(first!.id, 'CANCELLED', { reason: 'operator cancelled' });

    const second = repos.claimIssueRun('UNI-142', 'climagro-django');
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
    expect(second!.attempt).toBe(2);
  });

  it('does not treat a merged run as blocking a new claim', () => {
    const run = repos.claimIssueRun('UNI-142', 'climagro-django')!;
    // Full happy path for a pull_request repository: the draft PR opens before
    // CI, because a pushed ai/* branch triggers no workflow.
    for (const [to, facts] of [
      ['PLANNING', proven('dependenciesMerged', 'capacityAvailable', 'freshBaseFetched')],
      ['IMPLEMENTING', proven('planValidated', 'ownershipSetsDisjoint', 'worktreesCreated')],
      ['INTEGRATING', proven('allTasksTerminal')],
      ['LOCAL_VALIDATION', proven('integrationCommitPresent')],
      ['PR_DRAFT_OPEN', proven('branchPushed')],
      ['CI', proven('branchPushed', 'pullRequestExists')],
      ['FINAL_REVIEW', proven('requiredCiPassed')],
      ['PR_READY', proven('requiredCiPassed', 'noBlockingFindings', 'retryBudgetRemaining')],
      ['PR_OPEN', proven('pullRequestIsDraft', 'provenanceBodyWritten')],
      ['MERGED', proven('mergedByHuman')],
    ] as const) {
      repos.transitionRun(run.id, to as never, {
        reason: 'advance',
        ciTrigger: 'pull_request',
        mechanicalFacts: facts,
      });
    }
    expect(repos.getActiveRun('UNI-142')).toBeNull();
    expect(repos.claimIssueRun('UNI-142', 'climagro-django')).not.toBeNull();
  });

  it('keeps claims independent across issues', () => {
    repos.upsertIssue({ id: 'UNI-143', projectId: 'climagro-django', title: 'Second issue' });
    expect(repos.claimIssueRun('UNI-142', 'climagro-django')).not.toBeNull();
    expect(repos.claimIssueRun('UNI-143', 'climagro-django')).not.toBeNull();
  });
});

describe('worker attempt budget', () => {
  it('counts attempts for one task without including another task', () => {
    const run = repos.claimIssueRun('UNI-142', 'climagro-django')!;
    repos.recordTasks(run.id, [
      { id: 'api', summary: 'API' },
      { id: 'web', summary: 'Web' },
    ]);
    repos.recordAttempt(run.id, 'api', { aliasId: 'luna_high', role: 'worker' });
    repos.recordAttempt(run.id, 'api', { aliasId: 'terra_high', role: 'worker' });
    repos.recordAttempt(run.id, 'web', { aliasId: 'luna_high', role: 'worker' });

    expect(repos.workerAttemptCount(run.id, 'api')).toBe(2);
    expect(repos.workerAttemptCount(run.id, 'web')).toBe(1);
  });

  it('recovers the routed alias for an interrupted dispatch intent', () => {
    const run = repos.claimIssueRun('UNI-142', 'climagro-django')!;
    repos.recordTasks(run.id, [{ id: 'api', owns: [] }]);
    repos.recordAttempt(run.id, 'api', { aliasId: 'luna_high', role: 'worker', isChallenger: true });
    expect(repos.latestWorkerAttempt(run.id, 'api')).toMatchObject({ aliasId: 'luna_high', isChallenger: true });
    expect(repos.latestWorkerAttempt(run.id, 'api')?.startedAt).toBeTruthy();
  });

  it('counts only workers that are still dispatched as consuming global capacity', () => {
    const run = repos.claimIssueRun('UNI-142', 'climagro-django')!;
    repos.recordTasks(run.id, [{ id: 'api' }, { id: 'web' }]);
    repos.recordAttempt(run.id, 'api', { aliasId: 'luna_high', role: 'worker' });
    repos.recordAttempt(run.id, 'web', { aliasId: 'luna_high', role: 'worker' });
    repos.markWorkerLaunched(run.id, 'api');

    expect(repos.activeWorkerCount()).toBe(1);
    expect(repos.activeWorkerCount(run.id)).toBe(1);
    expect(repos.activeWorkerCountForRepository('climagro-django')).toBe(1);
    repos.setTaskState(run.id, 'api', 'DONE');
    expect(repos.activeWorkerCount()).toBe(0);
  });

  it('persists provider runtime status without storing credentials', () => {
    repos.setProviderStatus({
      provider: 'zai',
      state: 'unavailable',
      auth: 'failed',
      reason: 'missing ZAI_API_KEY',
      nextProbeAt: '2026-08-20T12:00:00.000Z',
    });
    expect(repos.providerStatuses()).toEqual([
      {
        provider: 'zai',
        state: 'unavailable',
        auth: 'failed',
        reason: 'missing ZAI_API_KEY',
        nextProbeAt: '2026-08-20T12:00:00.000Z',
      },
    ]);
  });
});

describe('curated issue contract', () => {
  it('replaces the raw body with the curator contract and its routing metadata', () => {
    repos.upsertIssue({
      id: 'UNI-142',
      projectId: 'climagro-django',
      title: 'rough title',
      body: 'make filtering nicer',
    });

    repos.recordCuratedIssue('UNI-142', {
      title: 'Define risk-map filtering behavior',
      body: '# Goal\nDefine filtering.\n\n# Acceptance criteria\nAC-1: Preserve the default view.',
      role: 'routine_behavior',
      risk: 'low',
      acceptanceCriteria: [{ id: 'AC-1', statement: 'Preserve the default view.' }],
    });

    expect(repos.getIssueContract('UNI-142')).toContain('Define filtering.');
    const row = db.raw.prepare('SELECT title, role, risk, acceptance_json FROM issues WHERE id = ?').get('UNI-142') as {
      title: string; role: string; risk: string; acceptance_json: string;
    };
    expect(row).toEqual({
      title: 'Define risk-map filtering behavior',
      role: 'routine_behavior',
      risk: 'low',
      acceptance_json: JSON.stringify([{ id: 'AC-1', statement: 'Preserve the default view.' }]),
    });

    repos.upsertIssue({ id: 'UNI-142', projectId: 'climagro-django', title: 'ready refresh' });
    expect(repos.issueRouting('UNI-142')).toEqual({ role: 'routine_behavior', risk: 'low' });
  });
});

describe('transitionRun', () => {
  it('rejects an illegal edge and leaves state untouched', () => {
    const run = repos.claimIssueRun('UNI-142', 'climagro-django')!;
    expect(() =>
      repos.transitionRun(run.id, 'IMPLEMENTING', { reason: 'skip planning' }),
    ).toThrow(InvalidTransitionError);
    expect(repos.getRun(run.id)!.state).toBe('QUEUED');
  });

  it('records an audit row for every accepted transition', () => {
    const run = repos.claimIssueRun('UNI-142', 'climagro-django')!;
    repos.transitionRun(run.id, 'PLANNING', {
      reason: 'wave ready',
      recommendedBy: 'terra_high',
      mechanicalFacts: proven('dependenciesMerged', 'capacityAvailable', 'freshBaseFetched'),
    });

    const history = repos.transitionHistory(run.id);
    expect(history).toEqual([
      { from: null, to: 'QUEUED', reason: 'run claimed' },
      { from: 'QUEUED', to: 'PLANNING', reason: 'wave ready' },
    ]);
  });

  it('mirrors run state onto the issue so Linear sync has one source', () => {
    const run = repos.claimIssueRun('UNI-142', 'climagro-django')!;
    repos.transitionRun(run.id, 'DEPENDENCY_BLOCKED', { reason: 'blocked by UNI-097' });
    const issue = db.raw.prepare('SELECT state FROM issues WHERE id = ?').get('UNI-142') as { state: string };
    expect(issue.state).toBe('DEPENDENCY_BLOCKED');
  });
});

describe('dependencies', () => {
  it('stores explicit blockers as unsatisfied', () => {
    repos.setDependencies('UNI-142', ['UNI-097', 'UNI-098']);
    const deps = repos.getDependencies('UNI-142');
    expect(deps).toHaveLength(2);
    expect(deps.every((d) => d.satisfiedAt === null)).toBe(true);
    expect(deps.every((d) => d.source === 'linear')).toBe(true);
  });

  it('satisfies a blocker only on merge', () => {
    repos.setDependencies('UNI-142', ['UNI-097']);

    // Nothing about opening a PR or passing CI satisfies a dependency.
    expect(repos.getDependencies('UNI-142')[0]!.satisfiedAt).toBeNull();

    const changed = repos.markDependencySatisfiedByMerge('UNI-097');
    expect(changed).toBe(1);
    expect(repos.getDependencies('UNI-142')[0]!.satisfiedAt).not.toBeNull();
  });

  it('replaces the blocker set when Linear changes, without duplicating', () => {
    repos.setDependencies('UNI-142', ['UNI-097']);
    repos.setDependencies('UNI-142', ['UNI-097', 'UNI-099']);
    expect(repos.getDependencies('UNI-142')).toHaveLength(2);
  });

  it('preserves merge satisfaction while refreshing unchanged Linear relations', () => {
    repos.setDependencies('UNI-142', ['UNI-097', 'UNI-098']);
    repos.markDependencySatisfiedByMerge('UNI-097');

    repos.setDependencies('UNI-142', ['UNI-097', 'UNI-099']);

    const deps = repos.getDependencies('UNI-142');
    expect(deps.map((dep) => dep.blockedBy).sort()).toEqual(['UNI-097', 'UNI-099']);
    expect(deps.find((dep) => dep.blockedBy === 'UNI-097')!.satisfiedAt).not.toBeNull();
    expect(deps.find((dep) => dep.blockedBy === 'UNI-099')!.satisfiedAt).toBeNull();
  });
});
