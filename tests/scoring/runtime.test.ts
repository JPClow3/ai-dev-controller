import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type ControllerDatabase } from '../../src/state/db.js';
import { createRepositories, type ControllerRepositories } from '../../src/state/repositories.js';
import { loadControllerConfig } from '../../src/config/load-config.js';
import { finalizeRunScores } from '../../src/scoring/runtime.js';

let db: ControllerDatabase;
let repos: ControllerRepositories;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  repos.upsertProject({
    id: 'repo', enabled: true, repoPath: 'H:/Code/repo', githubSlug: 'owner/repo',
    baseBranch: 'main', linearProject: 'Project', knowledgeStatus: 'unverified',
    maxAgents: 2, routingProfile: 'default',
  });
  repos.upsertIssue({
    id: 'JP-1', projectId: 'repo', title: 'Score me',
    acceptanceCriteria: [{ id: 'AC-1', statement: 'The helper works.' }],
  });
});

afterEach(() => db.close());

function completedRun() {
  const run = repos.claimIssueRun('JP-1', 'repo')!;
  repos.attachRunWorkspace(run.id, {
    branch: 'owner/ai-JP-1',
    baseSha: 'base',
    orcaWorktreeId: 'repo::C:/worker',
  });
  repos.recordTasks(run.id, [{
    id: 'task', summary: 'Implement helper', task_category: 'routine_behavior',
    risk: 'low', owns: ['src/helper.ts'], blocked_by: [], acceptance_criteria: ['AC-1'],
    orcaWorktreeId: 'repo::C:/worker',
  }]);
  repos.recordAttempt(run.id, 'task', { aliasId: 'luna_high', role: 'worker' });
  repos.setWorkerAttemptBaseSha(run.id, 'task', 'base');
  repos.recordAttemptResult(run.id, 'task', { commits: [{ sha: 'abc', message: 'done' }] });
  repos.recordReview(run.id, {
    verdict: 'approve', reviewer: { id: 'luna_low' }, findings: [],
    criteria: [{ id: 'AC-1', status: 'satisfied', evidence: 'src/helper.test.ts passes' }],
  });
  return repos.getRun(run.id)!;
}

describe('completed-run scoring', () => {
  it('records a real worker sample from review, diff, and duration evidence', async () => {
    const run = completedRun();
    const count = await finalizeRunScores({
      run,
      repos,
      git: { changedFilesBetween: vi.fn(async () => [{ path: 'src/helper.ts', insertions: 8, deletions: 1 }]) },
      scoring: loadControllerConfig(process.cwd()).scoring,
    });

    expect(count).toBe(1);
    expect(repos.routingStats()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: 'repository', projectId: 'repo', role: 'routine_behavior',
        aliasId: 'luna_high', samples: 1, successRate: 1,
      }),
    ]));
  });

  it('is idempotent when PR_OPEN is observed on every polling tick', async () => {
    const run = completedRun();
    const input = {
      run,
      repos,
      git: { changedFilesBetween: vi.fn(async () => [{ path: 'src/helper.ts', insertions: 8, deletions: 1 }]) },
      scoring: loadControllerConfig(process.cwd()).scoring,
    };

    expect(await finalizeRunScores(input)).toBe(1);
    expect(await finalizeRunScores(input)).toBe(0);
    expect(repos.routingStats().find((row) => row.scope === 'repository')?.samples).toBe(1);
  });

  it('uses the attempt commit interval and objective CI observations', async () => {
    const run = completedRun();
    repos.recordCiObservation(run.id, {
      headSha: 'abc', complete: true, allRequiredPassed: false,
      checks: [{ name: 'test', required: true, conclusion: 'FAILURE', githubRunId: 42 }],
    });
    repos.recordCiRetry(run.id, 'abc', 42, []);
    repos.recordCiObservation(run.id, {
      headSha: 'abc', complete: true, allRequiredPassed: false,
      checks: [{ name: 'test', required: true, conclusion: 'FAILURE', githubRunId: 42 }],
    });
    repos.recordCiObservation(run.id, {
      headSha: 'def', complete: true, allRequiredPassed: true,
      checks: [{ name: 'test', required: true, conclusion: 'SUCCESS', githubRunId: 43 }],
    });
    const changedFilesBetween = vi.fn(async () => [{ path: 'src/helper.ts', insertions: 8, deletions: 1 }]);
    await finalizeRunScores({
      run, repos, git: { changedFilesBetween }, scoring: loadControllerConfig(process.cwd()).scoring,
    });
    expect(changedFilesBetween).toHaveBeenCalledWith('C:/worker', 'base', 'abc');
    expect(repos.ciFailureCount(run.id)).toEqual({ observed: true, failures: 1 });
    expect(repos.routingStats().find((row) => row.scope === 'repository')?.firstPassCi).toBeCloseTo(0.65);
  });

  it('attributes a retry only to its own commit interval', async () => {
    const run = repos.claimIssueRun('JP-1', 'repo')!;
    repos.attachRunWorkspace(run.id, {
      branch: 'owner/ai-JP-1', baseSha: 'base', orcaWorktreeId: 'repo::C:/worker',
    });
    repos.recordTasks(run.id, [{
      id: 'task', summary: 'Implement helper', task_category: 'routine_behavior',
      risk: 'low', owns: ['src/helper.ts'], blocked_by: [], acceptance_criteria: ['AC-1'],
      orcaWorktreeId: 'repo::C:/worker',
    }]);
    repos.recordAttempt(run.id, 'task', { aliasId: 'luna_low', role: 'worker' });
    repos.setWorkerAttemptBaseSha(run.id, 'task', 'base');
    repos.recordAttemptResult(run.id, 'task', { failureClass: 'interrupted', commits: [] });
    repos.recordAttempt(run.id, 'task', { aliasId: 'luna_high', role: 'worker' });
    repos.setWorkerAttemptBaseSha(run.id, 'task', 'abc');
    repos.recordAttemptResult(run.id, 'task', { commits: [{ sha: 'def', message: 'retry done' }] });
    repos.recordReview(run.id, {
      verdict: 'approve', reviewer: { id: 'luna_low' }, findings: [],
      criteria: [{ id: 'AC-1', status: 'satisfied', evidence: 'test passes' }],
    });
    const changedFilesBetween = vi.fn(async () => [{ path: 'src/helper.ts', insertions: 3, deletions: 0 }]);
    expect(await finalizeRunScores({
      run: repos.getRun(run.id)!, repos, git: { changedFilesBetween },
      scoring: loadControllerConfig(process.cwd()).scoring,
    })).toBe(2);
    expect(changedFilesBetween).toHaveBeenCalledOnce();
    expect(changedFilesBetween).toHaveBeenCalledWith('C:/worker', 'abc', 'def');
    expect(repos.routingStats().find((row) => row.scope === 'repository' && row.aliasId === 'luna_low')?.successRate).toBe(0);
  });
});
