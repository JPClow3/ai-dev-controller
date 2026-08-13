# v1 scope and module map

This is the current v1 surface. The older sequencing rationale remains in
`docs/implementation-plan.md`; it is not the operational source of truth.

## In scope

| Deliverable | Current implementation |
| --- | --- |
| Shared project registry and device-local path overlay | `src/config/{load-config,registry-schema}.ts`, `projects/registry*.yaml` |
| Durable SQLite state and run claims | `src/state/{db,lock,migrations,repositories}.ts` and `src/state/repositories/` |
| Repository knowledge bootstrap PR | `src/knowledge/{bootstrap,bootstrap-pr,derive,discovery,manifest}.ts` |
| Linear curation, lifecycle labels, and dependencies | `src/curation/`, `src/linear/` |
| Dependency waves, capacity, and priority | `src/scheduler/{dag,capacity,priority}.ts` |
| Orca parent/child worktrees and terminal observation | `src/orca/{client,worktrees,terminals}.ts` |
| Bounded model routing and provider pressure | `src/routing/`, `src/agents/`, `config/{routing,escalation}.yaml` |
| Worker planning, integration, and remediation | `src/workflow/{dispatch,step-workers,steps,orchestrator-*}.ts` |
| Trusted local validation | `src/validation/{local,result,safety}.ts` |
| GitHub checks, draft PRs, and provenance | `src/github/` |
| Restart recovery and reconciliation | `src/recovery/`, `src/workflow/wire-recovery.ts` |
| Independent final review | `src/reviews/`, `src/workflow/orchestrator-review.ts` |
| Routing scoring and controlled promotion | `src/scoring/`, `config/scoring.yaml` |
| Operator CLI and Windows supervision | `src/cli/main.ts`, `scripts/*supervisor*.ps1` |

## Non-negotiable v1 boundaries

- Humans create/edit Linear issues and are the only pull-request merge authority.
- The controller may open draft PRs but never merges, force-pushes protected
  branches, deploys to production, or performs destructive cloud operations.
- A dependency is complete only after its PR merges into the configured base
  branch.
- Each issue uses one parent branch/worktree and produces at most one draft PR.
- A base-pinned validation contract is trusted as configuration, not as authority:
  setup and validation commands remain subject to the safety policy.
- Retry and remediation budgets are finite. A budget or safety boundary is a
  human-visible block, not an infinite autonomous loop.

## Explicitly not v1

- product ideation, roadmap generation, or a design agent
- automatic PR merge or production deployment
- a public webhook, cloud-hosted controller, or custom web dashboard
- Slack/Discord notifications
- automatic mutation of the Linear dependency graph
