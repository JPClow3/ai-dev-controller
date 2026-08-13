import type { ControllerDatabase } from '../db.js';

export function createTaskRepositories(db: ControllerDatabase) {
  return {
    /** Persists the planner's decomposition so integration has something to read. */
    recordTasks(
      runId: string,
      tasks: Array<{
        id: string;
        summary?: string;
        task_category?: string;
        owns?: string[];
        blocked_by?: string[];
        acceptance_criteria?: string[];
        risk?: string;
        branch?: string;
        orcaWorktreeId?: string;
      }>,
    ): void {
      const insert = db.raw.prepare(
        `INSERT INTO tasks (run_id, task_key, summary, role, risk, owns_json, blocked_by_json, criteria_json, branch, orca_worktree_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, task_key) DO UPDATE SET
           summary=excluded.summary, role=excluded.role, risk=excluded.risk,
           owns_json=excluded.owns_json, blocked_by_json=excluded.blocked_by_json,
           criteria_json=excluded.criteria_json, branch=excluded.branch,
           orca_worktree_id=excluded.orca_worktree_id`,
      );
      db.transaction(() => {
        for (const task of tasks) {
          insert.run(
            runId,
            task.id,
            task.summary ?? null,
            task.task_category ?? null,
            task.risk ?? 'low',
            JSON.stringify(task.owns ?? []),
            JSON.stringify(task.blocked_by ?? []),
            JSON.stringify(task.acceptance_criteria ?? []),
            task.branch ?? null,
            task.orcaWorktreeId ?? null,
          );
        }
      });
    },

    /**
     * Every task of a run, in plan order.
     *
     * Dispatch needs this to find tasks whose blockers have finished; without
     * it a plan with any sequential step silently loses the dependent half.
     */
    runTasks(runId: string): Array<{
      id: string;
      summary: string;
      task_category: string;
      owns: string[];
      blocked_by: string[];
      acceptance_criteria: string[];
      risk: string;
      state: string;
      branch: string | null;
      orcaWorktreeId: string | null;
    }> {
      const rows = db.raw
        .prepare(
          `SELECT task_key, summary, role, risk, owns_json, blocked_by_json, criteria_json,
                  state, branch, orca_worktree_id
             FROM tasks WHERE run_id = ? ORDER BY id`,
        )
        .all(runId) as Array<{
        task_key: string;
        summary: string | null;
        role: string | null;
        risk: string;
        owns_json: string;
        blocked_by_json: string;
        criteria_json: string;
        state: string;
        branch: string | null;
        orca_worktree_id: string | null;
      }>;

      const list = (json: string): string[] => {
        try {
          const parsed = JSON.parse(json) as unknown;
          return Array.isArray(parsed) ? (parsed as string[]) : [];
        } catch {
          return [];
        }
      };

      return rows.map((row) => ({
        id: row.task_key,
        summary: row.summary ?? '',
        task_category: row.role ?? 'routine_behavior',
        owns: list(row.owns_json),
        blocked_by: list(row.blocked_by_json),
        acceptance_criteria: list(row.criteria_json),
        risk: row.risk,
        state: row.state,
        branch: row.branch,
        orcaWorktreeId: row.orca_worktree_id,
      }));
    },

    setTaskState(runId: string, taskKey: string, state: string): void {
      db.raw.prepare('UPDATE tasks SET state = ? WHERE run_id = ? AND task_key = ?').run(state, runId, taskKey);
    },

    /**
     * Attaches the outcome to a task's newest attempt.
     *
     * `workerCommits` reads this, and nothing was ever writing it: every
     * integration therefore found zero commits and every run died at
     * INTEGRATING with "no worker produced any commit".
     */
    recordAttemptResult(runId: string, taskKey: string, result: unknown): void {
      const row = db.raw
        .prepare(
          `SELECT a.id AS id FROM attempts a
             JOIN tasks t ON t.id = a.task_id
            WHERE t.run_id = ? AND t.task_key = ? AND a.role = 'worker'
            ORDER BY a.attempt_no DESC LIMIT 1`,
        )
        .get(runId, taskKey) as { id: number } | undefined;
      if (!row) return;
      const commits = (result as { commits?: Array<{ sha?: string }> })?.commits;
      const headSha = Array.isArray(commits) && commits.length > 0
        ? commits[commits.length - 1]?.sha ?? null
        : null;
      db.raw
        .prepare(`UPDATE attempts SET result_json = ?, head_sha = ?, ended_at = datetime('now') WHERE id = ?`)
        .run(JSON.stringify(result), headSha, row.id);
    },

    /**
     * Records one model attempt against a task.
     *
     * These rows are what integration, reviewer selection and the provenance
     * body all read. With the table empty, cross-family reviewer choice
     * silently degrades to "first candidate" without any error.
     */
    recordAttempt(
      runId: string,
      taskKey: string,
      attempt: { aliasId: string; role: string; isChallenger?: boolean; result?: unknown; failureClass?: string },
    ): number {
      return db.transaction(() => {
        const task = db.raw
          .prepare('SELECT id FROM tasks WHERE run_id = ? AND task_key = ?')
          .get(runId, taskKey) as { id: number } | undefined;
        if (!task) throw new Error(`No task "${taskKey}" for run ${runId}`);

        const next = db.raw
          .prepare('SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM attempts WHERE task_id = ?')
          .get(task.id) as { n: number };

        const info = db.raw
          .prepare(
            `INSERT INTO attempts (task_id, attempt_no, alias_id, role, is_challenger, result_json, failure_class)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            task.id,
            next.n,
            attempt.aliasId,
            attempt.role,
            attempt.isChallenger ? 1 : 0,
            attempt.result === undefined ? null : JSON.stringify(attempt.result),
            attempt.failureClass ?? null,
          );
        return Number(info.lastInsertRowid);
      });
    },

    /** Durable per-task attempt count used by interrupted-worker recovery. */
    workerAttemptCount(runId: string, taskKey: string): number {
      const row = db.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM attempts a
             JOIN tasks t ON t.id = a.task_id
            WHERE t.run_id = ? AND t.task_key = ? AND a.role = 'worker'`,
        )
        .get(runId, taskKey) as { n: number };
      return row.n;
    },

    /** Workers launched but not yet harvested by a controller tick. */
    activeWorkerCount(runId?: string): number {
      const row = db.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks
            WHERE state = 'DISPATCHED'${runId ? ' AND run_id = ?' : ''}`,
        )
        .get(...(runId ? [runId] : [])) as { n: number };
      return row.n;
    },

    activeWorkerCountForRepository(repositoryId: string): number {
      const row = db.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks
             JOIN runs ON runs.id = tasks.run_id
            WHERE tasks.state = 'DISPATCHED' AND runs.repository_id = ?`,
        )
        .get(repositoryId) as { n: number };
      return row.n;
    },

    latestWorkerAttempt(runId: string, taskKey: string): { aliasId: string; isChallenger: boolean; startedAt: string; baseSha: string | null } | null {
      const row = db.raw
        .prepare(
          `SELECT a.alias_id, a.is_challenger, a.started_at, a.base_sha FROM attempts a
             JOIN tasks t ON t.id = a.task_id
            WHERE t.run_id = ? AND t.task_key = ? AND a.role = 'worker'
            ORDER BY a.attempt_no DESC LIMIT 1`,
        )
        .get(runId, taskKey) as { alias_id: string; is_challenger: number; started_at: string; base_sha: string | null } | undefined;
      return row
        ? { aliasId: row.alias_id, isChallenger: row.is_challenger === 1, startedAt: row.started_at, baseSha: row.base_sha }
        : null;
    },

    /** Captured before the external worker starts, so retries have disjoint diffs. */
    setWorkerAttemptBaseSha(runId: string, taskKey: string, baseSha: string): void {
      db.raw.prepare(
        `UPDATE attempts SET base_sha = COALESCE(base_sha, ?) WHERE id = (
           SELECT a.id FROM attempts a JOIN tasks t ON t.id = a.task_id
            WHERE t.run_id = ? AND t.task_key = ? AND a.role = 'worker'
            ORDER BY a.attempt_no DESC LIMIT 1
         )`,
      ).run(baseSha, runId, taskKey);
    },

    /** Persists confirmation only after Orca created, or reports, the terminal. */
    markWorkerLaunched(runId: string, taskKey: string): void {
      db.transaction(() => {
        db.raw.prepare('UPDATE tasks SET state = ? WHERE run_id = ? AND task_key = ?')
          .run('DISPATCHED', runId, taskKey);
        db.raw.prepare(
          `UPDATE attempts SET started_at = ? WHERE id = (
             SELECT a.id FROM attempts a
               JOIN tasks t ON t.id = a.task_id
              WHERE t.run_id = ? AND t.task_key = ? AND a.role = 'worker'
              ORDER BY a.attempt_no DESC LIMIT 1
           )`,
        ).run(new Date().toISOString(), runId, taskKey);
      });
    },

    unscoredWorkerAttempts(runId: string): Array<{
      id: number;
      taskKey: string;
      aliasId: string;
      role: string;
      startedAt: string;
      endedAt: string;
      owns: string[];
      criteriaIds: string[];
      orcaWorktreeId: string | null;
      baseSha: string | null;
      headSha: string | null;
      commitShas: string[];
      succeeded: boolean;
    }> {
      const rows = db.raw.prepare(
        `SELECT a.id, a.alias_id, a.started_at, a.ended_at, a.result_json, a.failure_class,
                a.base_sha, a.head_sha,
                t.task_key, t.role, t.owns_json, t.criteria_json, t.orca_worktree_id
           FROM attempts a
           JOIN tasks t ON t.id = a.task_id
          WHERE t.run_id = ? AND a.role = 'worker'
            AND a.composite_score IS NULL AND a.ended_at IS NOT NULL
          ORDER BY a.id`,
      ).all(runId) as Array<{
        id: number; alias_id: string; started_at: string; ended_at: string;
        result_json: string | null; failure_class: string | null; task_key: string;
        role: string | null; owns_json: string; criteria_json: string; orca_worktree_id: string | null;
        base_sha: string | null; head_sha: string | null;
      }>;
      const strings = (json: string): string[] => {
        try {
          const value = JSON.parse(json) as unknown;
          return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
        } catch {
          return [];
        }
      };
      return rows.map((row) => {
        let result: { commits?: Array<{ sha?: string }>; exitCode?: number; failureClass?: string } = {};
        try { result = row.result_json ? JSON.parse(row.result_json) as typeof result : {}; } catch { /* invalid evidence is failure */ }
        return {
          id: row.id,
          taskKey: row.task_key,
          aliasId: row.alias_id,
          role: row.role ?? 'routine_behavior',
          startedAt: row.started_at,
          endedAt: row.ended_at,
          owns: strings(row.owns_json),
          criteriaIds: strings(row.criteria_json),
          orcaWorktreeId: row.orca_worktree_id,
          baseSha: row.base_sha,
          headSha: row.head_sha,
          commitShas: Array.isArray(result.commits)
            ? result.commits.map((commit) => commit.sha).filter((sha): sha is string => typeof sha === 'string' && sha.length > 0)
            : [],
          succeeded:
            row.failure_class === null
            && result.failureClass === undefined
            && result.exitCode === undefined
            && Array.isArray(result.commits)
            && result.commits.length > 0,
        };
      });
    },

    /** Worker branches and their commits, in plan dependency order. */
    workerCommits(runId: string): Array<{ taskKey: string; branch: string; order: number; commits: string[] }> {
      const rows = db.raw
        .prepare('SELECT id, task_key, branch, blocked_by_json FROM tasks WHERE run_id = ? ORDER BY id')
        .all(runId) as Array<{ id: number; task_key: string; branch: string | null; blocked_by_json: string }>;

      return rows.map((row, index) => {
        const commits = db.raw
          .prepare(
            `SELECT result_json FROM attempts WHERE task_id = ? AND role = 'worker' ORDER BY attempt_no DESC LIMIT 1`,
          )
          .get(row.id) as { result_json: string | null } | undefined;

        let shas: string[] = [];
        if (commits?.result_json) {
          try {
            const parsed = JSON.parse(commits.result_json) as { commits?: Array<{ sha: string }> };
            shas = (parsed.commits ?? []).map((c) => c.sha);
          } catch {
            shas = [];
          }
        }

        // A task with declared blockers integrates after them.
        let order = index;
        try {
          order = index + (JSON.parse(row.blocked_by_json) as string[]).length * 100;
        } catch {
          /* keep index */
        }

        return { taskKey: row.task_key, branch: row.branch ?? '', order, commits: shas };
      });
    },

    /** Changed lines per alias, for reviewer-independence calculation. */
    attemptAuthorship(runId: string): Array<{ alias: string; changedLines: number }> {
      const rows = db.raw
        .prepare(
          `SELECT a.alias_id, a.result_json FROM attempts a
           JOIN tasks t ON t.id = a.task_id
           WHERE t.run_id = ? AND a.role = 'worker'`,
        )
        .all(runId) as Array<{ alias_id: string; result_json: string | null }>;

      const byAlias = new Map<string, number>();
      for (const row of rows) {
        let lines = 0;
        try {
          const parsed = JSON.parse(row.result_json ?? '{}') as {
            files_changed?: Array<{ insertions?: number; deletions?: number }>;
          };
          lines = (parsed.files_changed ?? []).reduce(
            (sum, f) => sum + (f.insertions ?? 0) + (f.deletions ?? 0),
            0,
          );
        } catch {
          lines = 0;
        }
        byAlias.set(row.alias_id, (byAlias.get(row.alias_id) ?? 0) + lines);
      }
      return [...byAlias].map(([alias, changedLines]) => ({ alias, changedLines }));
    },

    attemptSummary(runId: string): Array<{ alias: string; role: string; taskKey: string | null }> {
      return db.raw
        .prepare(
          `SELECT a.alias_id, a.role, t.task_key FROM attempts a
           JOIN tasks t ON t.id = a.task_id
           WHERE t.run_id = ? ORDER BY a.id`,
        )
        .all(runId)
        .map((r) => {
          const row = r as { alias_id: string; role: string; task_key: string | null };
          return { alias: row.alias_id, role: row.role, taskKey: row.task_key };
        });
    },

    /** Counts remediation waves that were actually materialised as tasks.
     *  State transitions can include recovery and operator corrections; using
     *  them as budget consumption blocked JP-9 before any repair worker ran. */
    remediationCycles(runId: string): number {
      const rows = db.raw
        .prepare(`SELECT task_key FROM tasks WHERE run_id = ? AND task_key LIKE 'remediation-%'`)
        .all(runId) as Array<{ task_key: string }>;
      return new Set(
        rows
          .map((row) => /^remediation-(\d+)-/.exec(row.task_key)?.[1])
          .filter((cycle): cycle is string => cycle !== undefined),
      ).size;
    },
  };
}

