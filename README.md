# ai-dev-controller

Deterministic controller underneath Orca. It decides **what is allowed to run**;
Orca **runs it**.

The controller owns workflow state, dependency waves, concurrency, routing
policy, escalation budgets, scoring, and recovery. It does not run models
itself except for small structured classification calls.

## Interfaces you actually use

| Surface | Purpose |
| --- | --- |
| Linear | Say what needs doing. Add `ai-ready`. |
| Orca | Watch agents, intervene on real problems. |
| GitHub | Review and merge draft PRs. |

The controller is infrastructure. The CLI is an escape hatch, not a daily tool,
and v1 deliberately ships no web dashboard.

## Setup

```powershell
pnpm install
copy .env.example .env    # fill in LINEAR_API_KEY
pnpm cli migrate
pnpm cli config
```

Requires Node >= 24 (developed on 26.4.0), the Orca desktop app running with
its CLI enabled, and Codex signed in via ChatGPT.

## Status

Tasks 1–5 implemented. 105 tests, typecheck clean.

```
src/config/      config contract, Zod schemas, snake_case -> camelCase
src/state/       SQLite persistence, run claims, audit trail
src/workflow/    state machine, transition guards, Linear projection
src/linear/      issue polling, labels, explicit dependency reads
src/projects/    repository resolution
src/knowledge/   documentation discovery and knowledge map
src/scheduler/   dependency waves, capacity, priority
src/cli/         ai-dev commands
```

Tasks 6–14 (routing logic, Orca adapter, CI, review, scoring, recovery,
runner, pilot) are specified in `docs/implementation-plan.md`.

## Hard boundaries

Enforced by the controller; no model can override them.

- A dependency is satisfied **only when its PR is merged** into the base branch.
  Not when the worker finished, tests passed, the PR opened, or a reviewer
  approved. There are tests for each of those.
- Every issue starts from a freshly fetched base branch.
- Models return *recommended* transitions. The controller verifies mechanical
  preconditions independently and performs the write.
- Only a human applies `ai-ready`. It is not in the controller's writable
  label set.
- Never merge, never push to the base branch, never force-push protected
  branches, never run destructive operations against production.
- Retry budgets are finite. Exhaustion means `BLOCKED_HUMAN`, not another
  attempt.

## Notes on this machine

- `better-sqlite3` is pinned to `^13`, not the plan's `^11`: v11 has no Node 26
  prebuild and its source build hangs here.
- `pnpm-workspace.yaml` and `.npmrc` exist to stop pnpm's install-script gate
  from failing `pnpm test`. Neither blocked package needs its script.
- Codex worker profiles pin `sandbox_mode = "workspace-write"` rather than
  inheriting the global `danger-full-access`.

## Docs

- `docs/implementation-plan.md` — revised task plan
- `docs/lifecycle.md` — issue lifecycle and wave semantics
- `docs/reference/orca-agent-context.json` — captured Orca CLI schema
