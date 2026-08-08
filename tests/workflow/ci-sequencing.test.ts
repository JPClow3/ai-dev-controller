import { describe, expect, it } from 'vitest';
import { assertTransitionAllowed, InvalidTransitionError } from '../../src/workflow/transitions.js';
import { nextAfterLocalValidation } from '../../src/workflow/states.js';
import { detectCiTrigger } from '../../src/knowledge/derive.js';
import { loadControllerConfig } from '../../src/config/load-config.js';

const proven = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, true]));
const { registry } = loadControllerConfig(process.cwd());

describe('CI trigger decides what follows local validation', () => {
  it('sends a pull_request repository to the draft PR first', () => {
    expect(nextAfterLocalValidation('pull_request')).toBe('PR_DRAFT_OPEN');
  });

  it('sends a branch_push repository straight to CI', () => {
    expect(nextAfterLocalValidation('branch_push')).toBe('CI');
  });

  it('skips CI entirely when the repository has none', () => {
    expect(nextAfterLocalValidation('none')).toBe('FINAL_REVIEW');
  });

  it('refuses to leave LOCAL_VALIDATION without knowing the CI mode', () => {
    expect(() =>
      assertTransitionAllowed('LOCAL_VALIDATION', 'CI', {
        reason: 'go to CI',
        mechanicalFacts: proven('branchPushed'),
      }),
    ).toThrow(/requires the repository ciTrigger/);
  });

  /**
   * The regression that motivated PR_DRAFT_OPEN.
   *
   * Every CI workflow in these repositories fires on `pull_request` or on a
   * push to the base branch. Pushing `ai/UNI-142-...` triggers nothing, so
   * going LOCAL_VALIDATION -> CI would wait forever for checks that can never
   * start.
   */
  it('will not jump to CI on a pull_request repository, where nothing would run', () => {
    expect(() =>
      assertTransitionAllowed('LOCAL_VALIDATION', 'CI', {
        reason: 'branch is pushed, surely CI runs',
        ciTrigger: 'pull_request',
        mechanicalFacts: proven('branchPushed'),
      }),
    ).toThrow(/must be PR_DRAFT_OPEN/);
  });

  it('allows the draft-PR-then-CI sequence on a pull_request repository', () => {
    expect(() =>
      assertTransitionAllowed('LOCAL_VALIDATION', 'PR_DRAFT_OPEN', {
        reason: 'open draft PR to trigger CI',
        ciTrigger: 'pull_request',
        mechanicalFacts: proven('branchPushed'),
      }),
    ).not.toThrow();

    expect(() =>
      assertTransitionAllowed('PR_DRAFT_OPEN', 'CI', {
        reason: 'PR exists, checks started',
        ciTrigger: 'pull_request',
        mechanicalFacts: proven('branchPushed', 'pullRequestExists'),
      }),
    ).not.toThrow();
  });

  it('requires the PR to exist before CI on a pull_request repository', () => {
    expect(() =>
      assertTransitionAllowed('PR_DRAFT_OPEN', 'CI', {
        reason: 'checks started',
        ciTrigger: 'pull_request',
        mechanicalFacts: proven('branchPushed'),
      }),
    ).toThrow(/pullRequestExists/);
  });
});

describe('a repository without CI', () => {
  it('cannot be gated on a CI fact that can never exist', () => {
    expect(() =>
      assertTransitionAllowed('LOCAL_VALIDATION', 'FINAL_REVIEW', {
        reason: 'no CI in this repository',
        ciTrigger: 'none',
        mechanicalFacts: proven('localValidationPassed'),
      }),
    ).not.toThrow();
  });

  it('still demands local validation actually passed', () => {
    expect(() =>
      assertTransitionAllowed('LOCAL_VALIDATION', 'FINAL_REVIEW', {
        reason: 'skip ahead',
        ciTrigger: 'none',
        mechanicalFacts: {},
      }),
    ).toThrow(/localValidationPassed/);
  });

  it('reaches PR_READY on local validation rather than CI', () => {
    expect(() =>
      assertTransitionAllowed('FINAL_REVIEW', 'PR_READY', {
        reason: 'reviewed',
        ciTrigger: 'none',
        mechanicalFacts: proven('localValidationPassed', 'noBlockingFindings', 'retryBudgetRemaining'),
      }),
    ).not.toThrow();
  });
});

describe('the finished PR is still gated', () => {
  it('needs a provenance body, not just an open draft', () => {
    expect(() =>
      assertTransitionAllowed('PR_READY', 'PR_OPEN', {
        reason: 'PR is up',
        mechanicalFacts: proven('pullRequestIsDraft'),
      }),
    ).toThrow(/provenanceBodyWritten/);
  });

  it('does not treat the CI-trigger PR as the finished deliverable', () => {
    // PR_DRAFT_OPEN must not be a shortcut to PR_OPEN.
    expect(() =>
      assertTransitionAllowed('PR_DRAFT_OPEN', 'PR_OPEN', {
        reason: 'PR already exists',
        mechanicalFacts: proven('pullRequestIsDraft', 'provenanceBodyWritten'),
      }),
    ).toThrow(InvalidTransitionError);
  });
});

describe('registry CI modes match the repositories on disk', () => {
  const entries = Object.entries(registry.projects);

  // The production detector, not a second implementation: a naive copy here
  // would have kept passing while the real one was wrong about Portfolio.
  for (const [id, project] of entries) {
    it(`${id} declares the trigger its workflows actually use`, () => {
      expect(project.ci.trigger).toBe(
        detectCiTrigger(project.repository.path, project.repository.baseBranch),
      );
    });
  }

  it('flags every repository running without CI as an explicit weaker mode', () => {
    const noCi = entries.filter(([, p]) => p.ci.trigger === 'none').map(([id]) => id).sort();
    // Not an error, but it must be declared rather than discovered mid-run.
    // Portfolio is here because its workflow targets `master` while the repo
    // is on `main`, so no check has ever run.
    expect(noCi).toEqual(['hefesto-site', 'portfolio']);
  });
});
