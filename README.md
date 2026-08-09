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
- Startup verifies that every lifecycle label exists in Linear before polling
  or persisting curation state.

## Notes on this machine

- `better-sqlite3` is pinned to `^13`, not the plan's `^11`: v11 has no Node 26
  prebuild and its source build hangs here.
- `pnpm-workspace.yaml` and `.npmrc` exist to stop pnpm's install-script gate
  from failing `pnpm test`. Neither blocked package needs its script.
- Codex workers run headlessly with `sandbox_mode = "workspace-write"` and the
  Windows sandbox forced to `unelevated`, avoiding unattended UAC prompts.

## Docs

- `docs/implementation-plan.md` — revised task plan
- `docs/lifecycle.md` — issue lifecycle and wave semantics
- `docs/reference/orca-agent-context.json` — captured Orca CLI schema
