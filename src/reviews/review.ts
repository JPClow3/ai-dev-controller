import type { Severity } from '../state/types.js';

export type ReviewVerdict = 'approve' | 'request_changes' | 'escalate';
export type CriterionStatus = 'satisfied' | 'unsatisfied' | 'uncertain';

export interface Finding {
  severity: Severity;
  category: string;
  acceptance_criterion: string | null;
  file: string;
  lines?: string;
  explanation: string;
  suggested_validation: string;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  issue_id: string;
  stage: 'integration' | 'final';
  reviewer: { id: string; family?: string; selection_reason?: string };
  findings: Finding[];
  criteria: Array<{ id: string; status: CriterionStatus; evidence?: string }>;
  escalation_reason?: string;
  summary?: string;
}

export interface ReviewAssessment {
  verdict: ReviewVerdict;
  blocking: Finding[];
  nonBlocking: Finding[];
  unsatisfiedCriteria: string[];
  uncertainCriteria: string[];
  /** True only when nothing blocks a PR. */
  clearsForPr: boolean;
  inconsistencies: string[];
}

/**
 * Interprets a review, and cross-checks it against itself.
 *
 * A reviewer that approves while leaving an acceptance criterion unsatisfied
 * is contradicting itself. The controller trusts the *evidence* over the
 * verdict, so such a review is downgraded rather than accepted.
 */
export function assessReview(
  review: ReviewResult,
  blockingSeverities: Severity[],
): ReviewAssessment {
  // Older schema revisions allowed an omitted empty findings array. Keep the
  // assessment boundary total even when reading one of those persisted
  // reviews; current invocations require both arrays in review.schema.json.
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const criteria = Array.isArray(review.criteria) ? review.criteria : [];
  const blockingSet = new Set(blockingSeverities);
  const blocking = findings.filter((f) => blockingSet.has(f.severity));
  const nonBlocking = findings.filter((f) => !blockingSet.has(f.severity));

  const unsatisfied = criteria.filter((c) => c.status === 'unsatisfied').map((c) => c.id);
  const uncertain = criteria.filter((c) => c.status === 'uncertain').map((c) => c.id);

  const inconsistencies: string[] = [];
  if (review.verdict === 'approve' && blocking.length > 0) {
    inconsistencies.push(
      `approved despite ${blocking.length} blocking finding(s): ${blocking.map((b) => b.severity).join(', ')}`,
    );
  }
  if (review.verdict === 'approve' && unsatisfied.length > 0) {
    inconsistencies.push(`approved with unsatisfied criteria: ${unsatisfied.join(', ')}`);
  }
  if (review.verdict === 'approve' && uncertain.length > 0) {
    inconsistencies.push(`approved with uncertain criteria: ${uncertain.join(', ')}`);
  }
  if (review.verdict === 'escalate' && !review.escalation_reason) {
    inconsistencies.push('escalated without a reason');
  }

  // Evidence wins over the stated verdict.
  const verdict: ReviewVerdict =
    inconsistencies.length > 0 && review.verdict === 'approve' ? 'request_changes' : review.verdict;

  return {
    verdict,
    blocking,
    nonBlocking,
    unsatisfiedCriteria: unsatisfied,
    uncertainCriteria: uncertain,
    clearsForPr:
      verdict === 'approve' && blocking.length === 0 && unsatisfied.length === 0 && uncertain.length === 0,
    inconsistencies,
  };
}

/**
 * Criteria the reviewer failed to address at all.
 *
 * Silence is not satisfaction: an unaddressed criterion is treated as
 * uncertain, not passed.
 */
export function unaddressedCriteria(review: ReviewResult, expected: string[]): string[] {
  const seen = new Set(review.criteria.map((c) => c.id));
  return expected.filter((id) => !seen.has(id));
}

/** Makes reviewer silence explicit before the result is persisted or used. */
export function withUnaddressedCriteria(review: ReviewResult, expected: string[]): ReviewResult {
  const missing = unaddressedCriteria(review, expected);
  if (missing.length === 0) return review;
  return {
    ...review,
    criteria: [
      ...review.criteria,
      ...missing.map((id) => ({
        id,
        status: 'uncertain' as const,
        evidence: 'Reviewer did not address this acceptance criterion.',
      })),
    ],
  };
}

/** Non-blocking findings become PR comments rather than remediation work. */
export function toPrComments(assessment: ReviewAssessment): string[] {
  return assessment.nonBlocking.map(
    (f) => `**${f.severity}** (${f.category}) \`${f.file}${f.lines ? `:${f.lines}` : ''}\` — ${f.explanation}`,
  );
}
