import { describe, expect, it } from 'vitest';
import { scoreAttempt, componentsOf, resourceCost, type AttemptMetrics } from '../../src/scoring/composite.js';
import { measureChurn } from '../../src/scoring/churn.js';
import { evaluatePromotion, toRecord } from '../../src/scoring/promotion.js';
import { loadControllerConfig } from '../../src/config/load-config.js';

const scoring = loadControllerConfig(process.cwd()).scoring;

const perfect: AttemptMetrics = {
  role: 'routine_bugfix',
  criteria: [
    { id: 'AC-1', verdict: 'PASS', evidence: 'tests/foo.test.ts:12' },
    { id: 'AC-2', verdict: 'PASS', evidence: 'src/bar.ts:30' },
  ],
  remediationCycles: 0,
  findings: [],
  churnPenalty: 0,
  resourceCost: 0,
  wallClockMinutes: 10,
};

describe('composite score', () => {
  it('uses the approved 35/25/15/10/10/5 weighting', () => {
    const w = scoring.weights;
    expect(w.acceptanceCoverage).toBeCloseTo(0.35);
    expect(w.firstPassCi).toBeCloseTo(0.25);
    expect(w.reviewerDefects).toBeCloseTo(0.15);
    expect(w.unnecessaryChurn).toBeCloseTo(0.1);
    expect(w.resourceCost).toBeCloseTo(0.1);
    expect(w.wallClock).toBeCloseTo(0.05);
  });

  it('scores a flawless attempt at 1.0', () => {
    expect(scoreAttempt(perfect, scoring).composite).toBeCloseTo(1.0, 5);
  });

  it('computes the weighted sum from known components', () => {
    const metrics: AttemptMetrics = {
      ...perfect,
      criteria: [{ id: 'AC-1', verdict: 'PARTIAL' }, { id: 'AC-2', verdict: 'PASS', evidence: 'x' }],
      remediationCycles: 1,
      findings: [{ severity: 'medium' }],
      churnPenalty: 0.5,
      resourceCost: 0.2,
      wallClockMinutes: 15,
    };
    const c = componentsOf(metrics, scoring);
    const expected =
      c.acceptanceCoverage * 0.35 +
      c.firstPassCi * 0.25 +
      c.reviewerDefects * 0.15 +
      c.unnecessaryChurn * 0.1 +
      c.resourceCost * 0.1 +
      c.wallClock * 0.05;
    expect(scoreAttempt(metrics, scoring).composite).toBeCloseTo(expected, 6);
  });

  /** Otherwise a model could win by simply claiming success. */
  it('treats an unevidenced PASS as UNCERTAIN', () => {
    const claimed = componentsOf(
      { ...perfect, criteria: [{ id: 'AC-1', verdict: 'PASS' }] },
      scoring,
    );
    const evidenced = componentsOf(
      { ...perfect, criteria: [{ id: 'AC-1', verdict: 'PASS', evidence: 'tests/x.ts:3' }] },
      scoring,
    );
    expect(claimed.acceptanceCoverage).toBeCloseTo(0.25);
    expect(evidenced.acceptanceCoverage).toBeCloseTo(1);
  });

  it('penalises each remediation cycle', () => {
    const one = componentsOf({ ...perfect, remediationCycles: 1 }, scoring).firstPassCi;
    const two = componentsOf({ ...perfect, remediationCycles: 2 }, scoring).firstPassCi;
    expect(one).toBeCloseTo(0.65);
    expect(two).toBeCloseTo(0.3);
  });

  it('weights a critical defect far above a naming nit', () => {
    const critical = componentsOf({ ...perfect, findings: [{ severity: 'critical' }] }, scoring);
    const low = componentsOf({ ...perfect, findings: [{ severity: 'low' }] }, scoring);
    expect(critical.reviewerDefects).toBeCloseTo(0);
    expect(low.reviewerDefects).toBeCloseTo(0.95);
  });

  it('keeps latency a small factor - better code is worth five more minutes', () => {
    const slow = scoreAttempt({ ...perfect, wallClockMinutes: 30 }, scoring);
    expect(1 - slow.composite).toBeLessThan(0.06);
  });

  it('scores zero acceptance when there are no criteria to satisfy', () => {
    expect(componentsOf({ ...perfect, criteria: [] }, scoring).acceptanceCoverage).toBe(0);
  });
});

describe('resource cost is subscription pressure, not dollars', () => {
  it('scales usage by current scarcity', () => {
    expect(resourceCost({ tokensUsed: 500, rollingP90Tokens: 1000, scarcityMultiplier: 1 })).toBeCloseTo(0.5);
    expect(resourceCost({ tokensUsed: 500, rollingP90Tokens: 1000, scarcityMultiplier: 2 })).toBeCloseTo(1);
  });
});

