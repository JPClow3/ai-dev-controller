import { describe, expect, it } from 'vitest';
import { assessReview, unaddressedCriteria, toPrComments, type ReviewResult } from '../../src/reviews/review.js';
import { buildFinalReviewPacket, stripAnchoring, containsAnchoring, renderPacket } from '../../src/reviews/packet.js';
import { planRemediation } from '../../src/reviews/remediation.js';
import { loadControllerConfig } from '../../src/config/load-config.js';

const escalation = loadControllerConfig(process.cwd()).escalation;
const BLOCKING = escalation.reviewRemediation.blockingSeverities;

const finding = (over: Partial<ReviewResult['findings'][number]> = {}) => ({
  severity: 'high' as const,
  category: 'correctness',
  acceptance_criterion: 'AC-1',
  file: 'src/a.ts',
  explanation: 'off-by-one in the pagination boundary',
  suggested_validation: 'add a test for the last page',
  ...over,
});

const review = (over: Partial<ReviewResult> = {}): ReviewResult => ({
  verdict: 'approve',
  issue_id: 'UNI-1',
  stage: 'final',
  reviewer: { id: 'glm_5_2' },
  findings: [],
  criteria: [{ id: 'AC-1', status: 'satisfied' }],
  ...over,
});

describe('anchoring is stripped, not just avoided', () => {
  it('redacts prior verdicts from text the reviewer will see', () => {
    const dirty = 'Worker reported all requirements are satisfied. LGTM, previous reviewer approved.';
    const clean = stripAnchoring(dirty);
    expect(clean).not.toMatch(/LGTM/i);
    expect(clean).not.toMatch(/approved/i);
    expect(clean).not.toMatch(/requirements are satisfied/i);
    expect(containsAnchoring(clean)).toBe(false);
  });

  it('scrubs the curated issue and original issue in the packet', () => {
    const packet = buildFinalReviewPacket({
      issueId: 'UNI-1',
      originalIssue: 'Terra says this implementation is excellent',
      curatedIssue: 'Previous reviewer approved the approach',
      acceptanceCriteria: [{ id: 'AC-1', statement: 'x' }],
      agentsMd: '',
      architectureSummary: '',
      diff: '',
      changedFiles: [],
    });
    expect(containsAnchoring(packet.originalIssue)).toBe(false);
    expect(containsAnchoring(packet.curatedIssue)).toBe(false);
  });

  it('carries objective CI evidence rather than an opinion about it', () => {
    const packet = buildFinalReviewPacket({
      issueId: 'UNI-1',
      originalIssue: '',
      curatedIssue: '',
      acceptanceCriteria: [],
      agentsMd: '',
      architectureSummary: '',
      diff: '',
      changedFiles: [],
      checks: {
        headSha: 'abc',
        complete: true,
        allRequiredPassed: true,
        checks: [{ name: 'test', state: 'SUCCESS', conclusion: 'SUCCESS', required: true }],
        pending: [],
        failed: [],
      },
    });
    expect(packet.ciEvidence).toContain('required checks passed: true');
    expect(renderPacket(packet)).toContain('Objective validation evidence');
  });

  it('identifies the tests that changed', () => {
    const packet = buildFinalReviewPacket({
      issueId: 'UNI-1',
      originalIssue: '',
      curatedIssue: '',
      acceptanceCriteria: [],
      agentsMd: '',
      architectureSummary: '',
      diff: '',
      changedFiles: ['src/a.ts', 'tests/a.test.ts', 'src/b.spec.ts'],
    });
    expect(packet.testsChanged).toEqual(['tests/a.test.ts', 'src/b.spec.ts']);
  });
});

