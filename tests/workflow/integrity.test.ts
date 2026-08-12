import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { openDatabase, type ControllerDatabase } from '../../src/state/db.js';
import { createRepositories } from '../../src/state/repositories.js';
import { renderPrBody } from '../../src/github/pr-body.js';
import { assessReview, type ReviewResult } from '../../src/reviews/review.js';
import { loadControllerConfig } from '../../src/config/load-config.js';
import { detectCiTrigger } from '../../src/knowledge/derive.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkItem } from '../../src/scheduler/priority.js';

const config = loadControllerConfig(process.cwd());
let db: ControllerDatabase;
let repos: ReturnType<typeof createRepositories>;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  repos.upsertProject({
    id: 'portfolio',
    enabled: true,
    repoPath: 'H:/Code/Pessoais/Portfolio',
    githubSlug: 'JPClow3/Portfolio',
    baseBranch: 'main',
    linearProject: 'Portfolio',
    knowledgeStatus: 'unverified',
    maxAgents: 5,
    routingProfile: 'default',
  });
  repos.upsertIssue({ id: 'UNI-9', projectId: 'portfolio', title: 'test' });
});
afterEach(() => db.close());

const review = (over: Partial<ReviewResult> = {}): ReviewResult => ({
  verdict: 'approve',
  issue_id: 'UNI-9',
  stage: 'final',
  reviewer: { id: 'glm_5_2' },
  findings: [],
  criteria: [{ id: 'AC-1', status: 'satisfied' }],
  ...over,
});

/**
 * The worst defect found in the audit: the PR body hardcoded every acceptance
 * criterion as satisfied, so the deliverable asserted success it had never
 * established.
 */
describe('the PR body cannot claim unearned success', () => {
  const criteria = [
    { id: 'AC-1', statement: 'Filtering works.' },
    { id: 'AC-2', statement: 'Logout invalidates the session.' },
  ];

  function body(assessment: ReturnType<typeof assessReview> | null) {
    const unsatisfied = new Set([
      ...(assessment?.unsatisfiedCriteria ?? []),
      ...(assessment?.uncertainCriteria ?? []),
    ]);
    const reviewed = assessment !== null;
    return renderPrBody({
      issueId: 'UNI-9',
      summary: 's',
      criteria: criteria.map((c) => ({
        id: c.id,
        statement: c.statement,
        satisfied: reviewed && !unsatisfied.has(c.id),
      })),
      implementationNotes: '',
      validation: [{ name: 'test', passed: true }],
      planner: 'terra_high',
      workers: [],
      finalReviewer: 'glm_5_2',
      knowledgeStatus: 'UNVERIFIED',
      risks: [],
      reviewNotes: [],
    });
  }

  it('ticks nothing when no review was recorded', () => {
    expect(body(null)).toContain('- [ ] AC-1');
    expect(body(null)).not.toContain('- [x] AC-1');
  });

  it('leaves an unsatisfied criterion unticked', () => {
    const assessment = assessReview(
      review({
        verdict: 'request_changes',
        criteria: [
          { id: 'AC-1', status: 'satisfied' },
          { id: 'AC-2', status: 'unsatisfied' },
        ],
      }),
      config.escalation.reviewRemediation.blockingSeverities,
    );
    const out = body(assessment);
    expect(out).toContain('- [x] AC-1');
    expect(out).toContain('- [ ] AC-2');
  });

  it('treats uncertain as not established', () => {
    const assessment = assessReview(
      review({ criteria: [{ id: 'AC-1', status: 'uncertain' }, { id: 'AC-2', status: 'satisfied' }] }),
      config.escalation.reviewRemediation.blockingSeverities,
    );
    expect(body(assessment)).toContain('- [ ] AC-1');
  });

  it('ticks only when the reviewer actually said satisfied', () => {
    const assessment = assessReview(review({ criteria: criteria.map((c) => ({ id: c.id, status: 'satisfied' as const })) }), config.escalation.reviewRemediation.blockingSeverities);
    const out = body(assessment);
    expect(out).toContain('- [x] AC-1');
    expect(out).toContain('- [x] AC-2');
  });
});

