import { randomUUID } from 'node:crypto';
import type { ControllerDatabase } from './db.js';
import type { RunRecord, DependencyRow, ProjectRow, IssueRow } from './types.js';
import { assertTransitionAllowed, type TransitionEvidence } from '../workflow/transitions.js';
import { isTerminal, type WorkflowState } from '../workflow/states.js';

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

export function createRepositories(db: ControllerDatabase) {
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

    upsertProject(project: ProjectRow): void {
      db.raw
        .prepare(
          `INSERT INTO projects (id, enabled, repo_path, github_slug, base_branch, linear_project,
                                 knowledge_status, max_agents, routing_profile)
           VALUES (@id, @enabled, @repoPath, @githubSlug, @baseBranch, @linearProject,
                   @knowledgeStatus, @maxAgents, @routingProfile)
           ON CONFLICT(id) DO UPDATE SET
             enabled=excluded.enabled, repo_path=excluded.repo_path,
             github_slug=excluded.github_slug, base_branch=excluded.base_branch,
             linear_project=excluded.linear_project, max_agents=excluded.max_agents,
             routing_profile=excluded.routing_profile, updated_at=datetime('now')`,
        )
        .run({ ...project, enabled: project.enabled ? 1 : 0 });
    },

    upsertIssue(issue: Pick<IssueRow, 'id' | 'projectId' | 'title'> & Partial<IssueRow>): void {
      db.raw
        .prepare(
          `INSERT INTO issues (id, project_id, title, role, risk, state, acceptance_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id=excluded.project_id, title=excluded.title,
             role=excluded.role, risk=excluded.risk, updated_at=datetime('now')`,
        )
        .run(
          issue.id,
          issue.projectId,
          issue.title,
          issue.role ?? null,
          issue.risk ?? null,
          issue.state ?? 'DISCOVERED',
          JSON.stringify(issue.acceptanceCriteria ?? []),
        );
    },

    /** Replaces the explicit blocker set for an issue. Linear is authoritative. */
    setDependencies(issueId: string, blockers: string[]): void {
      db.transaction(() => {
        db.raw.prepare('DELETE FROM issue_dependencies WHERE issue_id = ? AND source = \'linear\'').run(issueId);
        const insert = db.raw.prepare(
          `INSERT OR IGNORE INTO issue_dependencies (issue_id, blocked_by, source) VALUES (?, ?, 'linear')`,
        );
        for (const blocker of blockers) insert.run(issueId, blocker);
      });
    },

    getDependencies(issueId: string): DependencyRow[] {
      const rows = db.raw
        .prepare('SELECT issue_id, blocked_by, source, satisfied_at FROM issue_dependencies WHERE issue_id = ?')
        .all(issueId) as Array<{
        issue_id: string;
        blocked_by: string;
        source: 'linear' | 'manual';
        satisfied_at: string | null;
      }>;
      return rows.map((r) => ({
        issueId: r.issue_id,
        blockedBy: r.blocked_by,
        source: r.source,
        satisfiedAt: r.satisfied_at,
      }));
    },

    /**
     * A blocker becomes satisfied only when its PR is merged. Called from the
     * GitHub sync, never from a model's report.
     */
    markDependencySatisfiedByMerge(mergedIssueId: string): number {
      const result = db.raw
        .prepare(
          `UPDATE issue_dependencies SET satisfied_at = datetime('now')
           WHERE blocked_by = ? AND satisfied_at IS NULL`,
        )
        .run(mergedIssueId);
      return result.changes;
    },

    recordPullRequest(runId: string, pr: {
      number: number;
      url: string;
      draft: boolean;
      headBranch: string;
      baseBranch: string;
    }): void {
      db.raw
        .prepare(
          `INSERT INTO pull_requests (run_id, number, url, draft, head_branch, base_branch)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             number=excluded.number, url=excluded.url, draft=excluded.draft,
             updated_at=datetime('now')`,
        )
        .run(runId, pr.number, pr.url, pr.draft ? 1 : 0, pr.headBranch, pr.baseBranch);
    },

    activeRuns(): RunRecord[] {
      return (db.raw.prepare(`SELECT * FROM runs WHERE ${ACTIVE_CLAUSE} ORDER BY started_at`).all() as RunDbRow[])
        .map(toRun);
    },

    routingStats(): Array<{
      scope: string;
      projectId: string | null;
      role: string;
      aliasId: string;
      samples: number;
      compositeAvg: number | null;
      successRate: number | null;
    }> {
      return db.raw
        .prepare(
          'SELECT scope, project_id, role, alias_id, samples, composite_avg, success_rate FROM routing_stats ORDER BY role, composite_avg DESC',
        )
        .all()
        .map((r) => {
          const row = r as {
            scope: string;
            project_id: string | null;
            role: string;
            alias_id: string;
            samples: number;
            composite_avg: number | null;
            success_rate: number | null;
          };
          return {
            scope: row.scope,
            projectId: row.project_id,
            role: row.role,
            aliasId: row.alias_id,
            samples: row.samples,
            compositeAvg: row.composite_avg,
            successRate: row.success_rate,
          };
        });
    },

    /** Curated body, or null when the curator has not run yet. */
    getIssueContract(issueId: string): string | null {
      const row = db.raw.prepare('SELECT curated_body FROM issues WHERE id = ?').get(issueId) as
        | { curated_body: string | null }
        | undefined;
      return row?.curated_body ?? null;
    },

    acceptanceCriteria(issueId: string): Array<{ id: string; statement: string }> {
      const row = db.raw.prepare('SELECT acceptance_json FROM issues WHERE id = ?').get(issueId) as
        | { acceptance_json: string }
        | undefined;
      if (!row) return [];
      try {
        return JSON.parse(row.acceptance_json) as Array<{ id: string; statement: string }>;
      } catch {
        return [];
      }
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

    /** Counts REMEDIATING entries in the audit trail, which is the only
     *  record that cannot be lost to a restart. */
    remediationCycles(runId: string): number {
      const row = db.raw
        .prepare(`SELECT COUNT(*) AS n FROM state_transitions WHERE run_id = ? AND to_state = 'REMEDIATING'`)
        .get(runId) as { n: number };
      return row.n;
    },

    recordEscalation(issueId: string, runId: string, trigger: string, question: string): void {
      db.raw
        .prepare(
          'INSERT INTO human_escalations (issue_id, run_id, trigger, question) VALUES (?, ?, ?, ?)',
        )
        .run(issueId, runId, trigger, question);
    },

    openEscalations(): Array<{ issueId: string; trigger: string; question: string }> {
      return db.raw
        .prepare('SELECT issue_id, trigger, question FROM human_escalations WHERE resolved = 0 ORDER BY id')
        .all()
        .map((r) => {
          const row = r as { issue_id: string; trigger: string; question: string };
          return { issueId: row.issue_id, trigger: row.trigger, question: row.question };
        });
    },

    setPaused(issueId: string, paused: boolean): void {
      db.raw.prepare('UPDATE issues SET paused = ? WHERE id = ?').run(paused ? 1 : 0, issueId);
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

export type ControllerRepositories = ReturnType<typeof createRepositories>;
