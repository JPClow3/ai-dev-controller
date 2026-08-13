import type { ControllerDatabase } from '../db.js';
import type { Severity } from '../types.js';
import type { CommandOutcome, ValidationSummary } from '../../validation/result.js';

export function createReviewRepositories(db: ControllerDatabase) {
  return {
    recordReview(runId: string, review: { stage?: string; reviewer?: { id?: string }; verdict: string; findings?: unknown; criteria?: unknown }): void {
      db.raw
        .prepare(
          `INSERT INTO reviews (run_id, stage, reviewer_alias, verdict, findings_json, criteria_json, cycle)
           VALUES (?, ?, ?, ?, ?, ?, (SELECT COUNT(*) + 1 FROM reviews WHERE run_id = ?))`,
        )
        .run(
          runId,
          review.stage ?? 'final',
          review.reviewer?.id ?? 'unknown',
          review.verdict,
          JSON.stringify(review.findings ?? []),
          JSON.stringify(review.criteria ?? []),
          runId,
        );
    },

    /** The most recent review, so PR_READY reports the verdict actually given. */
    lastReview(runId: string): {
      verdict: 'approve' | 'request_changes' | 'escalate';
      issue_id: string;
      stage: 'integration' | 'final';
      reviewer: { id: string };
      findings: Array<{
        severity: Severity;
        category: string;
        acceptance_criterion: string | null;
        file: string;
        lines?: string;
        explanation: string;
        suggested_validation: string;
      }>;
      criteria: Array<{
        id: string;
        status: 'satisfied' | 'unsatisfied' | 'uncertain';
        evidence?: string;
      }>;
    } | null {
      const row = db.raw
        .prepare('SELECT stage, reviewer_alias, verdict, findings_json, criteria_json FROM reviews WHERE run_id = ? ORDER BY id DESC LIMIT 1')
        .get(runId) as
        | { stage: string; reviewer_alias: string; verdict: string; findings_json: string; criteria_json: string }
        | undefined;
      if (!row) return null;
      const parse = <T>(json: string, fallback: T): T => {
        try {
          return JSON.parse(json) as T;
        } catch {
          return fallback;
        }
      };
      return {
        verdict: row.verdict as 'approve' | 'request_changes' | 'escalate',
        issue_id: '',
        stage: row.stage as 'integration' | 'final',
        reviewer: { id: row.reviewer_alias },
        findings: parse(row.findings_json, []),
        criteria: parse(row.criteria_json, []),
      };
    },

    recordValidation(runId: string, summary: { passed: boolean; results: unknown[] }): void {
      db.raw
        .prepare(
          `INSERT INTO ci_runs (run_id, head_sha, status, conclusion, checks_json)
           VALUES (?, 'local', 'completed', ?, ?)`,
        )
        .run(runId, summary.passed ? 'success' : 'failure', JSON.stringify(summary.results));
    },

    /** Persists objective remote-CI observations without duplicating polling snapshots. */
    recordCiObservation(runId: string, input: {
      headSha: string;
      complete: boolean;
      allRequiredPassed: boolean;
      checks: unknown[];
    }): void {
      const status = input.complete ? 'completed' : 'pending';
      const conclusion = input.complete ? (input.allRequiredPassed ? 'success' : 'failure') : null;
      const checks = JSON.stringify(input.checks);
      const latest = db.raw.prepare(
        `SELECT head_sha, status, conclusion, checks_json FROM ci_runs
          WHERE run_id = ? AND head_sha != 'local' ORDER BY id DESC LIMIT 1`,
      ).get(runId) as { head_sha: string; status: string; conclusion: string | null; checks_json: string } | undefined;
      if (latest?.head_sha === input.headSha && latest.status === status
        && latest.conclusion === conclusion && latest.checks_json === checks) return;
      db.raw.prepare(
        `INSERT INTO ci_runs (run_id, head_sha, status, conclusion, checks_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(runId, input.headSha, status, conclusion, checks);
    },

    /** Remote CI only. Local validation and review remediation are separate evidence. */
    ciFailureCount(runId: string): { observed: boolean; failures: number } {
      const rows = db.raw.prepare(
        `SELECT head_sha, conclusion, checks_json FROM ci_runs
          WHERE run_id = ? AND head_sha != 'local' AND status = 'completed'
          ORDER BY id`,
      ).all(runId) as Array<{ head_sha: string; conclusion: string | null; checks_json: string }>;
      const failures = new Set<string>();
      const passing = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
      for (const row of rows) {
        let checks: Array<{ name?: string; required?: boolean; conclusion?: string | null; githubRunId?: number }> = [];
        try { checks = JSON.parse(row.checks_json) as typeof checks; } catch { /* malformed evidence is not counted */ }
        for (const check of checks) {
          if (check.required === false || !check.conclusion || passing.has(check.conclusion)) continue;
          failures.add(check.githubRunId !== undefined
            ? `run:${check.githubRunId}`
            : `check:${row.head_sha}:${check.name ?? '(unnamed)'}:${check.conclusion}`);
        }
      }
      return {
        observed: rows.length > 0,
        failures: failures.size,
      };
    },

    ciRetryRequested(runId: string, githubRunId: number): boolean {
      const row = db.raw
        .prepare(`SELECT 1 FROM ci_runs WHERE run_id = ? AND github_run_id = ? AND status = 'rerun_requested' LIMIT 1`)
        .get(runId, githubRunId);
      return row !== undefined;
    },

    recordCiRetry(runId: string, headSha: string, githubRunId: number, checks: unknown[]): void {
      db.raw
        .prepare(
          `INSERT INTO ci_runs (run_id, head_sha, github_run_id, status, conclusion, checks_json)
           VALUES (?, ?, ?, 'rerun_requested', NULL, ?)`,
        )
        .run(runId, headSha, githubRunId, JSON.stringify(checks));
    },

    lastValidation(runId: string): ValidationSummary | null {
      const row = db.raw
        .prepare(`SELECT conclusion, checks_json FROM ci_runs WHERE run_id = ? AND head_sha = 'local' ORDER BY id DESC LIMIT 1`)
        .get(runId) as { conclusion: string; checks_json: string } | undefined;
      if (!row) return null;
      try {
        const results = JSON.parse(row.checks_json) as CommandOutcome[];
        return {
          passed: row.conclusion === 'success',
          failedRequired: results.filter((r) => r.required && !r.passed).map((r) => r.name),
          results,
        };
      } catch {
        return null;
      }
    },
  };
}

