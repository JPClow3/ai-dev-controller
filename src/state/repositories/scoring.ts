import type { ControllerDatabase } from '../db.js';

export function createScoringRepositories(db: ControllerDatabase) {
  return {
    /** Stores one immutable attempt score and updates routing aggregates once. */
    recordAttemptScore(input: {
      attemptId: number;
      projectId: string;
      role: string;
      aliasId: string;
      composite: number;
      acceptanceCoverage: number;
      firstPassCi: number;
      remediationCycles: number;
      wallClockSeconds: number;
      resourceCost: number;
      success: boolean;
    }): boolean {
      return db.transaction(() => {
        const updated = db.raw.prepare(
          `UPDATE attempts
              SET composite_score = ?, wall_clock_s = ?, resource_cost = ?
            WHERE id = ? AND composite_score IS NULL`,
        ).run(input.composite, input.wallClockSeconds, input.resourceCost, input.attemptId);
        if (updated.changes !== 1) return false;

        const updateAggregate = (scope: 'global' | 'repository', projectId: string | null) => {
          const existing = db.raw.prepare(
            `SELECT id, samples, composite_avg, acceptance_avg, first_pass_ci,
                    avg_remediations, success_rate
               FROM routing_stats
              WHERE scope = ? AND role = ? AND alias_id = ?
                AND ((? IS NULL AND project_id IS NULL) OR project_id = ?)`,
          ).get(scope, input.role, input.aliasId, projectId, projectId) as {
            id: number; samples: number; composite_avg: number | null; acceptance_avg: number | null;
            first_pass_ci: number | null; avg_remediations: number | null; success_rate: number | null;
          } | undefined;
          const prior = existing?.samples ?? 0;
          const samples = prior + 1;
          const mean = (oldValue: number | null | undefined, value: number) =>
            ((oldValue ?? 0) * prior + value) / samples;

          const times = db.raw.prepare(
            `SELECT a.wall_clock_s AS seconds
               FROM attempts a
               JOIN tasks t ON t.id = a.task_id
               JOIN runs r ON r.id = t.run_id
              WHERE a.composite_score IS NOT NULL AND a.alias_id = ? AND t.role = ?
                AND (? IS NULL OR r.repository_id = ?)
              ORDER BY a.wall_clock_s`,
          ).all(input.aliasId, input.role, projectId, projectId) as Array<{ seconds: number }>;
          const minutes = times.map((row) => row.seconds / 60).sort((a, b) => a - b);
          const middle = Math.floor(minutes.length / 2);
          const median = minutes.length % 2 === 0
            ? ((minutes[middle - 1] ?? 0) + (minutes[middle] ?? 0)) / 2
            : (minutes[middle] ?? 0);

          if (existing) {
            db.raw.prepare(
              `UPDATE routing_stats SET samples = ?, composite_avg = ?, acceptance_avg = ?,
                 first_pass_ci = ?, avg_remediations = ?, median_minutes = ?, success_rate = ?,
                 updated_at = datetime('now') WHERE id = ?`,
            ).run(
              samples,
              mean(existing.composite_avg, input.composite),
              mean(existing.acceptance_avg, input.acceptanceCoverage),
              mean(existing.first_pass_ci, input.firstPassCi),
              mean(existing.avg_remediations, input.remediationCycles),
              median,
              mean(existing.success_rate, input.success ? 1 : 0),
              existing.id,
            );
          } else {
            db.raw.prepare(
              `INSERT INTO routing_stats
                 (scope, project_id, role, alias_id, samples, composite_avg, acceptance_avg,
                  first_pass_ci, avg_remediations, median_minutes, success_rate)
               VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
            ).run(
              scope, projectId, input.role, input.aliasId, input.composite,
              input.acceptanceCoverage, input.firstPassCi, input.remediationCycles,
              median, input.success ? 1 : 0,
            );
          }
        };

        updateAggregate('repository', input.projectId);
        updateAggregate('global', null);
        return true;
      });
    },

    /** Per-repository, per-role evidence for one alias, or null with no samples. */
    aliasStats(
      projectId: string,
      role: string,
      alias: string,
    ): { samples: number; compositeAvg: number | null; successRate: number | null; medianMinutes: number | null } | null {
      const row = db.raw
        .prepare(
          `SELECT samples, composite_avg, success_rate, median_minutes FROM routing_stats
           WHERE scope = 'repository' AND project_id = ? AND role = ? AND alias_id = ?`,
        )
        .get(projectId, role, alias) as
        | { samples: number; composite_avg: number | null; success_rate: number | null; median_minutes: number | null }
        | undefined;
      if (!row) return null;
      return {
        samples: row.samples,
        compositeAvg: row.composite_avg,
        successRate: row.success_rate,
        medianMinutes: row.median_minutes,
      };
    },

    routingStats(): Array<{
      scope: string;
      projectId: string | null;
      role: string;
      aliasId: string;
      samples: number;
      compositeAvg: number | null;
      firstPassCi: number | null;
      successRate: number | null;
    }> {
      return db.raw
        .prepare(
          'SELECT scope, project_id, role, alias_id, samples, composite_avg, first_pass_ci, success_rate FROM routing_stats ORDER BY role, composite_avg DESC',
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
            first_pass_ci: number | null;
            success_rate: number | null;
          };
          return {
            scope: row.scope,
            projectId: row.project_id,
            role: row.role,
            aliasId: row.alias_id,
            samples: row.samples,
            compositeAvg: row.composite_avg,
            firstPassCi: row.first_pass_ci,
            successRate: row.success_rate,
          };
        });
    },
  };
}