describe('churn is measured, not judged by a model', () => {
  it('penalises edits outside the declared ownership set', () => {
    const churn = measureChurn({
      changed: [
        { path: 'backend/export/service.ts', insertions: 80, deletions: 0 },
        { path: 'web/src/unrelated.ts', insertions: 20, deletions: 0 },
      ],
      ownedGlobs: ['backend/export/**'],
      dependencyFilesChanged: [],
      dependencyJustified: true,
      formattingOnlyFiles: [],
    });
    expect(churn.outsideOwnership).toEqual(['web/src/unrelated.ts']);
    expect(churn.penalty).toBeGreaterThan(0);
  });

  it('is zero for a diff that stayed in scope', () => {
    const churn = measureChurn({
      changed: [{ path: 'backend/export/service.ts', insertions: 40, deletions: 2 }],
      ownedGlobs: ['backend/export/**'],
      dependencyFilesChanged: [],
      dependencyJustified: true,
      formattingOnlyFiles: [],
    });
    expect(churn.penalty).toBe(0);
  });

  it('penalises an unjustified new dependency but not a required one', () => {
    const base = {
      changed: [{ path: 'src/a.ts', insertions: 10, deletions: 0 }],
      ownedGlobs: ['src/**'],
      dependencyFilesChanged: ['package.json'],
      formattingOnlyFiles: [],
    };
    expect(measureChurn({ ...base, dependencyJustified: false }).penalty).toBeGreaterThan(0);
    expect(measureChurn({ ...base, dependencyJustified: true }).penalty).toBe(0);
  });
});

describe('promotion policy', () => {
  const incumbent = { alias: 'luna_high', samples: 40, compositeAvg: 0.70, successRate: 0.8 };

  it('promotes a low-risk challenger that clears every threshold', () => {
    const d = evaluatePromotion(
      {
        projectId: 'lorebound',
        role: 'routine_bugfix',
        risk: 'low',
        incumbent,
        challenger: { alias: 'kimi_code', samples: 12, compositeAvg: 0.79, successRate: 0.75 },
      },
      scoring,
    );
    expect(d.action).toBe('promote');
  });

  it('holds when there are too few samples', () => {
    const d = evaluatePromotion(
      {
        projectId: 'lorebound',
        role: 'routine_bugfix',
        risk: 'low',
        incumbent,
        challenger: { alias: 'kimi_code', samples: 11, compositeAvg: 0.9, successRate: 0.9 },
      },
      scoring,
    );
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/11\/12 samples/);
  });

  it('holds when the advantage is below 8%', () => {
    const d = evaluatePromotion(
      {
        projectId: 'lorebound',
        role: 'routine_bugfix',
        risk: 'low',
        incumbent,
        challenger: { alias: 'kimi_code', samples: 20, compositeAvg: 0.75, successRate: 0.9 },
      },
      scoring,
    );
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/below the 8% threshold/);
  });

  it('holds when the success rate is under 70% however good the score', () => {
    const d = evaluatePromotion(
      {
        projectId: 'lorebound',
        role: 'routine_bugfix',
        risk: 'low',
        incumbent,
        challenger: { alias: 'kimi_code', samples: 20, compositeAvg: 0.95, successRate: 0.6 },
      },
      scoring,
    );
    expect(d.action).toBe('hold');
  });

  it('only proposes on medium risk, never promotes', () => {
    const d = evaluatePromotion(
      {
        projectId: 'lorebound',
        role: 'routine_bugfix',
        risk: 'medium',
        incumbent,
        challenger: { alias: 'kimi_code', samples: 20, compositeAvg: 0.95, successRate: 0.95 },
      },
      scoring,
    );
    expect(d.action).toBe('propose');
    if (d.action === 'propose') expect(d.automatic).toBe(false);
  });

  it('never moves high-risk routing, no matter the evidence', () => {
    const d = evaluatePromotion(
      {
        projectId: 'lorebound',
        role: 'high_risk',
        risk: 'high',
        incumbent,
        challenger: { alias: 'kimi_code', samples: 500, compositeAvg: 0.99, successRate: 1 },
      },
      scoring,
    );
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/locked/);
  });

  it('journals every change with a rationale and a rollback target', () => {
    const input = {
      projectId: 'lorebound',
      role: 'routine_bugfix',
      risk: 'low' as const,
      incumbent,
      challenger: { alias: 'kimi_code', samples: 15, compositeAvg: 0.82, successRate: 0.8 },
    };
    const record = toRecord(input, evaluatePromotion(input, scoring));
    expect(record).not.toBeNull();
    expect(record!.fromAlias).toBe('luna_high');
    expect(record!.toAlias).toBe('kimi_code');
    expect(record!.automatic).toBe(true);
    expect(record!.reason).toMatch(/composite advantage/);
  });

  it('journals nothing when the decision is to hold', () => {
    const input = {
      projectId: 'lorebound',
      role: 'routine_bugfix',
      risk: 'low' as const,
      incumbent,
      challenger: { alias: 'kimi_code', samples: 2, compositeAvg: 0.9, successRate: 0.9 },
    };
    expect(toRecord(input, evaluatePromotion(input, scoring))).toBeNull();
  });
});
