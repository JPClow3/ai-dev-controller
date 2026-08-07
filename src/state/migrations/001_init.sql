-- ai-dev-controller :: initial schema
-- SQLite. Local, single-writer, WAL. No Redis, no Postgres, no daemon stack.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  enabled           INTEGER NOT NULL DEFAULT 1,
  repo_path         TEXT NOT NULL,
  github_slug       TEXT NOT NULL,
  base_branch       TEXT NOT NULL DEFAULT 'main',
  linear_project    TEXT,
  is_group_default  INTEGER NOT NULL DEFAULT 0,
  knowledge_status  TEXT NOT NULL DEFAULT 'unverified'
                      CHECK (knowledge_status IN ('unverified','verified')),
  bootstrap_pr      INTEGER,
  max_agents        INTEGER NOT NULL DEFAULT 5,
  routing_profile   TEXT NOT NULL DEFAULT 'default',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS issues (
  id                TEXT PRIMARY KEY,          -- Linear identifier, e.g. HFS-142
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  linear_uuid       TEXT UNIQUE,
  title             TEXT,
  task_category     TEXT,
  risk              TEXT CHECK (risk IN ('low','medium','high')),
  state             TEXT NOT NULL DEFAULT 'DISCOVERED',
  knowledge_status  TEXT NOT NULL DEFAULT 'unverified',
  curated_body      TEXT,
  acceptance_json   TEXT,                      -- JSON array of criteria
  blocked_reason    TEXT,
  paused            INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(state);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);

-- Explicit, human-approved Linear relations only. Never inferred.
CREATE TABLE IF NOT EXISTS issue_dependencies (
  issue_id          TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  blocked_by        TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'linear' CHECK (source IN ('linear','manual')),
  satisfied_at      TEXT,                      -- set only when the blocker PR is MERGED
  PRIMARY KEY (issue_id, blocked_by)
);

-- Dependency proposals from the curator. Advisory until approved in Linear.
CREATE TABLE IF NOT EXISTS dependency_proposals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id          TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  blocking_issue    TEXT NOT NULL,
  acceptance_criterion TEXT,
  reason            TEXT,
  status            TEXT NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed','approved','rejected')),
  linear_comment_id TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,          -- uuid
  issue_id          TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  attempt           INTEGER NOT NULL DEFAULT 1,
  state             TEXT NOT NULL DEFAULT 'QUEUED',
  active            INTEGER NOT NULL DEFAULT 1,
  branch            TEXT,
  base_sha          TEXT,
  orca_worktree_id  TEXT,
  plan_json         TEXT,
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at          TEXT,
  outcome           TEXT CHECK (outcome IN
                      ('pr_open','merged','blocked_human','failed','cancelled'))
);
-- Idempotency: at most one active run per issue. This is the duplicate-run guard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_active
  ON runs(issue_id) WHERE active = 1;

CREATE TABLE IF NOT EXISTS tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_key          TEXT NOT NULL,             -- plan task id, e.g. 'api'
  summary           TEXT,
  task_category     TEXT,
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

-- Worker identity is model + effort + harness, not just the model name.
CREATE TABLE IF NOT EXISTS workers (
  id                TEXT PRIMARY KEY,          -- alias key from routing.yaml
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  effort            TEXT,
  harness           TEXT NOT NULL,
  family            TEXT NOT NULL,
  context_window    INTEGER,
  usage_class       TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS model_attempts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_no        INTEGER NOT NULL,
  worker_id         TEXT NOT NULL REFERENCES workers(id),
  role              TEXT NOT NULL DEFAULT 'worker'
                      CHECK (role IN ('curator','planner','worker','classifier',
                                      'integration_reviewer','final_reviewer','bootstrap')),
  is_challenger     INTEGER NOT NULL DEFAULT 0,
  escalated_from    INTEGER REFERENCES model_attempts(id),
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
CREATE INDEX IF NOT EXISTS idx_attempts_worker ON model_attempts(worker_id);

CREATE TABLE IF NOT EXISTS reviews (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage             TEXT NOT NULL CHECK (stage IN ('integration','final')),
  reviewer_id       TEXT NOT NULL REFERENCES workers(id),
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
  status            TEXT NOT NULL,             -- queued|in_progress|completed
  conclusion        TEXT,                      -- success|failure|cancelled|...
  required_json     TEXT NOT NULL DEFAULT '[]',
  checks_json       TEXT NOT NULL DEFAULT '[]',
  synced_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, head_sha, github_run_id)
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

-- Champion/challenger statistics, aggregated at every level we compare on.
CREATE TABLE IF NOT EXISTS routing_stats (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  scope             TEXT NOT NULL CHECK (scope IN ('global','repository')),
  project_id        TEXT,
  task_category     TEXT NOT NULL,
  worker_id         TEXT NOT NULL REFERENCES workers(id),
  samples           INTEGER NOT NULL DEFAULT 0,
  composite_avg     REAL,
  acceptance_avg    REAL,
  first_pass_ci     REAL,
  avg_remediations  REAL,
  median_minutes    REAL,
  success_rate      REAL,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scope, project_id, task_category, worker_id)
);

CREATE TABLE IF NOT EXISTS routing_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT,
  task_category     TEXT NOT NULL,
  from_worker       TEXT,
  to_worker         TEXT NOT NULL,
  change_type       TEXT NOT NULL
                      CHECK (change_type IN ('promotion','manual','rollback','proposal')),
  automatic         INTEGER NOT NULL DEFAULT 0,
  samples           INTEGER,
  score_advantage   REAL,
  reason            TEXT,
  rollback_of       INTEGER REFERENCES routing_history(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Provider scarcity. Feeds the routing utility function.
CREATE TABLE IF NOT EXISTS resource_pressure (
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

-- Append-only audit of every state transition the controller performed.
-- Models recommend; only rows here prove what actually happened.
CREATE TABLE IF NOT EXISTS state_transitions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT REFERENCES runs(id) ON DELETE CASCADE,
  issue_id          TEXT,
  from_state        TEXT,
  to_state          TEXT NOT NULL,
  actor             TEXT NOT NULL DEFAULT 'controller',
  recommended_by    TEXT,
  preconditions_json TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS human_escalations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id          TEXT NOT NULL,
  run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL,
  trigger           TEXT NOT NULL,
  question          TEXT NOT NULL,
  options_json      TEXT,
  resolved          INTEGER NOT NULL DEFAULT 0,
  resolution        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at       TEXT
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version           INTEGER PRIMARY KEY,
  applied_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
