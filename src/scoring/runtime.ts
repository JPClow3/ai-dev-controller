import type { ScoringConfig } from '../config/scoring-schema.js';
import type { Git } from '../git/repository.js';
import { worktreePathFromId } from '../orca/worktrees.js';
import type { ControllerRepositories } from '../state/repositories.js';
import type { CriterionVerdict } from '../state/types.js';
import type { RunRecord } from '../state/types.js';
import { measureChurn } from './churn.js';
import { scoreAttempt } from './composite.js';
import { logger } from '../util/log.js';

const log = logger('scoring');

export interface FinalizeRunScoresInput {
  run: RunRecord;
  repos: ControllerRepositories;
  git: Pick<Git, 'changedFilesBetween'>;
  scoring: ScoringConfig;
}

const DEPENDENCY_FILE = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|uv\.lock)$/i;

function sqliteUtcMs(value: string): number {
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
}

function ownedPrefix(glob: string): string {
  return glob.replace(/\*\*.*$/, '').replace(/\*.*$/, '');
}

function verdict(status: 'satisfied' | 'unsatisfied' | 'uncertain'): CriterionVerdict {
  if (status === 'satisfied') return 'PASS';
  if (status === 'unsatisfied') return 'FAIL';
  return 'UNCERTAIN';
}

/**
 * Converts authoritative end-of-run evidence into immutable worker samples.
 * Missing quota telemetry is scored neutrally (0.5), never as free usage.
 */
export async function finalizeRunScores(input: FinalizeRunScoresInput): Promise<number> {
  const attempts = input.repos.unscoredWorkerAttempts(input.run.id);
  if (attempts.length === 0) return 0;
  if (!input.run.baseSha) throw new Error(`Run ${input.run.id} has no base SHA for scoring`);

  const review = input.repos.lastReview(input.run.id);
  if (!review) throw new Error(`Run ${input.run.id} has no final review for scoring`);
  const criteriaById = new Map(review.criteria.map((criterion) => [criterion.id, criterion]));
  const statements = new Map(input.repos.acceptanceCriteria(input.run.issueId).map((criterion) => [criterion.id, criterion.statement]));
  const remediationCycles = input.repos.remediationCycles(input.run.id);
  const ci = input.repos.ciFailureCount(input.run.id);
  const successfulCiScore = ci.observed
    ? Math.max(0, 1 - ci.failures * input.scoring.firstPassCi.penaltyPerRemediationCycle)
    : 0.5;
  let recorded = 0;

  for (const attempt of attempts) {
    let changed: Array<{ path: string; insertions: number; deletions: number }> = [];
    if (attempt.succeeded) {
      if (!attempt.orcaWorktreeId) throw new Error(`Attempt ${attempt.id} has no worker worktree for scoring`);
      const firstCommit = attempt.commitShas[0];
      const baseSha = attempt.baseSha ?? (firstCommit ? `${firstCommit}^` : null);
      const headSha = attempt.headSha ?? attempt.commitShas[attempt.commitShas.length - 1] ?? null;
      if (!baseSha || !headSha) throw new Error(`Attempt ${attempt.id} has no commit range for scoring`);
      changed = await input.git.changedFilesBetween(
        worktreePathFromId(attempt.orcaWorktreeId),
        baseSha,
        headSha,
      );
    }
    const dependencyFilesChanged = changed.filter((file) => DEPENDENCY_FILE.test(file.path)).map((file) => file.path);
    const dependencyJustified = attempt.criteriaIds.some((id) => /dependenc|package|library/i.test(statements.get(id) ?? ''));
    const churn = measureChurn({
      changed,
      ownedGlobs: attempt.owns,
      dependencyFilesChanged,
      dependencyJustified,
      formattingOnlyFiles: [],
    });
    const criteria = attempt.criteriaIds.map((id) => {
      const criterion = criteriaById.get(id);
      if (!attempt.succeeded) return { id, verdict: 'FAIL' as const };
      return {
        id,
        verdict: criterion ? verdict(criterion.status) : 'UNCERTAIN',
        ...(criterion?.evidence ? { evidence: criterion.evidence } : {}),
      };
    });
    const prefixes = attempt.owns.map(ownedPrefix);
    const findings = review.findings.filter((finding) =>
      (finding.acceptance_criterion !== null && attempt.criteriaIds.includes(finding.acceptance_criterion))
      || prefixes.some((prefix) => finding.file.startsWith(prefix))
      || (finding.acceptance_criterion === null && finding.file.length === 0),
    );
    const startedMs = sqliteUtcMs(attempt.startedAt);
    const endedMs = sqliteUtcMs(attempt.endedAt);
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) {
      throw new Error(`Attempt ${attempt.id} has invalid scoring timestamps`);
    }
    const elapsedMs = Math.max(0, endedMs - startedMs);
    const resourceCost = 0.5;
    const score = scoreAttempt({
      role: attempt.role,
      criteria,
      remediationCycles,
      ciScore: attempt.succeeded ? successfulCiScore : 0,
      findings,
      churnPenalty: churn.penalty,
      resourceCost,
      wallClockMinutes: elapsedMs / 60_000,
    }, input.scoring);
    const success = attempt.succeeded
      && review.verdict === 'approve'
      && criteria.length > 0
      && criteria.every((criterion) => criterion.verdict === 'PASS');

    if (input.repos.recordAttemptScore({
      attemptId: attempt.id,
      projectId: input.run.repositoryId,
      role: attempt.role,
      aliasId: attempt.aliasId,
      composite: score.composite,
      acceptanceCoverage: score.acceptanceCoverage,
      firstPassCi: score.firstPassCi,
      remediationCycles,
      wallClockSeconds: elapsedMs / 1000,
      resourceCost,
      success,
    })) recorded += 1;
  }
  log.info(`${input.run.issueId}: recorded ${recorded} worker score(s)`);
  return recorded;
}
