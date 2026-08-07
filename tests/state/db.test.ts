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
    for (const [to, facts] of [
      ['PLANNING', proven('dependenciesMerged', 'capacityAvailable', 'freshBaseFetched')],
      ['IMPLEMENTING', proven('planValidated', 'ownershipSetsDisjoint', 'worktreesCreated')],
      ['INTEGRATING', proven('allTasksTerminal')],
      ['LOCAL_VALIDATION', proven('integrationCommitPresent')],
      ['CI', proven('branchPushed')],
      ['FINAL_REVIEW', proven('requiredCiPassed')],
      ['PR_READY', proven('requiredCiPassed', 'noBlockingFindings', 'retryBudgetRemaining')],
      ['PR_OPEN', proven('pullRequestIsDraft')],
      ['MERGED', proven('mergedByHuman')],
    ] as const) {
      repos.transitionRun(run.id, to as never, { reason: 'advance', mechanicalFacts: facts });
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
});
