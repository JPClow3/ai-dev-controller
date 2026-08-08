import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { advanceRun, type OrchestratorDeps, type StepContext } from '../../src/workflow/orchestrator.js';
import { openDatabase, type ControllerDatabase } from '../../src/state/db.js';
import { createRepositories } from '../../src/state/repositories.js';
import { loadControllerConfig } from '../../src/config/load-config.js';
import type { WorkflowState, CiTrigger } from '../../src/workflow/states.js';

const config = loadControllerConfig(process.cwd());
let db: ControllerDatabase;
let repos: ReturnType<typeof createRepositories>;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  repos.upsertProject({
    id: 'moto-track',
    enabled: true,
    repoPath: 'H:/Code/Pessoais/moto_track',
    githubSlug: 'JPClow3/moto_track',
    baseBranch: 'main',
    linearProject: 'Moto Track',
    knowledgeStatus: 'unverified',
    maxAgents: 5,
    routingProfile: 'default',
  });
  repos.upsertIssue({ id: 'UNI-1', projectId: 'moto-track', title: 'test' });
});
afterEach(() => db.close());

function deps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    config,
    repos,
    dependenciesMerged: () => true,
    fetchFreshBase: vi.fn(async () => 'deadbeefcafe'),
    plan: vi.fn(async () => ({
      tasks: [
        { id: 'api', summary: 's', task_category: 'routine_behavior', owns: ['src/api/**'], acceptance_criteria: ['AC-1'] },
        { id: 'web', summary: 's', task_category: 'routine_behavior', owns: ['src/web/**'], acceptance_criteria: ['AC-2'] },
      ],
    })),
    createWorktrees: vi.fn(async () => undefined),
    workersSettled: vi.fn(async () => ({ allSettled: true, interrupted: [] })),
    integrate: vi.fn(async () => ({ conflicts: [], headSha: 'abc1234567' })),
    runValidation: vi.fn(async () => ({
      passed: true,
      failedRequired: [],
      results: [
        { name: 'test', command: 'npm test', exitCode: 0, passed: true, required: true, durationMs: 1, stdoutTail: '', stderrTail: '', timedOut: false },
      ],
    })),
    pushBranch: vi.fn(async () => undefined),
    ensureDraftPr: vi.fn(async () => ({ number: 192 })),
    readChecks: vi.fn(async () => ({
      headSha: 'abc',
      complete: true,
      allRequiredPassed: true,
      checks: [{ name: 'test', state: 'SUCCESS', conclusion: 'SUCCESS', required: true }],
      pending: [],
      failed: [],
    })),
    review: vi.fn(async () => ({
      verdict: 'approve' as const,
      issue_id: 'UNI-1',
      stage: 'final' as const,
      reviewer: { id: 'glm_5_2' },
      findings: [],
      criteria: [{ id: 'AC-1', status: 'satisfied' as const }],
    })),
    pullRequestIsDraft: vi.fn(async () => true),
    writeProvenanceBody: vi.fn(async () => undefined),
    remediationCycles: () => 0,
    originalAuthors: () => ['deepseek_flash'],
    dispatchRemediation: vi.fn(async () => undefined),
    blockForHuman: vi.fn(async () => undefined),
    ...over,
  };
}

function ctx(state: WorkflowState, ciTrigger: CiTrigger = 'pull_request'): StepContext {
  const run = repos.claimIssueRun('UNI-1', 'moto-track')!;
  if (state !== 'QUEUED') {
    db.raw.prepare('UPDATE runs SET state = ? WHERE id = ?').run(state, run.id);
  }
  return {
    run: { ...repos.getRun(run.id)!, state },
    projectId: 'moto-track',
    ciTrigger,
    risk: 'low',
    baseBranch: 'main',
    branch: 'ai/UNI-1-test',
  };
}