describe('the controller trusts evidence over the stated verdict', () => {
  it('downgrades an approval that leaves blocking findings', () => {
    const a = assessReview(review({ findings: [finding({ severity: 'critical' })] }), BLOCKING);
    expect(a.verdict).toBe('request_changes');
    expect(a.clearsForPr).toBe(false);
    expect(a.inconsistencies[0]).toMatch(/approved despite/);
  });

  it('downgrades an approval with an unsatisfied criterion', () => {
    const a = assessReview(review({ criteria: [{ id: 'AC-1', status: 'unsatisfied' }] }), BLOCKING);
    expect(a.verdict).toBe('request_changes');
    expect(a.inconsistencies[0]).toMatch(/unsatisfied criteria/);
  });

  it('accepts a clean approval', () => {
    const a = assessReview(review(), BLOCKING);
    expect(a.verdict).toBe('approve');
    expect(a.clearsForPr).toBe(true);
  });

  it('does not treat medium and low findings as blocking', () => {
    const a = assessReview(
      review({ findings: [finding({ severity: 'medium' }), finding({ severity: 'low' })] }),
      BLOCKING,
    );
    expect(a.blocking).toHaveLength(0);
    expect(a.nonBlocking).toHaveLength(2);
    expect(a.clearsForPr).toBe(true);
  });

  it('turns non-blocking findings into PR comments rather than rework', () => {
    const a = assessReview(review({ findings: [finding({ severity: 'low' })] }), BLOCKING);
    expect(toPrComments(a)[0]).toContain('src/a.ts');
  });

  it('flags an escalation with no reason', () => {
    const a = assessReview(review({ verdict: 'escalate' }), BLOCKING);
    expect(a.inconsistencies).toContain('escalated without a reason');
  });

  it('treats an unaddressed criterion as unaddressed, not passed', () => {
    expect(unaddressedCriteria(review(), ['AC-1', 'AC-2'])).toEqual(['AC-2']);
  });
});

describe('remediation is bounded and routed away from the author', () => {
  const assessment = assessReview(review({ verdict: 'request_changes', findings: [finding()] }), BLOCKING);

  it('sends the fix to a different worker than the author', () => {
    const plan = planRemediation(
      { assessment, cyclesUsed: 0, originalAuthors: ['deepseek_flash'] },
      escalation,
    );
    expect(plan.proceed).toBe(true);
    expect(plan.tasks[0]!.excludeAliases).toContain('deepseek_flash');
  });

  it('blocks for a human once the cycle budget is spent', () => {
    const plan = planRemediation(
      { assessment, cyclesUsed: escalation.limits.reviewRemediationCycles, originalAuthors: ['x'] },
      escalation,
    );
    expect(plan.proceed).toBe(false);
    expect(plan.blockedReason).toMatch(/budget exhausted/);
  });

  it('lets the orchestrator dismiss a finding the reviewer got wrong', () => {
    const plan = planRemediation(
      {
        assessment,
        cyclesUsed: 0,
        originalAuthors: ['x'],
        validated: () => ({ valid: false, why: 'the reviewer misread the guard clause' }),
      },
      escalation,
    );
    expect(plan.proceed).toBe(false);
    expect(plan.dismissed).toHaveLength(1);
    expect(plan.dismissed[0]!.why).toMatch(/misread/);
  });

  it('treats an unvalidated finding as valid', () => {
    const plan = planRemediation({ assessment, cyclesUsed: 0, originalAuthors: ['x'] }, escalation);
    expect(plan.tasks).toHaveLength(1);
  });

  it('does nothing when there is nothing blocking', () => {
    const clean = assessReview(review(), BLOCKING);
    const plan = planRemediation({ assessment: clean, cyclesUsed: 0, originalAuthors: [] }, escalation);
    expect(plan.proceed).toBe(false);
    expect(plan.tasks).toHaveLength(0);
  });

  it('instructs the worker to fix only the defect', () => {
    const plan = planRemediation({ assessment, cyclesUsed: 0, originalAuthors: ['x'] }, escalation);
    expect(plan.tasks[0]!.instruction).toMatch(/Do not re-implement/);
  });
});
