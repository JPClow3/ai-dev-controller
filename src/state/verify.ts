import { db } from './db.js';

/** Smoke check: schema present, WAL on, idempotency index in place. */
const tables = db()
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
  .all() as Array<{ name: string }>;

const indexes = db()
  .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name`)
  .all() as Array<{ name: string }>;

console.log(`tables (${tables.length}): ${tables.map((t) => t.name).join(', ')}`);
console.log(`indexes: ${indexes.map((i) => i.name).join(', ')}`);
console.log(`journal_mode: ${JSON.stringify(db().prepare('PRAGMA journal_mode').get())}`);
