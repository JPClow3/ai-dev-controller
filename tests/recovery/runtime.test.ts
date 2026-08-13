import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type ControllerDatabase } from '../../src/state/db.js';
import { createRepositories, type ControllerRepositories } from '../../src/state/repositories.js';
import { reconcileIncompleteRuns, type RuntimeRecoveryDeps } from '../../src/recovery/runtime.js';

let db: ControllerDatabase;
let repos: ControllerRepositories;

const facts = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, true]));

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  repos.upsertProject({
    id: 'repo',
    enabled: true,
    repoPath: 'H:/Code/repo',
    githubSlug: 'owner/repo',
    baseBranch: 'main',
    linearProject: 'Project',
    knowledgeStatus: 'unverified',
    maxAgents: 2,
    routingProfile: 'default',
  });
  repos.upsertIssue({ id: 'JP-1', projectId: 'repo', title: 'Recover me' });
});

afterEach(() => db.close());

function runAtCi() {
  const run = repos.claimIssueRun('JP-1', 'repo')!;
  for (const [to, mechanicalFacts] of [
    ['PLANNING', facts('dependenciesMerged', 'capacityAvailable', 'freshBaseFetched')],
    ['IMPLEMENTING', facts('planValidated', 'ownershipSetsDisjoint', 'worktreesCreated')],
    ['INTEGRATING', facts('allTasksTerminal')],
    ['LOCAL_VALIDATION', facts('integrationCommitPresent')],
    ['PR_DRAFT_OPEN', facts('branchPushed')],
    ['CI', facts('branchPushed', 'pullRequestExists')],
  ] as const) {
    repos.transitionRun(run.id, to, {
      reason: 'fixture',
      ciTrigger: 'pull_request',
      mechanicalFacts,
    });
  }
  return run;
}

function recovery(overrides: Partial<RuntimeRecoveryDeps> = {}): RuntimeRecoveryDeps {
  return {
    repos,
    ciTriggerFor: () => 'pull_request',
    observeOrca: vi.fn(async () => ({ worktreeExists: true, agentRunning: false, agentSettled: true })),
    observeGit: vi.fn(async () => ({ branchExists: true, hasCommitsBeyondBase: true, branchPushed: true })),
    observeGitHub: vi.fn(async () => ({
      pullRequestNumber: 13,
      url: 'https://github.com/owner/repo/pull/13',
      isDraft: true,
      headBranch: 'owner/ai-JP-1',
      baseBranch: 'main',
      merged: false,
      checksComplete: true,
      requiredChecksPassed: true,
    })),
    observeLinear: vi.fn(async () => ({ label: 'ai-reviewing' })),
    ...overrides,
  };
}

