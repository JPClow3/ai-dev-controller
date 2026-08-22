# AI Development Controller — Implementation Plan (revised)

> Historical implementation snapshot from 2026-08-07. Its checkboxes and
> environment notes are not current operational status; use `README.md`,
> `docs/lifecycle.md`, and `pnpm cli doctor` for the live contract.

> 2026-08-13 hardening update: validation contracts are now read from each
> run's immutable base SHA and screened by the controller safety policy; CI,
> Windows supervision, and process-level tests are checked in. See
> `docs/operations.md` for current operation and `docs/pilot/first-run.md` for
> evidence and remaining provider limits.

Supersedes `2026-08-07-ai-dev-controller-implementation.md`. Revised 2026-08-07
against the actual machine, not assumptions.

**Goal:** turn approved Linear issues into dependency-aware Orca worktrees,
route implementation across ChatGPT/Codex models (Luna/Sol/Terra), validate and review the
result, and open a draft GitHub PR — with you as the only merge authority.

---

## What changed from the original plan, and why

| Original | Actual | Consequence |
| --- | --- | --- |
| Node 24 LTS, `engines: >=24 <25` | **Node 26.4.0** installed | `engines` is `>=24`. Do not downgrade. |
| `better-sqlite3@^11.8.1` | v11 has **no Node 26 prebuild** | Pinned **`^13.0.3`**, which ships prebuilds for win32-x64. No compile, no VS Build Tools. |
| `pnpm add` just works | pnpm 11 **blocks install scripts** and fails `pnpm test` on its own gate | `pnpm-workspace.yaml` declares both blocked packages triaged. |
| Codex profiles are additive | Your `config.toml` sets `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` globally | Every worker profile **pins its own** `sandbox_mode = "workspace-write"`. Your interactive session is untouched. |
| Hybrid Model Routing | **Pure ChatGPT/Codex stack** (Luna/Sol/Terra) | Ollama Cloud decommissioned; Luna-heavy cost routing with token usage tracking. |
| `orca skills install --skill ...` | Skills are **bundled** with the CLI (`orca skills list`) | No install step needed. |
| Assumed Orca commands | Real surface captured in `docs/reference/orca-agent-context.json` | Build the adapter against that file, not against guesses. |

### The Node 26 / better-sqlite3 finding

`better-sqlite3` v11 compiles from source on Node 26 because no matching
prebuild exists. That compile **hangs** on this machine — MSBuild and two
`cl.exe` processes sat at 0 seconds CPU indefinitely, and the orphaned handles
then locked `node_modules` against deletion. v13.0.3 ships
`prebuilds/win32-x64.node` and loads immediately.

If you ever see `node_modules` refuse to delete on Windows, look for an
orphaned `MSBuild.exe` first.

---

## Environment: verified state

```
node        v26.4.0
git         2.55.0.windows.3
gh          2.96.0        authed JPClow3, scopes: repo, workflow, gist, read:org
codex       0.144.6       OAuth, joaopaulo.grv4@proton.me
orca        1.4.176       runtime ready, 13 repositories registered
Linear      connected, team "Unirv", 7 ai-* labels created
```

### Done

- [x] Node / git / gh / Codex / Orca verified
- [x] 7 `ai-*` Linear labels created in the Unirv workspace
- [x] Codex profiles configured in `~/.codex/config.toml`
- [x] Tasks 1–14 implemented, full test suite passing, typecheck clean
- [x] Orca workspace-board synchronization (todo / in-progress / in-review / completed)
- [x] Ollama Cloud fully removed from workflow, schemas, and routing
- [x] Luna-heavy cost routing and token tracking implemented
- [x] Per-project Antigravity skills and git commit hooks configured across repositories

---

## Tasks 1–5 — complete

| Task | Modules | Tests |
| --- | --- | --- |
| 1. Config contract | `src/config/{schema,scoring-schema,routing-schema,escalation-schema,registry-schema,load-config}.ts` | 9 |
| 2. State + transitions | `src/state/{types,migrations,db,repositories}.ts`, `src/workflow/{states,transitions}.ts` | 27 |
| 3. Linear | `src/linear/{client,issues,labels,dependencies}.ts` | — (see gap below) |
| 4. Resolution + knowledge | `src/projects/resolver.ts`, `src/knowledge/{discovery,manifest}.ts` | 31 |
| 5. Scheduler | `src/scheduler/{dag,capacity,priority}.ts` | 38 |

**Historical gap, now closed:** Linear issue pagination, dependency direction,
lifecycle-label ownership, automatic curation, cursor recovery, and blocker
messages now have focused tests under `tests/linear/`.

### Invariants the tests actually pin down

These are the ones worth keeping green as the rest lands:

- An issue can be claimed exactly once; a second claim returns `null`. Enforced
  by the partial unique index `ux_runs_active_issue`, not by application logic,
  so it survives two controller processes racing.
- A dependency is satisfied **only by a merge**. There are explicit tests that
  "worker finished", "tests passed", "PR opened", and "reviewer approved" all
  leave downstream work blocked.
- An unknown blocker counts as unsatisfied — a typo cannot unblock work.
- Issues inside a dependency cycle are never scheduled.
- A model recommendation cannot substitute for a mechanical fact: entering
  `FINAL_REVIEW` requires `requiredCiPassed`, `MERGED` requires `mergedByHuman`.