describe('reviews are recorded so the verdict survives a restart', () => {
  it('round-trips the verdict and criteria', () => {
    const run = repos.claimIssueRun('UNI-9', 'portfolio')!;
    repos.recordReview(run.id, review({ verdict: 'request_changes', criteria: [{ id: 'AC-1', status: 'unsatisfied' }] }));

    const last = repos.lastReview(run.id);
    expect(last?.verdict).toBe('request_changes');
    expect(last?.criteria).toEqual([{ id: 'AC-1', status: 'unsatisfied' }]);
    expect(last?.reviewer.id).toBe('glm_5_2');
  });

  it('returns null before any review', () => {
    const run = repos.claimIssueRun('UNI-9', 'portfolio')!;
    expect(repos.lastReview(run.id)).toBeNull();
  });

  it('keeps the most recent of several', () => {
    const run = repos.claimIssueRun('UNI-9', 'portfolio')!;
    repos.recordReview(run.id, review({ verdict: 'request_changes' }));
    repos.recordReview(run.id, review({ verdict: 'approve' }));
    expect(repos.lastReview(run.id)?.verdict).toBe('approve');
  });
});

describe('run workspace is persisted', () => {
  it('records branch, base sha and worktree so later steps can find them', () => {
    const run = repos.claimIssueRun('UNI-9', 'portfolio')!;
    expect(run.branch).toBeNull();
    expect(run.orcaWorktreeId).toBeNull();

    repos.attachRunWorkspace(run.id, { branch: 'ai/UNI-9-x', baseSha: 'deadbeef', orcaWorktreeId: 'wt-1' });

    const after = repos.getRun(run.id)!;
    expect(after.branch).toBe('ai/UNI-9-x');
    expect(after.baseSha).toBe('deadbeef');
    expect(after.orcaWorktreeId).toBe('wt-1');
  });

  it('does not clobber existing values with undefined', () => {
    const run = repos.claimIssueRun('UNI-9', 'portfolio')!;
    repos.attachRunWorkspace(run.id, { branch: 'ai/UNI-9-x', baseSha: 'sha', orcaWorktreeId: 'wt-1' });
    repos.attachRunWorkspace(run.id, { orcaWorktreeId: 'wt-2' });

    const after = repos.getRun(run.id)!;
    expect(after.branch).toBe('ai/UNI-9-x');
    expect(after.orcaWorktreeId).toBe('wt-2');
  });
});

describe('tasks and attempts are recorded', () => {
  it('makes worker commits readable by integration', () => {
    const run = repos.claimIssueRun('UNI-9', 'portfolio')!;
    repos.recordTasks(run.id, [{ id: 'api', summary: 's', owns: ['src/api/**'] }]);
    repos.recordAttempt(run.id, 'api', {
      aliasId: 'deepseek_flash',
      role: 'worker',
      result: { commits: [{ sha: 'c1' }, { sha: 'c2' }], files_changed: [{ insertions: 10, deletions: 2 }] },
    });

    const commits = repos.workerCommits(run.id);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.commits).toEqual(['c1', 'c2']);
  });

  /** With attempts empty, reviewer selection silently degrades to "first candidate". */
  it('makes authorship computable, so reviewer independence is real', () => {
    const run = repos.claimIssueRun('UNI-9', 'portfolio')!;
    repos.recordTasks(run.id, [{ id: 'api', owns: [] }]);
    repos.recordAttempt(run.id, 'api', {
      aliasId: 'luna_high',
      role: 'worker',
      result: { files_changed: [{ insertions: 100, deletions: 20 }] },
    });

    expect(repos.attemptAuthorship(run.id)).toEqual([{ alias: 'luna_high', changedLines: 120 }]);
  });

  it('increments attempt numbers rather than overwriting', () => {
    const run = repos.claimIssueRun('UNI-9', 'portfolio')!;
    repos.recordTasks(run.id, [{ id: 'api', owns: [] }]);
    repos.recordAttempt(run.id, 'api', { aliasId: 'a', role: 'worker' });
    repos.recordAttempt(run.id, 'api', { aliasId: 'b', role: 'worker' });
    expect(repos.attemptSummary(run.id).map((a) => a.alias)).toEqual(['a', 'b']);
  });

  it('refuses an attempt against a task that does not exist', () => {
    const run = repos.claimIssueRun('UNI-9', 'portfolio')!;
    expect(() => repos.recordAttempt(run.id, 'ghost', { aliasId: 'a', role: 'worker' })).toThrow(/No task/);
  });
});

