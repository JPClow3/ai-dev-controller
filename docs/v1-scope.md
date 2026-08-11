# v1 scope

Ambitious but bounded. Each item maps to a module in `src/`.

## In scope

| # | Deliverable | Module |
| --- | --- | --- |
| 1 | Central project registry | `src/config/registry.ts` |
| 2 | SQLite durable controller state | `src/state/db.ts`, `migrations/` |
| 3 | Repository onboarding + knowledge-bootstrap PR | `src/knowledge/bootstrap.ts` |
| 4 | Linear curator | `prompts/curator.md`, `src/curation/`, `src/linear/` |
| 5 | `ai-ready` detection | `src/scheduler/loop.ts` |
| 6 | Repository resolution | `src/config/registry.ts` |
| 7 | Explicit `blockedBy` DAG processing | `src/scheduler/dag.ts` |
| 8 | Dependency-wave scheduler | `src/scheduler/dag.ts` |
| 9 | 4 issue / 3 worker / 7 global concurrency | `src/scheduler/capacity.ts` |
| 10 | Orca worktree creation | `src/orca/client.ts` |
| 11 | Internal task decomposition | `prompts/planner.md` |
| 12 | Model routing aliases | `config/routing.yaml`, `src/routing/router.ts` |
| 13 | Luna / Terra / Sol via Codex | `src/orca/client.ts` |
| 14 | GLM / Kimi / DeepSeek via Ollama Cloud | `src/orca/client.ts` |
| 15 | Policy-bounded escalation | `config/escalation.yaml`, `src/routing/router.ts` |
| 16 | Local validation | `src/orca/client.ts` |
| 17 | GitHub CI synchronisation | `src/github/client.ts` |
| 18 | Cross-family final review | `src/routing/router.ts` |
| 19 | Draft PR generation | `src/github/pr-body.ts` |
| 20 | Run recovery after restart | `src/state/recovery.ts` |
| 21 | Composite model scoring | `src/scoring/composite.ts` |
| 22 | Champion-challenger experimentation | `src/scoring/promotion.ts` |
| 23 | Low-risk automatic promotion | `src/scoring/promotion.ts` |
| 24 | Medium-risk promotion recommendation | `src/scoring/promotion.ts` |
| 25 | High-risk routing locked | `config/routing.yaml` |
| 26 | Minimal debugging CLI | `cli/index.ts` |

## Explicitly not v1

- product ideation / PM agent / design agent
- auto-generated product roadmap
- automatic PR merge
- production deployments
- cloud server or public Linear webhook
- custom web dashboard
- Slack / Discord notifications
- fully autonomous dependency mutation

## Suggested build order

1. `state/` + migrations + `config/` loading - nothing works without durable state
2. `linear/` new-issue adoption + curator, ending at `ai-needs-context` /
   `NEEDS_CONTEXT` or automatic `ai-ready` / `WAITING_READY`
3. `registry.ts` resolution, `scheduler/dag.ts`, `scheduler/capacity.ts`
4. `orca/client.ts` worktree creation only; verify against a throwaway repo
5. planner + one worker end-to-end on a trivial issue, no review, no PR
6. `github/` CI sync, then draft PR
7. reviewers and the remediation loop
8. `scoring/` and champion-challenger last - it needs samples to be meaningful

Steps 1-5 give a system that produces a branch. Step 6 gives one that produces
a PR. Everything after that is quality, and can land incrementally.