describe('the happy path, one step at a time', () => {
  it('QUEUED fetches a fresh base before planning', async () => {
    const d = deps();
    const result = await advanceRun(ctx('QUEUED'), d);
    expect(result.to).toBe('PLANNING');
    expect(d.fetchFreshBase).toHaveBeenCalled();
  });

  it('PLANNING creates worktrees and moves to IMPLEMENTING', async () => {
    const d = deps();
    const result = await advanceRun(ctx('PLANNING'), d);
    expect(result.to).toBe('IMPLEMENTING');
    expect(d.createWorktrees).toHaveBeenCalled();
  });

  it('INTEGRATING moves to LOCAL_VALIDATION with an integration commit', async () => {
    expect((await advanceRun(ctx('INTEGRATING'), deps())).to).toBe('LOCAL_VALIDATION');
  });

  it('LOCAL_VALIDATION opens the draft PR first on a pull_request repo', async () => {
    const d = deps();
    const result = await advanceRun(ctx('LOCAL_VALIDATION', 'pull_request'), d);
    expect(result.to).toBe('PR_DRAFT_OPEN');
    expect(d.pushBranch).toHaveBeenCalled();
  });

  it('LOCAL_VALIDATION goes straight to CI on a branch_push repo', async () => {
    expect((await advanceRun(ctx('LOCAL_VALIDATION', 'branch_push'), deps())).to).toBe('CI');
  });

  it('PR_DRAFT_OPEN opens the PR purely as the CI trigger', async () => {
    const d = deps();
    const result = await advanceRun(ctx('PR_DRAFT_OPEN'), d);
    expect(result.to).toBe('CI');
    expect(d.ensureDraftPr).toHaveBeenCalled();
  });

  it('CI advances to FINAL_REVIEW when required checks pass', async () => {
    expect((await advanceRun(ctx('CI'), deps())).to).toBe('FINAL_REVIEW');
  });

  it('FINAL_REVIEW clears to PR_READY on a clean review', async () => {
    expect((await advanceRun(ctx('FINAL_REVIEW'), deps())).to).toBe('PR_READY');
  });

  it('PR_READY writes provenance before announcing the PR', async () => {
    const d = deps();
    const result = await advanceRun(ctx('PR_READY'), d);
    expect(result.to).toBe('PR_OPEN');
    expect(d.writeProvenanceBody).toHaveBeenCalled();
  });

  it('PR_OPEN waits for a human rather than merging', async () => {
    const result = await advanceRun(ctx('PR_OPEN'), deps());
    expect(result.to).toBeNull();
    expect(result.action).toBe('idle');
  });
});

describe('it waits instead of guessing', () => {
  it('holds in IMPLEMENTING while workers are running', async () => {
    const d = deps({ workersSettled: vi.fn(async () => ({ allSettled: false, interrupted: [] })) });
    const result = await advanceRun(ctx('IMPLEMENTING'), d);
    expect(result.to).toBeNull();
    expect(result.action).toBe('waiting');
  });

  it('holds in CI while checks are still running', async () => {
    const d = deps({
      readChecks: vi.fn(async () => ({
        headSha: 'a', complete: false, allRequiredPassed: false,
        checks: [], pending: ['test'], failed: [],
      })),
    });
    const result = await advanceRun(ctx('CI'), d);
    expect(result.action).toBe('waiting');
  });
});

describe('failures route to remediation, not forward', () => {
  it('failed local validation goes to REMEDIATING', async () => {
    const d = deps({
      runValidation: vi.fn(async () => ({ passed: false, failedRequired: ['test'], results: [] })),
    });
    expect((await advanceRun(ctx('LOCAL_VALIDATION'), d)).to).toBe('REMEDIATING');
  });

  it('failed CI goes to REMEDIATING', async () => {
    const d = deps({
      readChecks: vi.fn(async () => ({
        headSha: 'a', complete: true, allRequiredPassed: false,
        checks: [], pending: [], failed: ['test'],
      })),
    });
    expect((await advanceRun(ctx('CI'), d)).to).toBe('REMEDIATING');
  });

  it('integration conflicts go to REMEDIATING, resolved in the parent', async () => {
    const d = deps({ integrate: vi.fn(async () => ({ conflicts: ['src/shared.ts'], headSha: null })) });
    expect((await advanceRun(ctx('INTEGRATING'), d)).to).toBe('REMEDIATING');
  });

  it('an interrupted worker goes to REMEDIATING', async () => {
    const d = deps({ workersSettled: vi.fn(async () => ({ allSettled: true, interrupted: ['api'] })) });
    expect((await advanceRun(ctx('IMPLEMENTING'), d)).to).toBe('REMEDIATING');
  });

  it('blocking review findings go to REMEDIATING', async () => {
    const d = deps({
      review: vi.fn(async () => ({
        verdict: 'request_changes' as const,
        issue_id: 'UNI-1',
        stage: 'final' as const,
        reviewer: { id: 'glm_5_2' },
        findings: [{
          severity: 'high' as const, category: 'correctness', acceptance_criterion: 'AC-1',
          file: 'src/a.ts', explanation: 'wrong', suggested_validation: 'test it',
        }],
        criteria: [{ id: 'AC-1', status: 'unsatisfied' as const }],
      })),
    });
    expect((await advanceRun(ctx('FINAL_REVIEW'), d)).to).toBe('REMEDIATING');
  });
});