describe('remediation carries a real plan', () => {
  it('round-trips the tasks', () => {
    const run = repos.claimIssueRun('UNI-9', 'portfolio')!;
    expect(repos.pendingRemediation(run.id)).toEqual([]);
    repos.recordRemediationPlan(run.id, [{ file: 'src/a.ts', instruction: 'fix the guard' }]);
    expect(repos.pendingRemediation(run.id)).toHaveLength(1);
  });

  it('counts dispatched remediation cycles rather than recovery transitions', () => {
    const run = repos.claimIssueRun('UNI-9', 'portfolio')!;
    repos.recordTasks(run.id, [
      { id: 'original', owns: ['src/a.ts'] },
      { id: 'remediation-1-0', owns: ['src/a.test.ts'] },
    ]);
    db.raw.prepare(
      `INSERT INTO state_transitions (run_id, issue_id, from_state, to_state, reason)
       VALUES (?, 'UNI-9', 'INTEGRATING', 'REMEDIATING', 'controller recovery noise'),
              (?, 'UNI-9', 'FINAL_REVIEW', 'REMEDIATING', 'actual review')`,
    ).run(run.id, run.id);

    expect(repos.remediationCycles(run.id)).toBe(1);
  });
});

describe('a work item carries its resolved project', () => {
  /** getActiveRun returns null exactly when a new issue needs dispatching. */
  it('so a new issue is not skipped forever', () => {
    const item: WorkItem = {
      kind: 'NEW_READY_ISSUE',
      issueId: 'UNI-9',
      projectId: 'portfolio',
      enqueuedAt: new Date().toISOString(),
    };
    expect(repos.getActiveRun('UNI-9')).toBeNull();
    expect(item.projectId).toBe('portfolio');
  });
});

describe('CI trigger detection respects branch filters', () => {
  function repo(workflow: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'ci-detect-'));
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/build.yml'), workflow);
    return dir;
  }

  /**
   * The real Portfolio case: the workflow targets `master` while the repo is
   * on `main`, so no check ever runs. Reporting `pull_request` would make the
   * controller wait forever for CI that cannot start.
   */
  it('reports none when pull_request is filtered to a branch the repo does not use', () => {
    const dir = repo('name: CI\non:\n  push:\n    branches: [master]\n  pull_request:\n    branches: [master]\n\njobs: {}\n');
    expect(detectCiTrigger(dir, 'main')).toBe('none');
    expect(detectCiTrigger(dir, 'master')).toBe('pull_request');
  });

  it('reports pull_request when unfiltered', () => {
    const dir = repo('name: CI\non:\n  pull_request:\n\njobs: {}\n');
    expect(detectCiTrigger(dir, 'main')).toBe('pull_request');
  });

  it('reports pull_request when the filter includes the base branch', () => {
    const dir = repo('name: CI\non:\n  pull_request:\n    branches: [main]\n\njobs: {}\n');
    expect(detectCiTrigger(dir, 'main')).toBe('pull_request');
  });
});
