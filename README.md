# ai-dev-controller

Deterministic controller underneath Orca. It decides **what is allowed to run**; Orca **runs it**.

The controller owns workflow state, dependency waves, concurrency, routing policy, escalation budgets, scoring, and recovery. It does not run models itself except for small structured classification calls.

## How it works

```
rough issue
   |
ai-curate  ->  curator  ->  insufficient context -> ai-needs-context
   |
   +-- enough context -> YOU REVIEW -> add ai-ready
                              |
                          ai-running
                              |
                     autonomous work  -- genuine blocker --> ai-blocked
                              |
                        ai-reviewing
                              |
                          draft PR -> ai-pr-open -> YOU MERGE
```

After `ai-ready`, the system owns the issue until it opens a PR or hits a hard blocker. There are no routine approval checkpoints.

### Dependency waves

Issues are scheduled in waves based on their `blockedBy` graph. A dependency is satisfied **only when its PR is merged** into the base branch — not when the worker finishes, tests pass, the PR opens, or a reviewer approves.

```
A ------------+
              +--> D --> F
B --> C ------+
      |
      +----------> E

Wave 1: A, B
Wave 2: C        (after B merged)
Wave 3: D, E     (after A and C merged)
Wave 4: F        (after D merged)
```

Every issue branches from a freshly fetched base at the moment it becomes eligible.

### Your day-to-day

| Morning | Write / edit issues in Linear |
| --- | --- |
| When convenient | Review curated issues → add `ai-ready` |
| During the day | Occasionally check Orca |
| Later | GitHub has draft PRs waiting → review → merge |

## Interfaces

| Surface | Purpose |
| --- | --- |
| **Linear** | Say what needs doing. Add `ai-ready` to approve. |
| **Orca** | Watch agents, intervene on genuine blockers. |
| **GitHub** | Review and merge draft PRs. |

The controller is infrastructure. The CLI is an escape hatch, not a daily tool. v1 ships no web dashboard.

## Requirements

