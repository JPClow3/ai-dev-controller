import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { configRoot } from '../config/index.js';

/**
 * Node's built-in SQLite. Chosen over better-sqlite3 so the controller needs no
 * native toolchain on Windows - `git clone && npm install` just works.
 *
 * Single local writer. WAL, foreign keys on, synchronous NORMAL.
 */
let handle: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (handle) return handle;
  const path = resolve(configRoot(), process.env['AI_DEV_DB'] ?? './data/controller.db');
  mkdirSync(resolve(path, '..'), { recursive: true });
  handle = new DatabaseSync(path);
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA synchronous = NORMAL');
  return handle;
}

/**
 * Every claim and every state transition runs inside one of these.
 *
 * The partial unique index `idx_runs_one_active` is what actually prevents
 * duplicate runs; this makes the read-then-write around it atomic. IMMEDIATE
 * takes the write lock up front rather than failing late on upgrade.
 */
export function transaction<T>(fn: () => T): T {
  const conn = db();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}