describe('runtime startup recovery', () => {
  it('records an authoritative human merge even when SQLite missed intermediate states', async () => {
    const run = repos.claimIssueRun('JP-1', 'repo')!;
    db.raw.prepare("UPDATE runs SET state = 'IMPLEMENTING' WHERE id = ?").run(run.id);

    const result = await reconcileIncompleteRuns(recovery({
      observeGitHub: vi.fn(async () => ({
        pullRequestNumber: 13,
        isDraft: false,
        merged: true,
        checksComplete: true,
        requiredChecksPassed: true,
      })),
    }));

    expect(result.appliedRunIds).toEqual([run.id]);
    expect(repos.getRun(run.id)?.state).toBe('MERGED');
  });

  it('fast-forwards to final review when authoritative PR checks passed after a crash', async () => {
    const run = repos.claimIssueRun('JP-1', 'repo')!;
    db.raw.prepare("UPDATE runs SET state = 'IMPLEMENTING' WHERE id = ?").run(run.id);
    repos.recordValidation(run.id, { passed: true, results: [{ name: 'test', passed: true, required: true }] });

    const result = await reconcileIncompleteRuns(recovery());

    expect(result.appliedRunIds).toEqual([run.id]);
    expect(repos.getRun(run.id)?.state).toBe('FINAL_REVIEW');
  });

  it('does not skip required local validation when GitHub checks passed after a crash', async () => {
    const run = repos.claimIssueRun('JP-1', 'repo')!;
    db.raw.prepare("UPDATE runs SET state = 'IMPLEMENTING' WHERE id = ?").run(run.id);

    const result = await reconcileIncompleteRuns(recovery());

    expect(result.appliedRunIds).toEqual([]);
    expect(repos.getRun(run.id)?.state).toBe('IMPLEMENTING');
  });

  it('fast-forwards a stale implementation to remediation when its PR checks failed', async () => {
    const run = repos.claimIssueRun('JP-1', 'repo')!;
    db.raw.prepare("UPDATE runs SET state = 'IMPLEMENTING' WHERE id = ?").run(run.id);
    repos.recordValidation(run.id, { passed: true, results: [{ name: 'test', passed: true, required: true }] });

    const result = await reconcileIncompleteRuns(recovery({
      observeGitHub: vi.fn(async () => ({
        pullRequestNumber: 13,
        isDraft: true,
        merged: false,
        checksComplete: true,
        requiredChecksPassed: false,
      })),
    }));

    expect(result.appliedRunIds).toEqual([run.id]);
    expect(repos.getRun(run.id)?.state).toBe('REMEDIATING');
  });

  it('resumes at draft-PR creation when validation and push completed before the state write', async () => {
    const run = repos.claimIssueRun('JP-1', 'repo')!;
    db.raw.prepare("UPDATE runs SET state = 'IMPLEMENTING' WHERE id = ?").run(run.id);
    repos.recordValidation(run.id, { passed: true, results: [{ name: 'test', passed: true }] });

    const result = await reconcileIncompleteRuns(recovery({
      observeGitHub: vi.fn(async () => ({
        pullRequestNumber: null,
        isDraft: false,
        merged: false,
        checksComplete: false,
        requiredChecksPassed: false,
      })),
    }));

    expect(result.appliedRunIds).toEqual([run.id]);
    expect(repos.getRun(run.id)?.state).toBe('PR_DRAFT_OPEN');
  });

  it('observes systems in order, applies the legal transition once, and is idempotent after restart', async () => {
    const run = runAtCi();
    const order: string[] = [];
    const onApplied = vi.fn(async () => undefined);
    const deps = recovery({
      observeOrca: vi.fn(async () => { order.push('orca'); return { worktreeExists: true, agentRunning: false, agentSettled: true }; }),
      observeGit: vi.fn(async () => { order.push('git'); return { branchExists: true, hasCommitsBeyondBase: true, branchPushed: true }; }),
      observeGitHub: vi.fn(async () => { order.push('github'); return { pullRequestNumber: 13, isDraft: true, merged: false, checksComplete: true, requiredChecksPassed: true }; }),
      observeLinear: vi.fn(async () => { order.push('linear'); return { label: 'ai-reviewing' }; }),
      onApplied,
    });

    const first = await reconcileIncompleteRuns(deps);
    expect(order).toEqual(['orca', 'git', 'github', 'linear']);
    expect(first.appliedRunIds).toEqual([run.id]);
    expect(repos.getRun(run.id)?.state).toBe('FINAL_REVIEW');
    expect(onApplied).toHaveBeenCalledOnce();

    order.length = 0;
    const second = await reconcileIncompleteRuns(deps);
    expect(second.appliedRunIds).toEqual([]);
    expect(repos.getRun(run.id)?.state).toBe('FINAL_REVIEW');
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it('does not mistake unavailable providers for proof that work disappeared', async () => {
    const run = runAtCi();
    // Put the database somewhere the pure reconciler would block only if it
    // had positive evidence that Orca, Git and GitHub were all empty.
    repos.transitionRun(run.id, 'REMEDIATING', { reason: 'fixture failure' });
    const unavailable = vi.fn(async () => { throw new Error('temporarily unavailable'); });

    const result = await reconcileIncompleteRuns(recovery({
      observeOrca: unavailable,
      observeGit: unavailable,
      observeGitHub: unavailable,
      observeLinear: unavailable,
    }));

    expect(result.observationErrors).toHaveLength(4);
    expect(result.appliedRunIds).toEqual([]);
    expect(repos.getRun(run.id)?.state).toBe('REMEDIATING');
    expect(result.reports[0]?.reason).toMatch(/could not be fully observed/);
  });

  it('supports a report-only pass without changing SQLite or projecting Linear', async () => {
    const run = runAtCi();
    const onApplied = vi.fn(async () => undefined);
    const result = await reconcileIncompleteRuns(recovery({ apply: false, onApplied }));
    expect(result.reports[0]?.derivedState).toBe('FINAL_REVIEW');
    expect(result.appliedRunIds).toEqual([]);
    expect(repos.getRun(run.id)?.state).toBe('CI');
    expect(db.raw.prepare('SELECT * FROM pull_requests WHERE run_id = ?').get(run.id)).toBeUndefined();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('persists an observed pull request even when the recovery state is already current', async () => {
    const run = runAtCi();
    db.raw.prepare("UPDATE runs SET state = 'PR_OPEN' WHERE id = ?").run(run.id);

    const result = await reconcileIncompleteRuns(recovery());

    expect(result.appliedRunIds).toEqual([]);
    expect(repos.getRun(run.id)?.state).toBe('PR_OPEN');
    expect(
      db.raw
        .prepare(
          `SELECT number, url, draft, head_branch AS headBranch, base_branch AS baseBranch
           FROM pull_requests WHERE run_id = ?`,
        )
        .get(run.id),
    ).toEqual({
      number: 13,
      url: 'https://github.com/owner/repo/pull/13',
      draft: 1,
      headBranch: 'owner/ai-JP-1',
      baseBranch: 'main',
    });
  });

  it('never resumes a human-blocked run from unattended observations', async () => {
    const run = repos.claimIssueRun('JP-1', 'repo')!;
    db.raw.prepare("UPDATE runs SET state = 'BLOCKED_HUMAN' WHERE id = ?").run(run.id);

    const observeOrca = vi.fn(async () => ({ worktreeExists: true, agentRunning: false, agentSettled: false }));
    const observeGit = vi.fn(async () => ({ branchExists: true, hasCommitsBeyondBase: false, branchPushed: false }));
    const observeLinear = vi.fn(async () => ({ label: 'ai-blocked' as const }));

    const result = await reconcileIncompleteRuns(recovery({
      observeGitHub: vi.fn(async () => ({
        pullRequestNumber: null,
        isDraft: false,
        merged: false,
        checksComplete: false,
        requiredChecksPassed: false,
      })),
      observeGit,
      observeOrca,
      observeLinear,
    }));

    expect(result.appliedRunIds).toEqual([]);
    expect(repos.getRun(run.id)?.state).toBe('BLOCKED_HUMAN');
    expect(observeOrca).not.toHaveBeenCalled();
    expect(observeGit).not.toHaveBeenCalled();
    expect(observeLinear).not.toHaveBeenCalled();
  });

  it('still observes a human merge while the run is blocked', async () => {
    const run = repos.claimIssueRun('JP-1', 'repo')!;
    db.raw.prepare("UPDATE runs SET state = 'BLOCKED_HUMAN' WHERE id = ?").run(run.id);

    const result = await reconcileIncompleteRuns(recovery({
      observeGitHub: vi.fn(async () => ({
        pullRequestNumber: 13,
        isDraft: false,
        merged: true,
        checksComplete: true,
        requiredChecksPassed: true,
      })),
    }));

    expect(result.appliedRunIds).toEqual([run.id]);
    expect(repos.getRun(run.id)?.state).toBe('MERGED');
  });
});