- Node >= 24 (developed on 26.4.0)
- [Orca](https://orca.dev/) desktop app running with its CLI enabled
- Codex signed in via ChatGPT
- `pnpm`

## Setup

```powershell
pnpm install
copy .env.example .env
# fill in values — see below
pnpm cli migrate
pnpm cli config
```

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `LINEAR_API_KEY` | **Yes** | Personal API key — Settings → Security & access → Personal API keys |
| `GITHUB_TOKEN` | No | Token with `repo` + `workflow` scopes. Falls back to the authenticated `gh` CLI identity. The controller never merges. |
| `ORCA_BIN` | No | Path to `orca` CLI. Default: `orca` (assumes it's on PATH). |
| `CODEX_BIN` | No | Path to `codex` CLI. Default: `codex`. |
| `OLLAMA_BASE_URL` | No | Ollama Cloud base URL. Default: `http://localhost:11434/v1`. |
| `AI_DEV_DB` | No | SQLite database path. Default: `./data/controller.db`. |
| `AI_DEV_LOG_LEVEL` | No | Log verbosity (`info`, `debug`, etc.). Default: `info`. |

<<<<<<< Updated upstream
The v1 controller is implemented through the draft-PR boundary. The first real
pilot (Linear JP-8 against Lorebound) completed the full automated path and was
merged by a human. JP-10 then proved the rough-issue curator, human `ai-ready`
gate, implementation, validation, CI, final review and draft-PR handoff in one
live run ([PR #14](https://github.com/JPClow3/Lorebound/pull/14)). JP-9 proved
dependency unblocking, remediation and crash recovery and has a green draft PR
([PR #15](https://github.com/JPClow3/Lorebound/pull/15)); its last Codex review
is durably paused until the provider's reported quota reset.

572 tests pass, with clean typecheck and production build.

```
src/config/      config contract, Zod schemas, snake_case -> camelCase
src/state/       SQLite persistence, run claims, audit trail
src/workflow/    state machine, transition guards, Linear projection
src/curation/    rough-issue cleanup and human-ready boundary
src/linear/      issue polling, labels, explicit dependency reads
src/projects/    repository resolution
src/knowledge/   documentation discovery and knowledge map
src/scheduler/   dependency waves, capacity, priority
src/routing/     Codex model/profile selection
src/orca/        parent and child worktree orchestration
src/github/      draft PRs, CI normalization, bounded CI reruns
src/reviews/     independent review and acceptance-criteria gates
src/cli/         ai-dev commands
```

=======
## Scripts

```powershell
pnpm build          # compile TypeScript to dist/
pnpm dev            # run src/index.ts via tsx
pnpm cli <command>  # run the ai-dev CLI
pnpm test           # run all tests (vitest)
pnpm test:watch     # vitest in watch mode
pnpm typecheck      # tsc --noEmit
pnpm migrate        # run SQLite migrations
```

## Source layout

```
src/
  agents/       agent definitions
  cli/          ai-dev CLI commands
  config/       config contract, Zod schemas, snake_case → camelCase
  git/          git helpers
  github/       CI sync, draft PR generation
  knowledge/    documentation discovery and knowledge map
  linear/       issue polling, labels, explicit dependency reads
  orca/         worktree creation, Orca client
  projects/     repository resolution
  recovery/     run recovery after restart
  reviews/      cross-family final review
  routing/      model routing aliases, escalation policy
  scheduler/    dependency waves, capacity, priority (DAG)
  scoring/      composite scoring, champion-challenger, promotion
  state/        SQLite persistence, run claims, audit trail
  util/         shared utilities
  validation/   schema validation
  workflow/     state machine, transition guards, Linear projection

config/
  routing.yaml      model routing aliases
  escalation.yaml   escalation budget policy

docs/
  implementation-plan.md  revised task plan
  lifecycle.md            issue lifecycle and wave semantics
  v1-scope.md             full feature scope with module mapping
  reference/              Orca CLI schema and other captured references

prompts/
  curator.md   Linear issue curation prompt
  planner.md   internal task decomposition prompt
```

## Linear label → internal state mapping

| Internal state | Linear label |
| --- | --- |
| `DISCOVERED`, `CURATING` | `ai-curate` |
| `NEEDS_CONTEXT`, `WAITING_READY` | `ai-needs-context` |
| `QUEUED`, `PLANNING`, `IMPLEMENTING`, `INTEGRATING`, `LOCAL_VALIDATION`, `REMEDIATING` | `ai-running` |
| `CI`, `FINAL_REVIEW`, `PR_READY` | `ai-reviewing` |
| `DEPENDENCY_BLOCKED`, `BLOCKED_HUMAN`, `FAILED` | `ai-blocked` |
| `PR_OPEN` | `ai-pr-open` |

Internal states like `worker_retry_2`, `glm_review`, and `ci_pending` never surface in Linear. Linear stays readable by design.

>>>>>>> Stashed changes
## Hard boundaries

Enforced by the controller; no model can override them.

- A dependency is satisfied **only when its PR is merged** into the base branch.
- Every issue starts from a freshly fetched base branch.
<<<<<<< Updated upstream
- Models return *recommended* transitions. The controller verifies mechanical
  preconditions independently and performs the write.
- Only a human applies `ai-ready`. It is not in the controller's writable
  label set.
- Never merge, never push to the base branch, never force-push protected
  branches, never run destructive operations against production.
- Retry budgets are finite. Exhaustion means `BLOCKED_HUMAN`, not another
  attempt.
- Startup verifies that every lifecycle label exists in Linear before polling
  or persisting curation state.
=======
- Models return *recommended* transitions. The controller verifies mechanical preconditions independently and performs the write.
- Only a human applies `ai-ready`. It is not in the controller's writable label set.
- Never merge, never push to the base branch, never force-push protected branches, never run destructive operations against production.
- Retry budgets are finite. Exhaustion means `BLOCKED_HUMAN`, not another attempt.
>>>>>>> Stashed changes

## Implementation status

<<<<<<< Updated upstream
- `better-sqlite3` is pinned to `^13`, not the plan's `^11`: v11 has no Node 26
  prebuild and its source build hangs here.
- `pnpm-workspace.yaml` and `.npmrc` exist to stop pnpm's install-script gate
  from failing `pnpm test`. Neither blocked package needs its script.
- Codex workers run headlessly with `sandbox_mode = "workspace-write"` and the
  Windows sandbox forced to `unelevated`, avoiding unattended UAC prompts.
=======
Tasks 1–5 implemented. 105 tests, typecheck clean.
>>>>>>> Stashed changes

Tasks 6–14 (routing logic, Orca adapter, CI, review, scoring, recovery, runner, pilot) are specified in [`docs/implementation-plan.md`](docs/implementation-plan.md).

## Platform notes

- `better-sqlite3` is pinned to `^13` (not `^11`): v11 has no Node 26 prebuild and its source build hangs on this machine.
- `pnpm-workspace.yaml` and `.npmrc` exist to stop pnpm's install-script gate from failing `pnpm test`. Neither blocked package needs its script.
- Codex worker profiles pin `sandbox_mode = "workspace-write"` rather than inheriting the global `danger-full-access`.
