import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { logger } from '../util/log.js';

const log = logger('migrate');
const DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function migrate(): void {
  const conn = db();
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const rows = conn.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
  const applied = new Set(rows.map((r) => r.version));

  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;
  for (const file of files) {
    const version = Number.parseInt(file.slice(0, 3), 10);
    if (Number.isNaN(version) || applied.has(version)) continue;
    log.info(`applying ${file}`);
    conn.exec(readFileSync(resolve(DIR, file), 'utf8'));
    conn.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    count += 1;
  }
  log.info(count === 0 ? 'schema already up to date' : `applied ${count} migration(s)`);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]).replace(/\\/g, '/').endsWith('state/migrate.ts');
if (invokedDirectly) migrate();
