import type { AcceptanceCriterion } from '../state/types.js';
import type { ValidationSummary } from '../validation/result.js';
import type { ChecksSummary } from '../github/checks.js';

export interface ReviewPacket {
  stage: 'integration' | 'final';
  issueId: string;
  originalIssue: string;
  curatedIssue: string;
  acceptanceCriteria: AcceptanceCriterion[];
  repositoryInstructions: string;
  diff: string;
  testsChanged: string[];
  /** Current full-file context for changed text files, capped by the caller. */
  currentFiles: Record<string, string>;
  ciEvidence: string;
  architectureSummary: string;
}

export interface FinalReviewInput {
  issueId: string;
  originalIssue: string;
  curatedIssue: string;
  acceptanceCriteria: AcceptanceCriterion[];
  agentsMd: string;
  architectureSummary: string;
  diff: string;
  changedFiles: string[];
  currentFiles?: Record<string, string>;
  checks?: ChecksSummary;
  localValidation?: ValidationSummary;
}

/** Phrases that leak a prior verdict into the reviewer's context. */
const ANCHORING_PATTERNS: RegExp[] = [
  /\blooks good\b/gi,
  /\bLGTM\b/gi,
  /\bapproved\b/gi,
  /\bapprove\b/gi,
  /\brequirements? (are|is) satisfied\b/gi,
  /\ball (tests|criteria) (pass|satisfied)\b/gi,
  /\bimplementation is (excellent|complete|correct|good)\b/gi,
  /\bprevious reviewer\b/gi,
  /\bthe reviewer (said|thought|found)\b/gi,
];

/**
 * Strips prior verdicts from anything the reviewer will see.
 *
 * The independent reviewer exists precisely to form its own view. A stray
 * "worker reported all requirements satisfied" in a commit message is enough
 * to anchor it, so the packet is scrubbed rather than merely assembled
 * carefully.
 */
export function stripAnchoring(text: string): string {
  let out = text;
  for (const pattern of ANCHORING_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

export function containsAnchoring(text: string): boolean {
  return ANCHORING_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(text);
  });
}

function renderCi(input: FinalReviewInput): string {
  if (input.checks) {
    const lines = [
      `head: ${input.checks.headSha}`,
      `required checks passed: ${input.checks.allRequiredPassed}`,
      ...input.checks.checks.map((c) => `- ${c.name}: ${c.state}${c.required ? ' (required)' : ''}`),
    ];
    return lines.join('\n');
  }
  if (input.localValidation) {
    return [
      'No CI in this repository; local validation is the authority.',
      ...input.localValidation.results.map(
        (r) => `- ${r.name}: exit ${r.exitCode}${r.required ? ' (required)' : ''}`,
      ),
    ].join('\n');
  }
  return 'No objective validation evidence available.';
}

/**
 * Builds the final-review packet.
 *
 * Deliberately excluded: previous reviewer verdicts, worker self-assessments,
 * and any statement that the implementation is complete. That omission is the
 * whole point of the stage.
 */
export function buildFinalReviewPacket(input: FinalReviewInput): ReviewPacket {
  return {
    stage: 'final',
    issueId: input.issueId,
    originalIssue: stripAnchoring(input.originalIssue),
    curatedIssue: stripAnchoring(input.curatedIssue),
    acceptanceCriteria: input.acceptanceCriteria,
    repositoryInstructions: input.agentsMd,
    diff: input.diff,
    testsChanged: input.changedFiles.filter((f) => /(^|\/)(tests?|__tests__|spec)\//i.test(f) || /\.(test|spec)\./i.test(f)),
    currentFiles: Object.fromEntries(
      Object.entries(input.currentFiles ?? {}).map(([path, content]) => [path, stripAnchoring(content)]),
    ),
    ciEvidence: renderCi(input),
    architectureSummary: input.architectureSummary,
  };
}

/** The integration reviewer looks for seams between workers, so it does get
 *  the plan and ownership sets — but still no prior verdicts. */
export function buildIntegrationReviewPacket(
  input: FinalReviewInput & { plan: string; ownership: Record<string, string[]> },
): ReviewPacket & { plan: string; ownership: Record<string, string[]> } {
  return {
    ...buildFinalReviewPacket(input),
    stage: 'integration',
    plan: stripAnchoring(input.plan),
    ownership: input.ownership,
  };
}

export function renderPacket(packet: ReviewPacket): string {
  return [
    `# Issue ${packet.issueId}`,
    '',
    '## Original issue',
    packet.originalIssue,
    '',
    '## Curated issue',
    packet.curatedIssue,
    '',
    '## Acceptance criteria',
    ...packet.acceptanceCriteria.map((c) => `- ${c.id}: ${c.statement}`),
    '',
    '## Repository instructions',
    packet.repositoryInstructions,
    '',
    '## Architecture',
    packet.architectureSummary,
    '',
    '## Tests changed',
    packet.testsChanged.length ? packet.testsChanged.map((t) => `- ${t}`).join('\n') : '(none)',
    '',
    '## Current changed-file contents',
    ...(Object.keys(packet.currentFiles).length > 0
      ? Object.entries(packet.currentFiles).flatMap(([path, content]) => [
          `### ${path}`,
          '```',
          content,
          '```',
          '',
        ])
      : ['(unavailable)', '']),
    '## Objective validation evidence',
    packet.ciEvidence,
    '',
    '## Final diff',
    '```diff',
    packet.diff,
    '```',
  ].join('\n');
}
