# ai-dev-controller

Deterministic controller underneath Orca. It decides **what is allowed to run**; Orca **runs it**.

The controller owns workflow state, dependency waves, concurrency, routing policy, escalation budgets, scoring, and recovery. It does not run models itself except for small structured classification calls.

## How it works

```
new Linear issue -> controller adds ai-curate
                              |
                           curator
                              |
                      automatic ai-ready
                              |
                          ai-running
                              |
                     autonomous work  -- genuine blocker --> ai-blocked
                              |
                        ai-reviewing
                              |
                          draft PR -> ai-pr-open -> YOU MERGE
```

From issue creation through draft PR, the system owns the flow unless it hits a genuine context, dependency, or safety blocker. There are no routine approval checkpoints.

Curation gathers the available issue and repository context, then promotes the
result straight to `ai-ready`. Only an unresolved external product decision or
repository ambiguity becomes `ai-blocked`.

### Actionable status and automatic recovery

`ai-blocked` is a short lifecycle signal, not the diagnosis. The controller
posts a Linear comment before applying it with the reason, evidence, owner,
next action, and whether the issue can be resumed. Routine test, build, CI, and
integration failures after setup create bounded remediation work automatically;
setup failures and work that cannot be safely repaired reach a human blocker.
Fresh Node worktrees
use an explicit setup command when present, otherwise only a lockfile-backed
setup (`npm ci`, `pnpm install --frozen-lockfile`, or `yarn install --immutable`).

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
| During the day | Occasionally check Orca |
| Later | GitHub has draft PRs waiting → review → merge |

## Interfaces

| Surface | Purpose |
| --- | --- |
| **Linear** | Create the issue and provide repository/product context. |
| **Orca** | Watch agents, intervene on genuine blockers. |
| **GitHub** | Review and merge draft PRs. |

The controller is infrastructure. The CLI is an escape hatch, not a daily tool. v1 ships no web dashboard.

## Requirements

