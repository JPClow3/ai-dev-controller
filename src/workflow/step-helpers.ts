import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Risk } from '../state/types.js';
import type { GitRunner, Git } from '../git/repository.js';
import type { RemediationTask } from '../reviews/remediation.js';
import type { PlanTask, StepContext } from './orchestrator.js';

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export interface WorkerCommitMessageInput {
  issueId: string;
  projectId: string;
  taskId: string;
  taskCategory?: string | undefined;
  taskSummary: string;
  ownedPaths: string[];
  workerSummary: string;
}

function commitKind(taskCategory?: string): 'feat' | 'fix' | 'test' | 'docs' | 'chore' {
  const category = taskCategory?.toLowerCase() ?? '';
  if (category.includes('test')) return 'test';
  if (category.includes('fix') || category.includes('bug')) return 'fix';
  if (category.includes('doc')) return 'docs';
  if (category.includes('feature') || category.includes('implementation')) return 'feat';
  return 'chore';
}

function conciseSummary(summary: string, maxLength: number): string {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  const lowercased = normalized ? `${normalized[0]!.toLowerCase()}${normalized.slice(1)}` : 'update task';
  if (lowercased.length <= maxLength) return lowercased;
  const clipped = lowercased.slice(0, Math.max(1, maxLength - 1));
  return `${clipped.replace(/\s+\S*$/, '').trim()}…`;
}

/** Formats a concise subject and retains unverified worker evidence in the body. */
export function formatWorkerCommitMessage(input: WorkerCommitMessageInput): string {
  const prefix = `${commitKind(input.taskCategory)}(${input.projectId}): `;
  const suffix = ` (${input.issueId})`;
  const subject = `${prefix}${conciseSummary(input.taskSummary, 72 - prefix.length - suffix.length)}${suffix}`;
  return [
    subject,
    '',
    `Task: ${input.taskId}`,
    `Owned paths: ${input.ownedPaths.join(', ')}`,
    '',
    `Verification: ${input.workerSummary || 'No worker verification summary recorded.'}`,
  ].join('\n');
}

/** A task may raise an issue's risk, never lower it. */
export function effectiveTaskRisk(issueRisk: Risk, taskRisk?: Risk): Risk {
  if (!taskRisk) return issueRisk;
  return RISK_RANK[taskRisk] > RISK_RANK[issueRisk] ? taskRisk : issueRisk;
}

/** One task owns one durable child worktree across all bounded attempts. */
export function workerWorktreeName(branch: string, taskId: string): string {
  return `${branch.replace(/\//g, '-')}-${taskId}`;
}

/** Terminals are attempt-scoped so a stale shell cannot confirm a new launch. */
export function workerTerminalTitle(taskId: string, attemptNo: number): string {
  return `worker:${taskId}:attempt:${attemptNo}`;
}

export function shouldWaitForExistingWorkerLaunch(input: {
  resumingDispatch: boolean;
  recentHeartbeat: boolean;
  terminalExists: boolean;
}): boolean {
  return input.resumingDispatch && (input.recentHeartbeat || input.terminalExists);
}

/** Builds one disjoint worker task per affected file for a remediation wave. */
export function remediationPlanTasks(tasks: RemediationTask[], cycle: number): PlanTask[] {
  const byFile = new Map<string, RemediationTask[]>();
  for (const task of tasks) {
    const grouped = byFile.get(task.file) ?? [];
    grouped.push(task);
    byFile.set(task.file, grouped);
  }

  return [...byFile.entries()].map(([file, findings], index) => ({
    id: `remediation-${cycle}-${index}`,
    summary: [
      'Fix only the independently reviewed findings below; do not re-implement the original task.',
      ...findings.flatMap((finding) => [
        '',
        finding.instruction,
        `Verify with: ${finding.suggestedValidation}`,
      ]),
    ].join('\n'),
    // The orchestrator route gives a review repair a different Codex alias
    // from the routine worker in the Codex-only pilot.
    task_category: 'orchestrator',
    owns: [file],
    blocked_by: [],
    acceptance_criteria: [...new Set(
      findings
        .map((finding) => finding.acceptanceCriterion)
        .filter((criterion): criterion is string => criterion !== null),
    )],
    exclude_aliases: [...new Set(findings.flatMap((finding) => finding.excludeAliases))],
  }));
}

