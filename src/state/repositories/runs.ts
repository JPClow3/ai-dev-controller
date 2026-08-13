import { randomUUID } from 'node:crypto';
import type { ControllerDatabase } from '../db.js';
import type { RunRecord } from '../types.js';
import {
  assertTransitionAllowed,
  canRecoverAuthoritatively,
  type TransitionEvidence,
} from '../../workflow/transitions.js';
import { isTerminal, type WorkflowState } from '../../workflow/states.js';

const ACTIVE_CLAUSE = `state NOT IN ('MERGED','FAILED','CANCELLED')`;

interface RunDbRow {
  id: string;
  issue_id: string;
  repository_id: string;
  attempt: number;
  state: string;
  branch: string | null;
  base_sha: string | null;
  orca_worktree_id: string | null;
  started_at: string;
  ended_at: string | null;
}

function toRun(row: RunDbRow): RunRecord {
  return {
    id: row.id,
    issueId: row.issue_id,
    repositoryId: row.repository_id,
    attempt: row.attempt,
    state: row.state as WorkflowState,
    branch: row.branch,
    baseSha: row.base_sha,
    orcaWorktreeId: row.orca_worktree_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function createRunRepositories(db: ControllerDatabase) {
  const findActiveRun = db.raw.prepare(`SELECT * FROM runs WHERE issue_id = ? AND ${ACTIVE_CLAUSE}`);
  const insertRun = db.raw.prepare(
    `INSERT INTO runs (id, issue_id, repository_id, attempt, state) VALUES (?, ?, ?, ?, 'QUEUED')`,
  );
  const countPriorRuns = db.raw.prepare('SELECT COUNT(*) AS n FROM runs WHERE issue_id = ?');
  const getRun = db.raw.prepare('SELECT * FROM runs WHERE id = ?');
  const setRunState = db.raw.prepare('UPDATE runs SET state = ? WHERE id = ?');
  const endRun = db.raw.prepare(`UPDATE runs SET state = ?, ended_at = datetime('now') WHERE id = ?`);
  const auditTransition = db.raw.prepare(
    `INSERT INTO state_transitions (run_id, issue_id, from_state, to_state, actor, recommended_by, reason, facts_json)
     VALUES (?, ?, ?, ?, 'controller', ?, ?, ?)`,
  );
  const setIssueState = db.raw.prepare('UPDATE issues SET state = ?, updated_at = datetime(\'now\') WHERE id = ?');

  return {
    getControllerMeta(key: string): string | null {
      const row = db.raw.prepare('SELECT value FROM controller_meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },

    setControllerMeta(key: string, value: string): void {
      db.raw
        .prepare(
          `INSERT INTO controller_meta (key, value, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        )
        .run(key, value);
    },

    /**
     * Claim the single active run for an issue, or return null if one exists.
     *
     * Correctness rests on the partial unique index `ux_runs_active_issue`,
     * not on this read: two controller processes racing here both see "no
     * active run", and the second INSERT is rejected by the database.
     */
    claimIssueRun(issueId: string, repositoryId: string): RunRecord | null {
      return db.transaction(() => {
        const existing = findActiveRun.get(issueId) as RunDbRow | undefined;
        if (existing) return null;

        const { n } = countPriorRuns.get(issueId) as { n: number };
        const id = randomUUID();
        try {
          insertRun.run(id, issueId, repositoryId, n + 1);
        } catch (err) {
          // Lost the race against another writer; the index did its job.
          if (String(err).includes('UNIQUE')) return null;
          throw err;
        }
        auditTransition.run(id, issueId, null, 'QUEUED', null, 'run claimed', null);
        setIssueState.run('QUEUED', issueId);
        return toRun(getRun.get(id) as RunDbRow);
      });
    },

    getRun(runId: string): RunRecord | null {
      const row = getRun.get(runId) as RunDbRow | undefined;
      return row ? toRun(row) : null;
    },

    getActiveRun(issueId: string): RunRecord | null {
      const row = findActiveRun.get(issueId) as RunDbRow | undefined;
      return row ? toRun(row) : null;
    },

    /**
     * Move a run to a new state.
     *
     * Guard first, write second, audit always. A model's recommendation is
     * recorded in `recommended_by` but never substitutes for the mechanical
     * facts the guard requires.
     */
    transitionRun(runId: string, to: WorkflowState, evidence: TransitionEvidence): RunRecord {
      return db.transaction(() => {
        const row = getRun.get(runId) as RunDbRow | undefined;
        if (!row) throw new Error(`No such run: ${runId}`);
        const from = row.state as WorkflowState;

        assertTransitionAllowed(from, to, evidence);

        if (isTerminal(to)) endRun.run(to, runId);
        else setRunState.run(to, runId);

        auditTransition.run(
          runId,
          row.issue_id,
          from,
          to,
          evidence.recommendedBy ?? null,
          evidence.reason,
          evidence.mechanicalFacts ? JSON.stringify(evidence.mechanicalFacts) : null,
        );
        setIssueState.run(to, row.issue_id);
        return toRun(getRun.get(runId) as RunDbRow);
      });
    },

    /** Fast-forwards stale SQLite only from authoritative external evidence. */
    recoverRunState(runId: string, to: WorkflowState, evidence: TransitionEvidence): RunRecord {
      return db.transaction(() => {
        const row = getRun.get(runId) as RunDbRow | undefined;
        if (!row) throw new Error(`No such run: ${runId}`);
        const from = row.state as WorkflowState;
        const facts = (evidence.mechanicalFacts ?? {}) as Record<string, boolean>;
        if (!canRecoverAuthoritatively(from, to, facts)) {
          throw new Error(`Recovery cannot authoritatively move ${from} -> ${to}`);
        }

        if (isTerminal(to)) endRun.run(to, runId);
        else setRunState.run(to, runId);
        auditTransition.run(
          runId,
          row.issue_id,
          from,
          to,
          evidence.recommendedBy ?? null,
          evidence.reason,
          JSON.stringify({ ...facts, authoritativeRecovery: true }),
        );
        setIssueState.run(to, row.issue_id);
        return toRun(getRun.get(runId) as RunDbRow);
      });
    },

    /** Records where a run's work physically lives. */
    attachRunWorkspace(
      runId: string,
      workspace: { branch?: string; baseSha?: string; orcaWorktreeId?: string },
    ): void {
      db.raw
        .prepare(
          `UPDATE runs SET
             branch = COALESCE(?, branch),
             base_sha = COALESCE(?, base_sha),
             orca_worktree_id = COALESCE(?, orca_worktree_id)
           WHERE id = ?`,
        )
        .run(workspace.branch ?? null, workspace.baseSha ?? null, workspace.orcaWorktreeId ?? null, runId);
    },

    activeRuns(): RunRecord[] {
      return (db.raw.prepare(`SELECT * FROM runs WHERE ${ACTIVE_CLAUSE} ORDER BY started_at`).all() as RunDbRow[])
        .map(toRun);
    },

    recordRemediationPlan(runId: string, tasks: unknown[]): void {
      db.raw.prepare('UPDATE runs SET plan_json = ? WHERE id = ?').run(JSON.stringify(tasks), runId);
    },

    pendingRemediation(runId: string): unknown[] {
      const row = db.raw.prepare('SELECT plan_json FROM runs WHERE id = ?').get(runId) as
        | { plan_json: string | null }
        | undefined;
      if (!row?.plan_json) return [];
      try {
        const parsed = JSON.parse(row.plan_json) as unknown;
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },

    transitionHistory(runId: string): Array<{ from: string | null; to: string; reason: string | null }> {
      return db.raw
        .prepare('SELECT from_state, to_state, reason FROM state_transitions WHERE run_id = ? ORDER BY id')
        .all(runId)
        .map((r) => {
          const row = r as { from_state: string | null; to_state: string; reason: string | null };
          return { from: row.from_state, to: row.to_state, reason: row.reason };
        });
    },
  };
}

