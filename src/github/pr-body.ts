export interface PrCriterion {
  id: string;
  statement: string;
  satisfied: boolean;
}

export interface PrWorker {
  alias: string;
  taskSummary: string;
}

export interface PrValidation {
  name: string;
  passed: boolean;
}

export interface PrBodyInput {
  issueId: string;
  issueUrl?: string;
  summary: string;
  criteria: PrCriterion[];
  implementationNotes: string;
  validation: PrValidation[];
  ciChecks?: PrValidation[];
  planner: string;
  workers: PrWorker[];
  integrationReviewer?: string | null;
  finalReviewer: string;
  knowledgeStatus: 'VERIFIED' | 'UNVERIFIED';
  risks: string[];
  reviewNotes: string[];
  baseSha?: string;
  remediationCycles?: number;
}

const tick = (ok: boolean) => (ok ? 'x' : ' ');
const mark = (ok: boolean) => (ok ? 'pass' : 'FAIL');

/**
 * The pull request body.
 *
 * Its whole purpose is provenance: you should be able to judge the PR without
 * digging through agent logs. Which model planned it, which models wrote which
 * parts, who reviewed it, what actually passed, and — critically — whether the
 * repository's knowledge was verified at the time.
 */
export function renderPrBody(input: PrBodyInput): string {
  const lines: string[] = [];

  lines.push('## Linear', '');
  lines.push(input.issueUrl ? `[${input.issueId}](${input.issueUrl})` : input.issueId, '');

  lines.push('## Summary', '', input.summary.trim() || '_none provided_', '');

  lines.push('## Acceptance criteria', '');
  if (input.criteria.length === 0) {
    lines.push('_no criteria recorded_');
  } else {
    for (const c of input.criteria) lines.push(`- [${tick(c.satisfied)}] ${c.id}: ${c.statement}`);
  }
  lines.push('');

  lines.push('## Implementation', '', input.implementationNotes.trim() || '_none provided_', '');

  lines.push('## Validation', '');
  if (input.validation.length === 0) {
    // Silence here would read as "nothing to report" rather than "nothing ran".
    lines.push('**No local validation commands were declared by this repository.**');
  } else {
    for (const v of input.validation) lines.push(`- ${v.name}: ${mark(v.passed)}`);
  }
  if (input.ciChecks && input.ciChecks.length > 0) {
    lines.push('', '### CI');
    for (const c of input.ciChecks) lines.push(`- ${c.name}: ${mark(c.passed)}`);
  }
  lines.push('');

  lines.push('## AI execution', '');
  lines.push(`Planner: ${input.planner}`, '');
  lines.push('Workers:');
  if (input.workers.length === 0) lines.push('- _none recorded_');
  for (const w of input.workers) lines.push(`- ${w.alias} — ${w.taskSummary}`);
  lines.push('');
  if (input.integrationReviewer) lines.push(`Integration review: ${input.integrationReviewer}`, '');
  lines.push(`Independent review: ${input.finalReviewer}`, '');
  if (input.remediationCycles !== undefined) {
    lines.push(`Remediation cycles: ${input.remediationCycles}`, '');
  }
  if (input.baseSha) lines.push(`Base: \`${input.baseSha.slice(0, 12)}\``, '');

  lines.push('## Knowledge status', '');
  lines.push(input.knowledgeStatus);
  if (input.knowledgeStatus === 'UNVERIFIED') {
    lines.push(
      '',
      '_The repository knowledge bootstrap has not been merged, so the agents worked from an unverified map of this repository._',
    );
  }
  lines.push('');

  lines.push('## Risks', '');
  if (input.risks.length === 0) lines.push('_none identified_');
  for (const r of input.risks) lines.push(`- ${r}`);
  lines.push('');

  lines.push('## Manual review notes', '');
  if (input.reviewNotes.length === 0) lines.push('_none_');
  for (const n of input.reviewNotes) lines.push(`- ${n}`);
  lines.push('');

  lines.push('---', '', '_Opened by ai-dev-controller. You are the merge authority._');

  return lines.join('\n');
}

/** Placeholder body for the PR opened purely to trigger CI. */
export function renderStubPrBody(issueId: string): string {
  return [
    `## Linear`,
    '',
    issueId,
    '',
    '## Status',
    '',
    '**Work in progress — do not review or merge yet.**',
    '',
    'This draft pull request was opened so CI has something to run against.',
    'The full description, validation results and execution provenance are',
    'written once checks and independent review have completed.',
    '',
    '---',
    '',
    '_Opened by ai-dev-controller._',
  ].join('\n');
}
