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
