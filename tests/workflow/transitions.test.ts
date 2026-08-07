import { describe, expect, it } from 'vitest';
import {
  assertTransitionAllowed,
  isLegalTransition,
  InvalidTransitionError,
} from '../../src/workflow/transitions.js';
import { WORKFLOW_STATES, projectToLinear, isTerminal } from '../../src/workflow/states.js';

/** Convenience: mechanical facts the guard demands, all proven true. */
const proven = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, true]));

describe('workflow transitions', () => {
  it('allows QUEUED -> PLANNING once preconditions are proven', () => {
    expect(isLegalTransition('QUEUED', 'PLANNING')).toBe(true);
    expect(() =>
      assertTransitionAllowed('QUEUED', 'PLANNING', {
        reason: 'wave is ready',
        mechanicalFacts: proven('dependenciesMerged', 'capacityAvailable', 'freshBaseFetched'),
      }),
    ).not.toThrow();
  });

  it('rejects QUEUED -> IMPLEMENTING, which would skip planning', () => {
    expect(isLegalTransition('QUEUED', 'IMPLEMENTING')).toBe(false);
    expect(() =>
      assertTransitionAllowed('QUEUED', 'IMPLEMENTING', { reason: 'go faster' }),
    ).toThrow(InvalidTransitionError);
  });

  it('rejects a legal edge whose mechanical preconditions are unproven', () => {
    expect(() => assertTransitionAllowed('QUEUED', 'PLANNING', { reason: 'looks ready' })).toThrow(
      /unproven mechanical preconditions/,
    );
  });

  it('will not accept a model claim in place of a CI fact', () => {
    // The model says the build is fine. The guard wants requiredCiPassed.
    expect(() =>
      assertTransitionAllowed('CI', 'FINAL_REVIEW', {
        reason: 'implementation and validation succeeded',
        recommendedBy: 'terra_high',
      }),
    ).toThrow(/requiredCiPassed/);

    expect(() =>
      assertTransitionAllowed('CI', 'FINAL_REVIEW', {
        reason: 'required checks green',
        recommendedBy: 'terra_high',
        mechanicalFacts: proven('requiredCiPassed'),
      }),
    ).not.toThrow();
  });

  it('never lets a run reach PR_READY with blocking findings outstanding', () => {
    expect(() =>
      assertTransitionAllowed('FINAL_REVIEW', 'PR_READY', {
        reason: 'reviewer approved',
        mechanicalFacts: { requiredCiPassed: true, noBlockingFindings: false, retryBudgetRemaining: true },
      }),
    ).toThrow(/noBlockingFindings/);
  });

  it('requires a human merge fact before MERGED', () => {
    expect(() =>
      assertTransitionAllowed('PR_OPEN', 'MERGED', { reason: 'done' }),
    ).toThrow(/mergedByHuman/);
  });

  it('lets any active state escalate to an exceptional state with a reason', () => {
    for (const from of WORKFLOW_STATES) {
      // Terminal states are done, and a state cannot escalate to itself.
      if (isTerminal(from) || from === 'BLOCKED_HUMAN') continue;
      expect(() =>
        assertTransitionAllowed(from, 'BLOCKED_HUMAN', { reason: 'undocumented product decision' }),
      ).not.toThrow();
    }
  });

  it('refuses an exceptional transition with an empty reason', () => {
    expect(() => assertTransitionAllowed('IMPLEMENTING', 'BLOCKED_HUMAN', { reason: '  ' })).toThrow(
      /machine-readable reason/,
    );
  });

  it('does not allow escape from MERGED or CANCELLED', () => {
    expect(isLegalTransition('MERGED', 'QUEUED')).toBe(false);
    expect(isLegalTransition('CANCELLED', 'QUEUED')).toBe(false);
  });

  it('rejects self-transitions', () => {
    expect(isLegalTransition('IMPLEMENTING', 'IMPLEMENTING')).toBe(false);
  });

  it('remediation can re-enter any earlier verification stage', () => {
    for (const to of ['IMPLEMENTING', 'INTEGRATING', 'LOCAL_VALIDATION', 'CI', 'FINAL_REVIEW'] as const) {
      expect(isLegalTransition('REMEDIATING', to)).toBe(true);
    }
  });
});

describe('Linear projection', () => {
  it('maps every workflow state', () => {
    for (const state of WORKFLOW_STATES) {
      expect(projectToLinear(state)).not.toBeUndefined();
    }
  });

  it('never projects ai-ready, which is a human input', () => {
    for (const state of WORKFLOW_STATES) {
      expect(projectToLinear(state)).not.toBe('ai-ready');
    }
  });

  it('hides internal churn behind ai-running', () => {
    for (const state of ['QUEUED', 'PLANNING', 'IMPLEMENTING', 'INTEGRATING', 'REMEDIATING'] as const) {
      expect(projectToLinear(state)).toBe('ai-running');
    }
  });

  it('shows blockers distinctly from work in progress', () => {
    expect(projectToLinear('DEPENDENCY_BLOCKED')).toBe('ai-blocked');
    expect(projectToLinear('BLOCKED_HUMAN')).toBe('ai-blocked');
    expect(projectToLinear('PR_OPEN')).toBe('ai-pr-open');
  });
});