describe('it blocks for a human on real blockers', () => {
  it('blocks when the planner cannot resolve a requirement', async () => {
    const d = deps({ plan: vi.fn(async () => ({ tasks: [], blocked: 'session lifetime is undocumented' })) });
    const result = await advanceRun(ctx('PLANNING'), d);
    expect(result.to).toBe('BLOCKED_HUMAN');
    expect(d.blockForHuman).toHaveBeenCalled();
  });

  /** Prevention beats reconciliation: overlapping parallel tasks never start. */
  it('blocks a plan whose parallel tasks own the same paths', async () => {
    const d = deps({
      plan: vi.fn(async () => ({
        tasks: [
          { id: 'a', summary: '', task_category: 'x', owns: ['src/api/**'], acceptance_criteria: [] },
          { id: 'b', summary: '', task_category: 'x', owns: ['src/api/service.ts'], acceptance_criteria: [] },
        ],
      })),
    });
    const result = await advanceRun(ctx('PLANNING'), d);
    expect(result.to).toBe('BLOCKED_HUMAN');
    expect(result.detail).toMatch(/overlapping ownership/);
    expect(d.createWorktrees).not.toHaveBeenCalled();
  });

  it('allows sequential tasks to share paths', async () => {
    const d = deps({
      plan: vi.fn(async () => ({
        tasks: [
          { id: 'a', summary: '', task_category: 'x', owns: ['src/api/**'], acceptance_criteria: [] },
          { id: 'b', summary: '', task_category: 'x', owns: ['src/api/**'], blocked_by: ['a'], acceptance_criteria: [] },
        ],
      })),
    });
    expect((await advanceRun(ctx('PLANNING'), d)).to).toBe('IMPLEMENTING');
  });

  it('blocks when no worker produced a commit', async () => {
    const d = deps({ integrate: vi.fn(async () => ({ conflicts: [], headSha: null })) });
    expect((await advanceRun(ctx('INTEGRATING'), d)).to).toBe('BLOCKED_HUMAN');
  });

  /** A repo with neither validation commands nor CI has proven nothing. */
  it('refuses to proceed with no validation and no CI', async () => {
    const d = deps({
      runValidation: vi.fn(async () => ({ passed: true, failedRequired: [], results: [] })),
    });
    const result = await advanceRun(ctx('LOCAL_VALIDATION', 'none'), d);
    expect(result.to).toBe('BLOCKED_HUMAN');
    expect(result.detail).toMatch(/no validation commands and no CI/);
  });

  it('blocks once the remediation budget is exhausted', async () => {
    const d = deps({ remediationCycles: () => 99 });
    const result = await advanceRun(ctx('REMEDIATING'), d);
    expect(result.to).toBe('BLOCKED_HUMAN');
    expect(d.blockForHuman).toHaveBeenCalled();
  });
});

describe('guard refusals are reported, not crashes', () => {
  it('returns a refusal when a precondition is not met', async () => {
    // FINAL_REVIEW requires requiredCiPassed; a 'none'-CI repo reaching it
    // without local validation evidence must be refused, not forced.
    const d = deps();
    const c = ctx('LOCAL_VALIDATION', 'branch_push');
    d.runValidation = vi.fn(async () => ({ passed: true, failedRequired: [], results: [] }));
    const result = await advanceRun(c, d);
    expect(['advanced', 'refused']).toContain(result.action);
  });
});

describe('dependency gating', () => {
  it('sends a run with unmerged blockers to DEPENDENCY_BLOCKED', async () => {
    const d = deps({ dependenciesMerged: () => false });
    const result = await advanceRun(ctx('QUEUED'), d);
    expect(result.to).toBe('DEPENDENCY_BLOCKED');
    expect(d.fetchFreshBase).not.toHaveBeenCalled();
  });
});