export function isRemediationTask(value: unknown): value is RemediationTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<RemediationTask>;
  return typeof task.findingIndex === 'number'
    && typeof task.file === 'string'
    && (typeof task.acceptanceCriterion === 'string' || task.acceptanceCriterion === null)
    && typeof task.instruction === 'string'
    && typeof task.suggestedValidation === 'string'
    && Array.isArray(task.excludeAliases)
    && task.excludeAliases.every((alias) => typeof alias === 'string');
}

/** Remediation edits the integrated result, not the issue's original base. */
export async function alignRemediationWorktree(
  git: Pick<Git, 'headSha' | 'fastForwardTo'>,
  workerPath: string,
  parentPath: string,
): Promise<void> {
  const parentHead = await git.headSha(parentPath);
  await git.fastForwardTo(workerPath, parentHead);
}

/**
 * Preserves a failed attempt's owned diff outside the worktree, then restores
 * exactly the tracked/untracked files it owned. A retry never inherits dirty
 * code from the alias it replaces; any out-of-scope dirt blocks the retry.
 */
export async function cleanFailedAttempt(
  gitRunner: GitRunner,
  workerPath: string,
  owned: string[],
  evidencePath: string,
): Promise<boolean> {
  if (owned.length === 0) return false;
  const run = (args: string[]) => gitRunner(workerPath, args);
  const nulList = (value: string) => value.split('\0').filter(Boolean);
  const tracked = nulList(await run(['diff', '--name-only', '-z', 'HEAD', '--', ...owned]).catch(() => ''));
  const untracked = nulList(await run(['ls-files', '--others', '--exclude-standard', '-z', '--', ...owned]).catch(() => ''));
  const patch = await run(['diff', '--binary', 'HEAD', '--', ...owned]).catch(() => '');
  writeFileSync(evidencePath, [patch, '', '# Untracked files', ...untracked].join('\n'), 'utf8');

  if (tracked.length > 0) {
    await run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]);
  }
  const root = resolve(workerPath);
  const archiveRoot = `${evidencePath}.files`;
  for (const file of untracked) {
    const target = resolve(root, file);
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Refused to clean untracked path outside worker worktree: ${file}`);
    }
    const archived = resolve(archiveRoot, rel);
    const archivedRel = relative(resolve(archiveRoot), archived);
    if (!archivedRel || archivedRel.startsWith('..') || isAbsolute(archivedRel)) {
      throw new Error(`Refused to archive untracked path outside evidence directory: ${file}`);
    }
    mkdirSync(resolve(archived, '..'), { recursive: true });
    if (lstatSync(target).isSymbolicLink()) {
      writeFileSync(`${archived}.symlink.txt`, readlinkSync(target), 'utf8');
    } else {
      copyFileSync(target, archived);
    }
    rmSync(target, { force: true });
  }
  const remaining = await run(['status', '--porcelain', '--untracked-files=all']);
  return remaining.trim().length === 0;
}

export function workerPrompt(ctx: StepContext, task: PlanTask): string {
  return [
    `You are implementing task "${task.id}" for issue ${ctx.run.issueId}.`,
    '',
    task.summary,
    '',
    '## You own ONLY these paths',
    ...task.owns.map((o) => `- ${o}`),
    '',
    'Editing anything outside this set is a scope violation. If the task cannot',
    'be completed without touching another path, stop and say so.',
    '',
    '## Acceptance criteria this task advances',
    ...task.acceptance_criteria.map((c) => `- ${c}`),
    '',
    '## Finishing',
    "This worktree's dependencies were installed for you before you started,",
    'so you can and should run the relevant tests before you finish.',
    '',
    'Leave your changes in the working tree. Do not commit, branch, merge or',
    'push — the controller commits the files you own, on the branch this',
    'worktree already has checked out, once you exit. Anything you change',
    'outside the paths above will NOT be committed and will be reported as a',
    'scope violation, so keep your edits inside them.',
    '',
    'Your last message becomes the commit description. Make it an accurate',
    'account of what you actually changed and what you verified.',
    '',
    `Base branch: ${ctx.baseBranch}. Never merge, never push to the base branch.`,
  ].join('\n');
}