- A complete curated contract is promoted automatically to `ai-ready`.
- Scoring weights must sum to 1.0 or the controller refuses to start.

---

## Task 6 — routing and escalation policy

**Files:** `src/routing/{types,policy,pressure,selector,escalation}.ts`,
`src/agents/codex-profiles.ts`
**Tests:** `tests/routing/{selector,escalation}.test.ts`

Config already exists and validates (`config/routing.yaml`, `escalation.yaml`).
What remains is the selection logic.

- [x] `selectModel(input): RoutingDecision` — `utility = expected_score −
      scarcity_penalty − latency_penalty − token_penalty`
- [x] Champion comes from `routing_stats` for `(repository, role)` once it has
      enough samples; otherwise from `config/routing.yaml`
- [x] Pressure source: `orca account list --json` already exposes
      `rateLimits.codex.weekly.usedPercent`. Use it. No browser scraping.
- [x] `nextEscalation()` returns only actions `config/escalation.yaml` permits
      for that failure class — a `mechanical` failure can never reach Sol
- [x] Reviewer selection by authorship share, preferring a family outside the
      dominant one

Tests now pin multi-provider routing policy: same-provider challengers use the
same model at a different reasoning effort; cross-provider challengers may switch
both model and provider; high-risk never experiments; final review prefers a
family outside the dominant one. When ChatGPT is exhausted, routing shifts to
declared Command Code and Z.AI challengers rather than failing while any
provider remains usable.

### Multi-provider routing and TUI (2026-08-19)

Added after the single-provider pilot to generalize structured calls across
providers without changing the selector contract:

- `config/providers.yaml` declares provider connections, transports, optional
  monthly token limits, and the Command Code plan hint.
- `src/agents/command-code-transport.ts` drives `command-code -p --output-format json`.
- `src/agents/openai-compatible-transport.ts` drives Z.AI over HTTP.
- `src/agents/transports.ts` builds enabled transports from config and env.
- `src/providers/{catalog,runtime}.ts` build the router eligibility snapshot:
  an alias needs a transport, an allowed model plan, and a ready provider.
- `src/providers/probe.ts` performs non-billing health probes for the TUI and
  `doctor`; unavailable providers are excluded while healthy providers fail over.
- `src/tui/{snapshot,render}.ts` render provider, pressure, usage, and role
  routing. Run with `pnpm cli ui` (`r` refresh, `q` quit).
- `src/state/migrations.ts` v7-v10 add provider/model attribution and durable
  provider state, authentication state, and next-probe metadata.

Agentic worker sessions remain on Codex/Orca in this phase.

## Task 7 — Orca adapter

**Files:** `src/orca/{client,worktrees,terminals,orchestration}.ts`,
`src/agents/prompt-packets.ts`

Build against `docs/reference/orca-agent-context.json` (the real schema, 325KB).
Commands confirmed present on 1.4.176:

```
orca worktree create --name <n> --repo <sel> --agent <id> --prompt <text>
                     --parent-worktree <sel> --base-branch <ref> --json
orca worktree list|show|rm --json
orca terminal create|read|send|wait --json
orca linear issue --current --full --json
```

- [ ] Every scripted call uses `--json`; never parse human output
- [ ] Before creating anything, check all four sources: controller DB, `orca
      worktree list`, git branches, GitHub PRs
- [ ] Worker packets exclude other workers' transcripts and speculation

## Task 8 — validation, git integration, GitHub checks, draft PR

- [x] Read validation commands from the repository's `.ai-workflow/project.yaml`.
      The controller must never contain "run pytest for Python."
- [x] Cherry-pick worker commits into the parent branch in dependency order;
      conflicts enter `INTEGRATING` remediation rather than letting workers
      touch each other's trees
- [x] `gh` is already authenticated — prefer it over a separate token
- [x] Cover both CI modes: checks on a pushed branch, and checks that require a
      `pull_request` event. In the latter, an early draft PR is the CI trigger
      but the run stays before `PR_READY` until checks and reviews pass

## Task 9 — cross-family review and remediation
## Task 10 — composite scoring and promotion
## Task 11 — restart reconciliation
## Task 12 — polling runner and CLI

Unchanged from the original plan, except: `src/cli/main.ts` already implements
`config`, `projects`, `status`, `inspect`, and `migrate`. The rest print a
pointer to the task that delivers them.

## Task 13 — repository bootstrap PR

Unchanged.

## Task 14 — pilot

Suggested pilot repository: something small with deterministic tests. Of the
registered projects in Orca, `Portfolio` or `Lorebound` are the least risky; avoid
`unirv-monolith` for a first run.

---

## Acceptance test for v1

Unchanged, and worth restating because it is the real definition of done:

```
rough Linear issue
-> controller applies ai-curate
-> curator improves it
-> controller applies ai-ready
-> controller claims it exactly once
-> explicit blockers respected
-> fresh parent Orca worktree from origin/main
-> planner decomposes bounded tasks
-> router selects eligible profiles
-> worker child worktrees execute
-> commits integrate into one parent branch
-> repository-defined local validation passes
-> GitHub Actions required checks pass
-> Sol final review, zero blocking findings
-> one draft PR
-> human remains the only merge authority
-> controller restart at any stage resumes without duplication
```

Twice, on two low-risk issues.
