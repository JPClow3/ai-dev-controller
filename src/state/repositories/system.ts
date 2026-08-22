import type { ControllerDatabase } from '../db.js';
import type { Pressure } from '../../routing/types.js';

export function createSystemRepositories(db: ControllerDatabase) {
  return {
    recordEscalation(issueId: string, runId: string, trigger: string, question: string): void {
      db.raw
        .prepare(
          'INSERT INTO human_escalations (issue_id, run_id, trigger, question) VALUES (?, ?, ?, ?)',
        )
        .run(issueId, runId, trigger, question);
    },

    setProviderPressure(
      provider: string,
      value: {
        pressure: Pressure;
        remainingAllowance: number | null;
        source: string;
        manualOverride: boolean;
        resetAt: string | null;
      },
    ): void {
      db.raw
        .prepare(
          `INSERT INTO provider_pressure
             (provider, pressure, remaining_allowance, source, manual_override, reset_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(provider) DO UPDATE SET
             pressure = excluded.pressure,
             remaining_allowance = excluded.remaining_allowance,
             source = excluded.source,
             manual_override = excluded.manual_override,
             reset_at = excluded.reset_at,
             updated_at = datetime('now')`,
        )
        .run(
          provider,
          value.pressure,
          value.remainingAllowance,
          value.source,
          value.manualOverride ? 1 : 0,
          value.resetAt,
        );
    },

    activeProviderPressures(now = new Date()): Array<{
      provider: string;
      pressure: Pressure;
      remainingAllowance: number | null;
      source: string;
      manualOverride: boolean;
      resetAt: string | null;
    }> {
      const instant = now.toISOString();
      db.raw
        .prepare(
          `DELETE FROM provider_pressure
           WHERE manual_override = 0 AND reset_at IS NOT NULL AND reset_at <= ?`,
        )
        .run(instant);
      return db.raw
        .prepare(
          `SELECT provider, pressure, remaining_allowance, source, manual_override, reset_at
           FROM provider_pressure ORDER BY provider`,
        )
        .all()
        .map((value) => {
          const row = value as {
            provider: string;
            pressure: Pressure;
            remaining_allowance: number | null;
            source: string | null;
            manual_override: number;
            reset_at: string | null;
          };
          return {
            provider: row.provider,
            pressure: row.pressure,
            remainingAllowance: row.remaining_allowance,
            source: row.source ?? 'persisted',
            manualOverride: row.manual_override === 1,
            resetAt: row.reset_at,
          };
        });
    },

    setProviderStatus(input: {
      provider: string;
      state: 'ready' | 'unavailable' | 'plan_blocked' | 'quota_cooldown' | 'disabled';
      auth: 'verified' | 'unknown' | 'failed';
      reason: string;
      nextProbeAt: string | null;
    }): void {
      db.raw
        .prepare(
          `INSERT INTO provider_status (provider, connected, auth_ok, detail, probed_at, state, next_probe_at, auth_state)
           VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET
             connected = excluded.connected,
             auth_ok = excluded.auth_ok,
             detail = excluded.detail,
             probed_at = datetime('now'),
             state = excluded.state,
             next_probe_at = excluded.next_probe_at,
             auth_state = excluded.auth_state`,
        )
        .run(
          input.provider,
          input.state === 'ready' ? 1 : 0,
          input.auth === 'verified' ? 1 : 0,
          input.reason,
          input.state,
          input.nextProbeAt,
          input.auth,
        );
    },

    providerStatuses(): Array<{
      provider: string;
      state: 'ready' | 'unavailable' | 'plan_blocked' | 'quota_cooldown' | 'disabled';
      auth: 'verified' | 'unknown' | 'failed';
      reason: string;
      nextProbeAt: string | null;
    }> {
      return db.raw
        .prepare('SELECT provider, detail, state, next_probe_at, auth_state FROM provider_status ORDER BY provider')
        .all()
        .map((r) => {
          const row = r as {
            provider: string;
            detail: string | null;
            state: 'ready' | 'unavailable' | 'plan_blocked' | 'quota_cooldown' | 'disabled' | null;
            next_probe_at: string | null;
            auth_state: 'verified' | 'unknown' | 'failed' | null;
          };
          return {
            provider: row.provider,
            state: row.state ?? 'unavailable',
            auth: row.auth_state ?? 'unknown',
            reason: row.detail ?? '',
            nextProbeAt: row.next_probe_at,
          };
        });
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
  };
}
