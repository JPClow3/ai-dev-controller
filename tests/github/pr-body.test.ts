import { describe, expect, it } from 'vitest';
import { renderPrBody, renderStubPrBody, type PrBodyInput } from '../../src/github/pr-body.js';

const base: PrBodyInput = {
  issueId: 'UNI-142',
  issueUrl: 'https://linear.app/unirv/issue/UNI-142',
  summary: 'Persist remember-me sessions.',
  criteria: [
    { id: 'AC-1', statement: 'Sessions survive a browser restart.', satisfied: true },
    { id: 'AC-2', statement: 'Logout invalidates both session types.', satisfied: true },
  ],
  implementationNotes: 'Extended the session cookie lifetime.',
  validation: [
    { name: 'typecheck', passed: true },
    { name: 'test', passed: true },
  ],
  ciChecks: [{ name: 'CI / verify', passed: true }],
  planner: 'terra_high',
  workers: [
    { alias: 'luna_high', taskSummary: 'backend session handling' },
    { alias: 'deepseek_flash', taskSummary: 'unit tests' },
  ],
  integrationReviewer: 'terra_high',
  finalReviewer: 'glm_5_2',
  knowledgeStatus: 'VERIFIED',
  risks: ['Touches authentication.'],
  reviewNotes: [],
  baseSha: 'abcdef1234567890',
  remediationCycles: 1,
};

describe('the PR body carries provenance', () => {
  const body = renderPrBody(base);

  it('links the Linear issue', () => {
    expect(body).toContain('[UNI-142](https://linear.app/unirv/issue/UNI-142)');
  });

  it('leads with an explicit human-review decision', () => {
    expect(body).toMatch(/## Decision\s+Ready for your review — draft PR; you remain the merge authority\./);
  });

  it('shows acceptance criteria as checkable items', () => {
    expect(body).toContain('- [x] AC-1: Sessions survive a browser restart.');
  });

  it('marks an unsatisfied criterion unchecked', () => {
    const partial = renderPrBody({
      ...base,
      criteria: [{ id: 'AC-3', statement: 'Not done.', satisfied: false }],
    });
    expect(partial).toContain('- [ ] AC-3');
  });

  /** So you can judge the PR without reading agent logs. */
  it('names every model that touched the change', () => {
    expect(body).toContain('Planner: terra_high');
    expect(body).toContain('luna_high — backend session handling');
    expect(body).toContain('deepseek_flash — unit tests');
    expect(body).toContain('Integration review: terra_high');
    expect(body).toContain('Independent review: glm_5_2');
  });

  it('reports validation and CI outcomes separately', () => {
    expect(body).toContain('- typecheck: pass');
    expect(body).toContain('- CI / verify: pass');
  });

  it('records remediation cycles rather than hiding them', () => {
    expect(body).toContain('Remediation cycles: 1');
  });

  it('states the human is the merge authority', () => {
    expect(body).toContain('You are the merge authority.');
  });
});

describe('the body is honest about weak evidence', () => {
  /** Silence would read as "nothing to report" instead of "nothing ran". */
  it('says so loudly when no validation commands were declared', () => {
    const body = renderPrBody({ ...base, validation: [], ciChecks: [] });
    expect(body).toContain('**No local validation commands were declared by this repository.**');
  });

  it('explains what UNVERIFIED knowledge means', () => {
    const body = renderPrBody({ ...base, knowledgeStatus: 'UNVERIFIED' });
    expect(body).toContain('UNVERIFIED');
    expect(body).toMatch(/unverified map of this repository/);
  });

  it('shows a failed check as FAIL, not a tick', () => {
    const body = renderPrBody({
      ...base,
      validation: [{ name: 'test', passed: false, command: 'pnpm test' }],
    });
    expect(body).toContain('- test: FAIL');
    expect(body).toContain('`pnpm test`');
  });
});

describe('the CI-trigger stub PR', () => {
  const stub = renderStubPrBody('UNI-142');

  it('warns not to review or merge it yet', () => {
    expect(stub).toContain('**Work in progress — do not review or merge yet.**');
    expect(stub).toMatch(/## Decision\s+Not ready — CI is running\./);
  });

  it('explains why it exists', () => {
    expect(stub).toMatch(/so CI has something to run against/);
  });

  it('makes no claim about validation', () => {
    expect(stub).not.toMatch(/pass/i);
  });
});
