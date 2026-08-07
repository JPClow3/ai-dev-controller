import { NotImplementedError } from '../util/errors.js';

/**
 * PR description generator. The point is provenance: you should be able to
 * judge the PR without digging through agent logs.
 *
 * ## Linear
 * ## Summary
 * ## Acceptance criteria     (checked, from the reviewer's verdicts)
 * ## Implementation
 * ## Validation              (lint / typecheck / tests / build)
 * ## AI execution            (planner, each worker + what it wrote, reviewers)
 * ## Knowledge status        (VERIFIED / UNVERIFIED)
 * ## Risks
 * ## Manual review notes
 */
export interface PrBodyInput {
  issueId: string;
  issueUrl: string;
  summary: string;
  criteria: Array<{ id: string; statement: string; satisfied: boolean }>;
  implementationNotes: string;
  validation: Array<{ name: string; passed: boolean }>;
  planner: string;
  workers: Array<{ workerId: string; taskSummary: string }>;
  integrationReviewer: string | null;
  finalReviewer: string;
  knowledgeStatus: 'VERIFIED' | 'UNVERIFIED';
  risks: string[];
  reviewNotes: string[];
}

export function render(_input: PrBodyInput): string {
  throw new NotImplementedError('pr-body.render');
}
