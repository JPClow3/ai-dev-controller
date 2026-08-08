import type BetterSqlite3 from 'better-sqlite3';

/**
 * Schema migrations, applied in order and recorded so re-running is a no-op.
 *
 * SQLite is enough for a local single-writer controller. No Redis, no Postgres,
 * no background infrastructure stack.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const INIT = `
CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  enabled           INTEGER NOT NULL DEFAULT 1,
  repo_path         TEXT NOT NULL,
  github_slug       TEXT NOT NULL,
  base_branch       TEXT NOT NULL DEFAULT 'main',
  linear_project    TEXT,
  knowledge_status  TEXT NOT NULL DEFAULT 'unverified'
                      CHECK (knowledge_status IN ('unverified','verified')),
  max_agents        INTEGER NOT NULL DEFAULT 5,
  routing_profile   TEXT NOT NULL DEFAULT 'default',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS issues (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  linear_uuid       TEXT UNIQUE,
  title             TEXT,
  role              TEXT,
  risk              TEXT CHECK (risk IN ('low','medium','high')),
  state             TEXT NOT NULL DEFAULT 'DISCOVERED',
  paused            INTEGER NOT NULL DEFAULT 0,
  curated_body      TEXT,
  acceptance_json   TEXT NOT NULL DEFAULT '[]',
  blocked_reason    TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_issues_state ON issues(state);
CREATE INDEX IF NOT EXISTS ix_issues_project ON issues(project_id);

-- Only explicit, human-approved Linear relations. Never inferred from text.
CREATE TABLE IF NOT EXISTS issue_dependencies (
  issue_id          TEXT NOT NULL,
  blocked_by        TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'linear' CHECK (source IN ('linear','manual')),
  satisfied_at      TEXT,
  PRIMARY KEY (issue_id, blocked_by)
);

CREATE TABLE IF NOT EXISTS dependency_proposals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id          TEXT NOT NULL,
  blocking_issue    TEXT NOT NULL,
  acceptance_criterion TEXT,
  reason            TEXT,
  status            TEXT NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed','approved','rejected')),
  linear_comment_id TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,
  issue_id          TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  repository_id     TEXT NOT NULL,
  attempt           INTEGER NOT NULL DEFAULT 1,
  state             TEXT NOT NULL DEFAULT 'QUEUED',
  branch            TEXT,
  base_sha          TEXT,
  orca_worktree_id  TEXT,
  plan_json         TEXT,
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at          TEXT
);

-- Idempotency. This index, not application logic, is what makes a second
-- claim on a live issue impossible even across controller restarts.
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_active_issue
  ON runs(issue_id)
  WHERE state NOT IN ('MERGED','FAILED','CANCELLED');

CREATE TABLE IF NOT EXISTS tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_key          TEXT NOT NULL,
  summary           TEXT,
  role              TEXT,
  risk              TEXT NOT NULL DEFAULT 'low',
  owns_json         TEXT NOT NULL DEFAULT '[]',
  blocked_by_json   TEXT NOT NULL DEFAULT '[]',
  criteria_json     TEXT NOT NULL DEFAULT '[]',
  state             TEXT NOT NULL DEFAULT 'PENDING',
  branch            TEXT,
  orca_worktree_id  TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, task_key)
);

CREATE TABLE IF NOT EXISTS attempts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_no        INTEGER NOT NULL,
  alias_id          TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'worker',
  is_challenger     INTEGER NOT NULL DEFAULT 0,
  escalated_from    INTEGER REFERENCES attempts(id),
  failure_class     TEXT,
  result_json       TEXT,
  composite_score   REAL,
  wall_clock_s      REAL,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  resource_cost     REAL,
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at          TEXT,
  UNIQUE (task_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS ix_attempts_alias ON attempts(alias_id);

CREATE TABLE IF NOT EXISTS reviews (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage             TEXT NOT NULL CHECK (stage IN ('integration','final')),
  reviewer_alias    TEXT NOT NULL,
  selection_reason  TEXT,
  verdict           TEXT NOT NULL CHECK (verdict IN ('approve','request_changes','escalate')),
  diff_sha          TEXT,
  findings_json     TEXT NOT NULL DEFAULT '[]',
  criteria_json     TEXT NOT NULL DEFAULT '[]',
  cycle             INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ci_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  head_sha          TEXT NOT NULL,
  github_run_id     INTEGER,
  status            TEXT NOT NULL,
  conclusion        TEXT,
  required_json     TEXT NOT NULL DEFAULT '[]',
  checks_json       TEXT NOT NULL DEFAULT '[]',
  synced_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pull_requests (
  run_id            TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  number            INTEGER NOT NULL,
  url               TEXT NOT NULL,
  draft             INTEGER NOT NULL DEFAULT 1,
  head_branch       TEXT NOT NULL,
  base_branch       TEXT NOT NULL,
  merged            INTEGER NOT NULL DEFAULT 0,
  merged_at         TEXT,
  merge_sha         TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routing_stats (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  scope             TEXT NOT NULL CHECK (scope IN ('global','repository')),
  project_id        TEXT,
  role              TEXT NOT NULL,
  alias_id          TEXT NOT NULL,
  samples           INTEGER NOT NULL DEFAULT 0,
  composite_avg     REAL,
  acceptance_avg    REAL,
  first_pass_ci     REAL,
  avg_remediations  REAL,
  median_minutes    REAL,
  success_rate      REAL,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scope, project_id, role, alias_id)
);

CREATE TABLE IF NOT EXISTS routing_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT,
  role              TEXT NOT NULL,
  from_alias        TEXT,
  to_alias          TEXT NOT NULL,
  change_type       TEXT NOT NULL
                      CHECK (change_type IN ('promotion','manual','rollback','proposal')),
  automatic         INTEGER NOT NULL DEFAULT 0,
  samples           INTEGER,
  score_advantage   REAL,
  reason            TEXT,
  rollback_of       INTEGER REFERENCES routing_history(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_pressure (
  provider          TEXT PRIMARY KEY,
  pressure          TEXT NOT NULL DEFAULT 'NORMAL'
                      CHECK (pressure IN ('LOW','NORMAL','HIGH','EXHAUSTED')),
  remaining_allowance REAL,
  available_concurrency INTEGER,
  source            TEXT,
  manual_override   INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_state (
  project_id        TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'unverified',
  map_json          TEXT,
  bootstrap_branch  TEXT,
  bootstrap_pr      INTEGER,
  conflicts_count   INTEGER NOT NULL DEFAULT 0,
  scanned_at        TEXT,
  verified_at       TEXT
);

-- Append-only audit. Models recommend; only rows here prove what happened.
CREATE TABLE IF NOT EXISTS state_transitions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT,
  issue_id          TEXT,
  from_state        TEXT,
  to_state          TEXT NOT NULL,
  actor             TEXT NOT NULL DEFAULT 'controller',
  recommended_by    TEXT,
  reason            TEXT,
  facts_json        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS human_escalations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id          TEXT NOT NULL,
  run_id            TEXT,
  trigger           TEXT NOT NULL,
  question          TEXT NOT NULL,
  options_json      TEXT,
  resolved          INTEGER NOT NULL DEFAULT 0,
  resolution        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at       TEXT
);
`;

/**
 * The Linear URL, so the pull request can link the issue rather than name it.
 *
 * `## Linear` in the PR body rendered a bare `JP-8`: the renderer accepted an
 * optional `issueUrl` and nothing ever supplied one, because the URL was read
 * from Linear and then dropped.
 */
const ISSUE_URL = `
ALTER TABLE issues ADD COLUMN url TEXT;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: INIT },
  { version: 2, name: 'issue_url', sql: ISSUE_URL },
];

export function applyMigrations(db: BetterSqlite3.Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
  );

  let count = 0;
  const record = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec(migration.sql);
    record.run(migration.version, migration.name);
    count += 1;
  }
  return count;
}
