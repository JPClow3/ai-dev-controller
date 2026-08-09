import { describe, expect, it } from 'vitest';
import { reconcileRun, applicable, type ObservedRun } from '../../src/recovery/reconcile.js';
import type { WorkflowState } from '../../src/workflow/states.js';

function observed(over: Partial<ObservedRun> = {}): ObservedRun {
  return {
    runId: 'run-1',
    issueId: 'UNI-142',
    dbState: 'IMPLEMENTING',
    ciTrigger: 'pull_request',
    orca: null,
    git: null,
    github: null,
    linear: null,
    ...over,
  };
}

const github = (over: Partial<NonNullable<ObservedRun['github']>> = {}) => ({
  pullRequestNumber: 192,
  isDraft: true,
  merged: false,
  checksComplete: true,
  requiredChecksPassed: true,
  ...over,
});

describe('restart reconciliation', () => {
  it('advances to FINAL_REVIEW when the DB says CI but checks already passed', () => {
    const report = reconcileRun(observed({ dbState: 'CI', github: github() }));
    expect(report.derivedState).toBe('FINAL_REVIEW');
    expect(report.action).toBe('advance');
    expect(report.facts['requiredCiPassed']).toBe(true);
    expect(applicable(report)).toBe(true);
  });

  it('marks a run merged when GitHub says so, even if the DB says PR_OPEN', () => {
    const report = reconcileRun(observed({ dbState: 'PR_OPEN', github: github({ merged: true }) }));
    expect(report.derivedState).toBe('MERGED');
    expect(report.facts['mergedByHuman']).toBe(true);
  });

  it('sends a run with failing checks to remediation', () => {
    const report = reconcileRun(
      observed({ dbState: 'CI', github: github({ requiredChecksPassed: false }) }),
    );
    expect(report.derivedState).toBe('REMEDIATING');
    expect(report.action).toBe('resume');
  });

  it('waits while checks are still running', () => {
    const report = reconcileRun(
      observed({ dbState: 'CI', github: github({ checksComplete: false, requiredChecksPassed: false }) }),
    );
    expect(report.derivedState).toBe('CI');
    expect(report.action).toBe('noop');
  });

  /**
   * The case that motivated PR_DRAFT_OPEN: a pushed branch on a pull_request
   * repository has triggered nothing, so the next step is opening the PR.
   */
  it('opens the draft PR next when a pushed branch has no PR on a pull_request repo', () => {
    const report = reconcileRun(
      observed({
        dbState: 'IMPLEMENTING',
        ciTrigger: 'pull_request',
        git: { branchExists: true, hasCommitsBeyondBase: true, branchPushed: true },
      }),
    );
    expect(report.derivedState).toBe('PR_DRAFT_OPEN');
  });

  it('goes straight to CI on a branch_push repository', () => {
    const report = reconcileRun(
      observed({
        dbState: 'IMPLEMENTING',
        ciTrigger: 'branch_push',
        git: { branchExists: true, hasCommitsBeyondBase: true, branchPushed: true },
      }),
    );
    expect(report.derivedState).toBe('CI');
  });

  it('goes straight to final review on a no-CI repository after durable validation and push', () => {
    const report = reconcileRun(
      observed({
        dbState: 'IMPLEMENTING',
        ciTrigger: 'none',
        localValidationPassed: true,
        git: { branchExists: true, hasCommitsBeyondBase: true, branchPushed: true },
      }),
    );
    expect(report.derivedState).toBe('FINAL_REVIEW');
    expect(report.facts['localValidationPassed']).toBe(true);
  });

  it('relaunches an agent that died mid-implementation', () => {
    const report = reconcileRun(
      observed({
        dbState: 'IMPLEMENTING',
        orca: { worktreeExists: true, agentRunning: false, agentSettled: false },
      }),
    );
    expect(report.action).toBe('relaunch');
    expect(report.reason).toMatch(/interrupted attempt/);
  });

  it('does not let checks from the previous pushed commit bypass an active remediation worker', () => {
    const report = reconcileRun(observed({
      dbState: 'IMPLEMENTING',
        orca: { worktreeExists: true, implementationPending: true, agentRunning: true, agentSettled: false },
      git: { branchExists: true, hasCommitsBeyondBase: true, branchPushed: true },
      github: github({ checksComplete: true, requiredChecksPassed: true }),
    }));

    expect(report.derivedState).toBe('IMPLEMENTING');
    expect(report.action).toBe('noop');
  });

  it('harvests a settled implementation before considering earlier green checks', () => {
    const report = reconcileRun(observed({
      dbState: 'IMPLEMENTING',
      orca: { worktreeExists: true, implementationPending: true, agentRunning: false, agentSettled: true },
      git: { branchExists: true, hasCommitsBeyondBase: true, branchPushed: true },
      github: github({ checksComplete: true, requiredChecksPassed: true }),
    }));

    expect(report.derivedState).toBe('IMPLEMENTING');
    expect(report.action).toBe('resume');
  });

  it('integrates a remediation commit before trusting checks from the previous PR head', () => {
    const report = reconcileRun(observed({
      dbState: 'INTEGRATING',
      orca: { worktreeExists: true, agentRunning: false, agentSettled: true },
      git: {
        branchExists: true,
        hasCommitsBeyondBase: true,
        branchPushed: true,
        integrationPending: true,
      },
      github: github({ checksComplete: true, requiredChecksPassed: true }),
    }));

    expect(report.derivedState).toBe('INTEGRATING');
    expect(report.action).toBe('resume');
    expect(report.reason).toMatch(/worker commit/i);
  });

  it('keeps planning when only the parent worktree exists and no worker work has started', () => {
    const report = reconcileRun(
      observed({
        dbState: 'PLANNING',
        orca: {
          worktreeExists: true,
          planningComplete: false,
          agentRunning: false,
          agentSettled: false,
        },
      }),
    );

    expect(report.derivedState).toBe('PLANNING');
    expect(report.action).toBe('noop');
  });

  it('recovers planning only when persisted tasks prove every planning precondition', () => {
    const report = reconcileRun(
      observed({
        dbState: 'PLANNING',
        orca: {
          worktreeExists: true,
          planningComplete: true,
          agentRunning: false,
          agentSettled: false,
        },
      }),
    );

    expect(report.derivedState).toBe('IMPLEMENTING');
    expect(report.action).toBe('advance');
    expect(report.facts).toEqual({
      planValidated: true,
      ownershipSetsDisjoint: true,
      worktreesCreated: true,
    });
  });

  it('resumes rather than relaunching when the agent finished cleanly', () => {
    const report = reconcileRun(
      observed({
        dbState: 'IMPLEMENTING',
        orca: { worktreeExists: true, agentRunning: false, agentSettled: true },
      }),
    );
    expect(report.action).toBe('resume');
  });

  it('leaves remediation to its persisted plan instead of treating the parent worktree as a dead worker', () => {
    const report = reconcileRun(
      observed({
        dbState: 'REMEDIATING',
        orca: { worktreeExists: true, agentRunning: false, agentSettled: true },
      }),
    );

    expect(report.derivedState).toBe('REMEDIATING');
    expect(report.action).toBe('noop');
  });

  it('leaves a running agent alone', () => {
    const report = reconcileRun(
      observed({ orca: { worktreeExists: true, agentRunning: true, agentSettled: false } }),
    );
    expect(report.action).toBe('noop');
  });

  it('preserves a human block until an explicit operator resume', () => {
    const report = reconcileRun(observed({
      dbState: 'BLOCKED_HUMAN',
      orca: { worktreeExists: true, agentRunning: false, agentSettled: false },
    }));
    expect(report.derivedState).toBe('BLOCKED_HUMAN');
    expect(report.action).toBe('noop');
  });

  it('blocks for a human when the DB claims progress nothing external supports', () => {
    const report = reconcileRun(observed({
      dbState: 'INTEGRATING',
      orca: { worktreeExists: false, agentRunning: false, agentSettled: false },
      git: { branchExists: false, hasCommitsBeyondBase: false, branchPushed: false },
      github: github({ pullRequestNumber: null, checksComplete: false, requiredChecksPassed: false }),
    }));
    expect(report.derivedState).toBe('BLOCKED_HUMAN');
    expect(report.action).toBe('block');
    expect(report.reason).toMatch(/no worktree, branch or pull request/);
  });

  it('does not claim all work disappeared when the parent worktree and branch still exist', () => {
    const report = reconcileRun(observed({
      dbState: 'INTEGRATING',
      orca: { worktreeExists: true, agentRunning: false, agentSettled: true },
      git: { branchExists: true, hasCommitsBeyondBase: false, branchPushed: false },
      github: github({ pullRequestNumber: null, checksComplete: false, requiredChecksPassed: false }),
    }));

    expect(report.derivedState).toBe('INTEGRATING');
    expect(report.action).toBe('noop');
  });

  it('does not treat unavailable systems as evidence that work disappeared', () => {
    const report = reconcileRun(observed({ dbState: 'INTEGRATING' }));
    expect(report.derivedState).toBe('INTEGRATING');
    expect(report.action).toBe('noop');
    expect(report.reason).toMatch(/could not be fully observed/);
  });

  it('does nothing for a queued run that never started', () => {
    const report = reconcileRun(observed({ dbState: 'QUEUED' }));
    expect(report.action).toBe('noop');
  });
});

describe('reconciliation respects the state machine', () => {
  it('refuses to apply an illegal derived transition', () => {
    // MERGED is terminal; nothing may move it back.
    const report = {
      runId: 'r',
      issueId: 'i',
      dbState: 'MERGED' as WorkflowState,
      derivedState: 'CI' as WorkflowState,
      action: 'advance' as const,
      reason: 'test',
      facts: {},
    };
    expect(applicable(report)).toBe(false);
  });

  it('treats a no-change reconciliation as nothing to do', () => {
    const report = reconcileRun(observed({ dbState: 'CI', github: github({ checksComplete: false }) }));
    expect(applicable(report)).toBe(false);
  });
});
