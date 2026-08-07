import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { applyMigrations } from './migrations.js';

export interface ControllerDatabase {
  readonly raw: Database.Database;
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * Opens (and migrates) the controller database.
 *
 * WAL plus a single writer process. `:memory:` is honoured for tests.
 */
export function openDatabase(path: string): ControllerDatabase {
  if (path !== ':memory:') {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    path = absolute;
  }

  const raw = new Database(path);
  if (path !== ':memory:') raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('synchronous = NORMAL');
  applyMigrations(raw);

  return {
    raw,
    /**
     * IMMEDIATE takes the write lock up front. Claim logic reads then writes,
     * and a deferred transaction would only discover the conflict on upgrade —
     * after the read that decided it was safe to proceed.
     */
    transaction<T>(fn: () => T): T {
      const wrapped = raw.transaction(fn);
      return wrapped.immediate();
    },
    close(): void {
      raw.close();
    },
  };
}