- Node >= 24 (developed on 26.4.0)
- [Orca](https://orca.dev/) desktop app running with its CLI enabled
- Codex signed in via ChatGPT
- Corepack and the exact `pnpm` release declared in `packageManager`

## Setup

```powershell
corepack enable
pnpm install --frozen-lockfile
copy .env.example .env
# fill in values — see below
pnpm cli migrate
pnpm cli config
pnpm cli doctor
pnpm supervisor:install # Windows: survive Codex/terminal/app exits and logon restarts
```

## Windows notebook bootstrap

See [the Windows notebook guide](docs/windows-notebook-setup.md) for the
complete setup, path-mapping rules, and troubleshooting guide.

Audit installed tools and controller connectivity without installing packages,
creating files, or registering the supervisor:

```powershell
.\scripts\setup-windows.ps1
```

Install missing CLI prerequisites and create machine-local controller files:

```powershell
.\scripts\setup-windows.ps1 -Install -RepositoryRoot C:\Code
```

Install prerequisites and the optional current-user supervisor together:

```powershell
.\scripts\setup-windows.ps1 -Install -RepositoryRoot C:\Code -InstallSupervisor
```

`winget` is used only with `-Install`. The audit does run authenticated
connectivity checks, including `pnpm cli doctor`, so it can contact configured
services and report expired sign-ins. The script never overwrites credentials,
`.env`, the shared registry, or an existing local registry unless `-Force` is
explicitly passed. Sign in manually with `gh auth login`, `codex login`, and
the Orca desktop setup. Device-specific repository paths are written only to
the gitignored, path-only `projects/registry.local.yaml` overlay.

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

## Verification and scripts

The local verification contract is typecheck, the deterministic test reporter,
the production build, and the packaged CLI smoke test:

```powershell
pnpm build          # compile TypeScript to dist/
pnpm dev            # run src/index.ts via tsx
pnpm cli <command>  # run the ai-dev CLI
pnpm test           # run all tests (vitest)
pnpm test:ci        # deterministic non-watch reporter used by GitHub Actions
pnpm test:watch     # vitest in watch mode
pnpm typecheck      # tsc --noEmit
pnpm migrate        # run SQLite migrations
```

Every push to `main` and every pull request runs the same locked Node 24 gate
in `.github/workflows/ci.yml`: install, typecheck, tests, production build,
packaged-CLI smoke test, and a high-severity production dependency audit.
Windows CI additionally parses and analyzes the supervisor scripts and
exercises the supervisor process boundary. Machine-local registry path checks
are intentionally opt-in; run the complete local contract with
`$env:AI_DEV_LIVE_REGISTRY='1'; pnpm test`.

For routine operation and incident recovery, use
[the operations runbook](docs/operations.md). It distinguishes read-only
inspection from commands that resume, retry, or reconcile workflow state.

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
  reviews/      independent Sol final review
  routing/      OpenAI model/thinking-level routing and escalation
  scheduler/    dependency waves, capacity, priority (DAG)
  scoring/      composite scoring, champion-challenger, promotion
  state/        SQLite persistence, run claims, audit trail
    repositories/ focused issue, run, task, review, score and system stores
  util/         shared utilities
  validation/   immutable contract readers, safety policy, execution evidence
  workflow/     state machine, worker lifecycle, validation, recovery wiring

config/
  routing.yaml      model routing aliases
  escalation.yaml   escalation budget policy

docs/
  implementation-plan.md  revised task plan
  lifecycle.md            issue lifecycle and wave semantics
  operations.md           daily operations and incident runbook
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
| `WAITING_READY` | `ai-ready` |
| `QUEUED`, `PLANNING`, `IMPLEMENTING`, `INTEGRATING`, `LOCAL_VALIDATION`, `REMEDIATING` | `ai-running` |
| `CI`, `FINAL_REVIEW`, `PR_READY` | `ai-reviewing` |
| `DEPENDENCY_BLOCKED`, `BLOCKED_HUMAN`, `FAILED` | `ai-blocked` |
| `PR_OPEN` | `ai-pr-open` |

Internal states like `worker_retry_2`, `glm_review`, and `ci_pending` never surface in Linear. Linear stays readable by design.

## Hard boundaries

Enforced by the controller; no model can override them.

- A dependency is satisfied **only when its PR is merged** into the base branch.
- Every issue starts from a freshly fetched base branch.
- Models return *recommended* transitions. The controller verifies mechanical
  preconditions independently and performs the write.
- The controller owns `ai-curate` through `ai-pr-open`; curation builds the
  implementation contract and promotes it directly to `ai-ready`.
- Never merge, never push to the base branch, never force-push protected
  branches, never run destructive operations against production.
- Retry budgets are finite. Exhaustion means `BLOCKED_HUMAN`, not another
  attempt.
- Startup verifies that every lifecycle label exists in Linear before polling
  or persisting curation state.
- A run with a persisted base SHA reads `.ai-workflow/project.yaml` and any
  lockfile-backed setup only from that exact commit. A missing or malformed
  base contract never falls back to the mutable working tree.
- A declared setup command wins. Without one, setup is inferred only when
  exactly one supported lockfile exists at the base: `npm ci`,
  `pnpm install --frozen-lockfile`, or `yarn install --immutable`.
- Repository-defined validation and setup commands are screened immediately
  before shell execution. Unsafe commands are recorded as failed safety
  evidence (exit 126) and never reach the shell.

## Implementation status

- `better-sqlite3` is pinned to `^13`, not the plan's `^11`: v11 has no Node 26
  prebuild and its source build hangs here.
- `pnpm-workspace.yaml` and `.npmrc` exist to stop pnpm's install-script gate
  from failing `pnpm test`. Neither blocked package needs its script.
- Runtime and test dependencies track their current compatible majors. Node
  type definitions intentionally stay on major 24 because CI targets Node 24;
  adopting newer runtime types would let code compile against APIs unavailable
  in the supported runtime.
- Codex workers run headlessly with `sandbox_mode = "workspace-write"` and the
  Windows sandbox forced to `unelevated`, avoiding unattended UAC prompts.
- On Windows, `pnpm supervisor:install` registers a current-user Scheduled Task
  at `RunLevel Limited`. It is independent of the ChatGPT desktop process,
  starts at logon, refuses duplicate supervisors and relaunches the controller
  after an unexpected exit. It also checks the Orca runtime every 30 seconds
  and runs `orca open --json` when the desktop runtime disappears. Inspect it
  with `pnpm supervisor:status`; remove it with `pnpm supervisor:uninstall`.
- Production routing defaults to OpenAI: Luna medium curates, Luna high handles
  routine work, Terra high handles complex/large-context work, and Sol high
  orchestrates and reviews. Challengers vary only reasoning effort on the same
  underlying model.

## Platform notes

- `better-sqlite3` is pinned to `^13` (not `^11`): v11 has no Node 26 prebuild
  and its source build hangs on this machine.
- `pnpm-workspace.yaml` and `.npmrc` exist to stop pnpm's install-script gate
  from failing `pnpm test`. Neither blocked package needs its script.
- Codex worker profiles pin `sandbox_mode = "workspace-write"` rather than
  inheriting the global `danger-full-access`.
