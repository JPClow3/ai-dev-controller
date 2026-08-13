import type { ControllerDatabase } from '../db.js';
import type {
  AcceptanceCriterion,
  DependencyRow,
  IssueRow,
  ProjectRow,
  Risk,
} from '../types.js';

export function createIssueRepositories(db: ControllerDatabase) {
  return {
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

    upsertIssue(
      issue: Pick<IssueRow, 'id' | 'projectId' | 'title'> & Partial<IssueRow> & { body?: string },
    ): void {
      db.raw
        .prepare(
          `INSERT INTO issues (id, project_id, title, role, risk, state, acceptance_json, url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             project_id=excluded.project_id, title=excluded.title,
             role=COALESCE(excluded.role, issues.role),
             risk=COALESCE(excluded.risk, issues.risk), updated_at=datetime('now'),
             -- Refresh criteria when the caller supplied some, but never
             -- overwrite a populated set with an empty one: an issue edited
             -- mid-run must not silently lose the yardstick it is graded by.
             acceptance_json=CASE
               WHEN excluded.acceptance_json IN ('[]', '') THEN issues.acceptance_json
               ELSE excluded.acceptance_json
             END,
             url=COALESCE(excluded.url, issues.url)`,
        )
        .run(
          issue.id,
          issue.projectId,
          issue.title,
          issue.role ?? null,
          issue.risk ?? null,
          issue.state ?? 'DISCOVERED',
          JSON.stringify(issue.acceptanceCriteria ?? []),
          issue.url ?? null,
        );
      // Keep the raw Linear description available even before the curator has
      // run. Without it the planner receives a placeholder and correctly
      // refuses, which stalls the pipeline for the wrong reason.
      if (issue.body !== undefined) {
        db.raw
          .prepare('UPDATE issues SET curated_body = COALESCE(curated_body, ?) WHERE id = ?')
          .run(issue.body, issue.id);
      }
    },

    /** Replaces a rough Linear description with the curator's validated contract. */
    recordCuratedIssue(
      issueId: string,
      curated: {
        title: string;
        body: string;
        role: string;
        risk: Risk;
        acceptanceCriteria: AcceptanceCriterion[];
      },
    ): void {
      const result = db.raw
        .prepare(
          `UPDATE issues SET
             title = ?, curated_body = ?, role = ?, risk = ?,
             acceptance_json = ?, state = 'WAITING_READY', updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(
          curated.title,
          curated.body,
          curated.role,
          curated.risk,
          JSON.stringify(curated.acceptanceCriteria),
          issueId,
        );
      if (result.changes !== 1) throw new Error(`Cannot curate unknown issue: ${issueId}`);
    },

    /** Replaces the explicit blocker set for an issue. Linear is authoritative. */
    setDependencies(issueId: string, blockers: string[]): void {
      db.transaction(() => {
        const current = db.raw
          .prepare('SELECT blocked_by FROM issue_dependencies WHERE issue_id = ? AND source = \'linear\'')
          .all(issueId) as Array<{ blocked_by: string }>;
        const wanted = new Set(blockers);
        const remove = db.raw.prepare(
          'DELETE FROM issue_dependencies WHERE issue_id = ? AND blocked_by = ? AND source = \'linear\'',
        );
        for (const row of current) {
          if (!wanted.has(row.blocked_by)) remove.run(issueId, row.blocked_by);
        }
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

    /** Curated body, or null when the curator has not run yet. */
    getIssueContract(issueId: string): string | null {
      const row = db.raw.prepare('SELECT curated_body FROM issues WHERE id = ?').get(issueId) as
        | { curated_body: string | null }
        | undefined;
      return row?.curated_body ?? null;
    },

    issueRouting(issueId: string): { role: string; risk: Risk } {
      const row = db.raw.prepare('SELECT role, risk FROM issues WHERE id = ?').get(issueId) as
        | { role: string | null; risk: Risk | null }
        | undefined;
      return {
        role: row?.role ?? 'routine_behavior',
        risk: row?.risk ?? 'low',
      };
    },

    issueUrl(issueId: string): string | null {
      const row = db.raw.prepare('SELECT url FROM issues WHERE id = ?').get(issueId) as
        | { url: string | null }
        | undefined;
      return row?.url ?? null;
    },

    issueTitle(issueId: string): string | null {
      const row = db.raw.prepare('SELECT title FROM issues WHERE id = ?').get(issueId) as
        | { title: string | null }
        | undefined;
      return row?.title ?? null;
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
  };
}

