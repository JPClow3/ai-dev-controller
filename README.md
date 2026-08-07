# ai-dev-controller

Thin deterministic controller underneath Orca. It decides **what is allowed to run**;
Orca **runs it**.

The controller owns state, dependency waves, concurrency, routing policy, escalation
budgets, and scoring. It does not run models itself except for small structured
classification calls.

## Interfaces you actually use

| Surface | Purpose |
| --- | --- |
| Linear | Say what needs doing. Add `ai-ready`. |
| Orca | Watch agents, intervene on real problems. |
| GitHub | Review and merge draft PRs. |

The controller is infrastructure. The CLI is an escape hatch, not a daily tool.

## Layout

```
config/     global, routing, escalation, scoring policy
projects/   repository registry
prompts/    agent role prompts (curator, planner, worker, reviewers, ...)
schemas/    JSON Schemas every model response is validated against
src/        deterministic TypeScript
  linear/     issue sync, labels, dependency reads
  scheduler/  DAG, waves, capacity, priority queue
  routing/    model aliases, resource pressure, champion/challenger selection
  scoring/    composite score, promotion rules
  state/      SQLite persistence, state machine, idempotency, recovery
  orca/       Orca CLI adapter (worktrees, agent sessions)
  github/     PR + CI synchronisation
  knowledge/  repository onboarding, knowledge map, context packets
cli/        `ai-dev` commands
data/       controller.db (gitignored)
```

## Hard boundaries

The controller enforces these; no model can override them.

- A dependency is satisfied **only when its PR is merged** into the base branch.
- Every issue starts from a freshly fetched base branch.
- Models return *recommended* state transitions. The controller validates preconditions
  and performs the write.
- Never merge, never push to `main`, never force-push protected branches, never run
  destructive operations against production.
- Retry budgets are finite. Exhaustion means `BLOCKED_HUMAN`, not another attempt.

## Setup

```powershell
copy .env.example .env    # fill in LINEAR_API_KEY, GITHUB_TOKEN, OLLAMA_API_KEY
npm install
npm run migrate
npm run dev -- status
```

## CLI

```
ai-dev status                 current runs and slot usage
ai-dev projects               registered repositories
ai-dev onboard <path>         register a repo, open knowledge-bootstrap PR
ai-dev inspect <ISSUE>        full run detail
ai-dev pause|resume|cancel|retry <ISSUE>
ai-dev routes                 effective routing table + resource pressure
ai-dev metrics                champion/challenger statistics
```

## Implementation status

This repository is a scaffold. `config/`, `prompts/`, `schemas/` and the SQLite schema
are complete and authoritative. `src/` contains typed module contracts with
`NOT_IMPLEMENTED` bodies. See `docs/v1-scope.md` for the exact v1 checklist.
