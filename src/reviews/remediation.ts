import type { EscalationConfig } from '../config/escalation-schema.js';
import type { Finding, ReviewAssessment } from './review.js';

export interface RemediationTask {
  /** The finding this addresses, so the reviewer can recheck precisely. */
  findingIndex: number;
  file: string;
  acceptanceCriterion: string | null;
  instruction: string;
  suggestedValidation: string;
  /** Never the worker that wrote the code under review. */
  excludeAliases: string[];
}

export interface RemediationPlan {
  proceed: boolean;
  cycle: number;
  tasks: RemediationTask[];
  blockedReason?: string;
  /** Findings the orchestrator judged invalid, with why. */
  dismissed: Array<{ finding: Finding; why: string }>;
}

export interface RemediationInput {
  assessment: ReviewAssessment;
  /** Cycles already spent on this run. */
  cyclesUsed: number;
  /** Aliases that authored the code under review. */
  originalAuthors: string[];
  /**
   * Orchestrator validation of each blocking finding. The original author does
   * NOT get to judge whether the reviewer was right — that is the orchestrator's
   * call, and an unvalidated finding is treated as valid.
   */
  validated?: (finding: Finding) => { valid: boolean; why?: string };
}

/**
 * Plans remediation for blocking findings.
 *
 * Two rules carry most of the weight:
 *   - a different worker performs the fix, so the model that made the mistake
 *     is not asked to see it
 *   - the cycle budget is finite; exhaustion means a human, not another lap
 */
export function planRemediation(input: RemediationInput, escalation: EscalationConfig): RemediationPlan {
  const cycle = input.cyclesUsed + 1;
  const dismissed: Array<{ finding: Finding; why: string }> = [];
  const unresolvedCriteria = new Set([
    ...input.assessment.unsatisfiedCriteria,
    ...input.assessment.uncertainCriteria,
  ]);
  // Severity decides whether an otherwise-satisfied change is worth rework.
  // It must not make an acceptance-criterion gap disappear: a low-severity
  // test omission can still be the only reason a required criterion remains
  // uncertain, as the JP-9 pilot demonstrated.
  const actionable = [
    ...input.assessment.blocking,
    ...input.assessment.nonBlocking.filter(
      (finding) => finding.acceptance_criterion !== null
        && unresolvedCriteria.has(finding.acceptance_criterion),
    ),
  ].filter((finding, index, all) => all.indexOf(finding) === index);

  if (actionable.length === 0) {
    return { proceed: false, cycle, tasks: [], dismissed };
  }

  if (input.cyclesUsed >= escalation.limits.reviewRemediationCycles) {
    return {
      proceed: false,
      cycle,
      tasks: [],
      dismissed,
      blockedReason: `Review remediation budget exhausted after ${input.cyclesUsed} cycle(s). ${actionable.length} actionable finding(s) remain.`,
    };
  }

  const tasks: RemediationTask[] = [];
  actionable.forEach((finding, index) => {
    const check = input.validated?.(finding) ?? { valid: true };
    if (!check.valid) {
      dismissed.push({ finding, why: check.why ?? 'orchestrator judged the finding invalid' });
      return;
    }
    tasks.push({
      findingIndex: index,
      file: finding.file,
      acceptanceCriterion: finding.acceptance_criterion,
      instruction: `${finding.explanation}\n\nFix only this. Do not re-implement the task.`,
      suggestedValidation: finding.suggested_validation,
      excludeAliases: input.originalAuthors,
    });
  });

  if (tasks.length === 0) {
    // Every finding was dismissed: nothing to fix, and the run can proceed.
    return { proceed: false, cycle, tasks: [], dismissed };
  }

  return { proceed: true, cycle, tasks, dismissed };
}

/**
 * The smallest useful packet for a remediation worker.
 *
 * Deliberately not the whole task: the next worker should fix the identified
 * defect, not redo work that already passed, and not rewrite functioning code
 * because it would have done it differently.
 */
export function remediationPacket(task: RemediationTask, context: {
  acceptanceCriterion?: string;
  currentDiff: string;
  failureOutput?: string;
  files: string[];
}): string {
  return [
    '# Remediation',
    '',
    '## What to fix',
    task.instruction,
    '',
    ...(context.acceptanceCriterion
      ? ['## Acceptance criterion', context.acceptanceCriterion, '']
      : []),
    '## How to verify',
    task.suggestedValidation,
    '',
    ...(context.failureOutput ? ['## Failure output', '```', context.failureOutput, '```', ''] : []),
    '## Files in scope',
    ...context.files.map((f) => `- ${f}`),
    '',
    '## Current diff',
    '```diff',
    context.currentDiff,
    '```',
    '',
    'Fix the identified defect only. Everything else in this diff already passed review.',
  ].join('\n');
}
