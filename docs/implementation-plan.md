# AI Development Controller — Implementation Plan (revised)

Supersedes `2026-08-07-ai-dev-controller-implementation.md`. Revised 2026-08-07
against the actual machine, not assumptions.

**Goal:** turn approved Linear issues into dependency-aware Orca worktrees,
route implementation across Codex and Ollama Cloud, validate and review the
result, and open a draft GitHub PR — with you as the only merge authority.

---

## What changed from the original plan, and why

| Original | Actual | Consequence |
| --- | --- | --- |
| Node 24 LTS, `engines: >=24 <25` | **Node 26.4.0** installed | `engines` is `>=24`. Do not downgrade. |
| `better-sqlite3@^11.8.1` | v11 has **no Node 26 prebuild** | Pinned **`^13.0.3`**, which ships prebuilds for win32-x64. No compile, no VS Build Tools. |
| `pnpm add` just works | pnpm 11 **blocks install scripts** and fails `pnpm test` on its own gate | `pnpm-workspace.yaml` declares both blocked packages triaged. |
| Codex profiles are additive | Your `config.toml` sets `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` globally | Every worker profile **pins its own** `sandbox_mode = "workspace-write"`. Your interactive session is untouched. |
| Model access available | **Codex weekly quota at 100%**, resets Sat ~12:49; **Ollama not installed** | No worker models until either is resolved. Tasks 1–5 need none. |
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
ollama      NOT INSTALLED
Linear      connected, team "Unirv", 7 ai-* labels created
```

### Done

- [x] Node / git / gh / Codex / Orca verified
- [x] 7 `ai-*` Linear labels created in the Unirv workspace
- [x] 9 Codex profiles + `ollama-launch` provider written to `~/.codex/config.toml`
      (backup: `config.toml.pre-ai-dev-20260807-172919.bak`)
- [x] Tasks 1–5 implemented, 105 tests passing, typecheck clean

### Blocked on you

- [ ] **Install Ollama**, then `ollama signin`. This is the critical path: it is
      the only worker family available before the Codex quota resets.
- [ ] Verify the three cloud models respond:
      `ollama run glm-5.2:cloud "Reply only with OK"` (and kimi-k2.7-code, deepseek-v4-flash)
- [ ] `codex --profile ollama-glm` from a normal terminal, once Ollama is up
- [ ] Register the 9 Orca custom agents (Settings → Agents), binary `codex`,
      args `--profile <name>`. Leave the built-in Codex entry alone.
- [ ] Put a Linear personal API key in `.env` as `LINEAR_API_KEY`
- [ ] After Saturday: `codex --profile gpt-luna-high` to confirm the GPT tier

---

## Tasks 1–5 — complete

| Task | Modules | Tests |
| --- | --- | --- |
| 1. Config contract | `src/config/{schema,scoring-schema,routing-schema,escalation-schema,registry-schema,load-config}.ts` | 9 |
| 2. State + transitions | `src/state/{types,migrations,db,repositories}.ts`, `src/workflow/{states,transitions}.ts` | 27 |
| 3. Linear | `src/linear/{client,issues,labels,dependencies}.ts` | — (see gap below) |
| 4. Resolution + knowledge | `src/projects/resolver.ts`, `src/knowledge/{discovery,manifest}.ts` | 31 |
| 5. Scheduler | `src/scheduler/{dag,capacity,priority}.ts` | 38 |

**Known gap:** Task 3's mocked `@linear/sdk` tests are not written. The modules
are implemented but only exercised by typecheck. Write them before trusting the
polling loop.

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
`src/agents/{codex-profiles,ollama-profiles}.ts`
**Tests:** `tests/routing/{selector,escalation}.test.ts`

Config already exists and validates (`config/routing.yaml`, `escalation.yaml`).
What remains is the selection logic.

- [ ] `selectModel(input): RoutingDecision` — `utility = expected_score −
      scarcity_penalty − latency_penalty`
- [ ] Champion comes from `routing_stats` for `(repository, role)` once it has
      enough samples; otherwise from `config/routing.yaml`
- [ ] Pressure source: `orca account list --json` already exposes
      `rateLimits.codex.weekly.usedPercent`. Use it. No browser scraping.
- [ ] `nextEscalation()` returns only actions `config/escalation.yaml` permits
      for that failure class — a `mechanical` failure can never reach Sol
- [ ] Reviewer selection by authorship share, preferring a family outside the
      dominant one

Tests pin the OpenAI pilot policy: challengers use the same model at a different
reasoning effort; high-risk never experiments; final review uses the Sol tier.

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

- [ ] Read validation commands from the repository's `.ai-workflow/project.yaml`.
      The controller must never contain "run pytest for Python."
- [ ] Cherry-pick worker commits into the parent branch in dependency order;
      conflicts enter `INTEGRATING` remediation rather than letting workers
      touch each other's trees
- [ ] `gh` is already authenticated — prefer it over a separate token
- [ ] Cover both CI modes: checks on a pushed branch, and checks that require a
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

**Cannot run before Ollama is installed or the Codex quota resets.** Suggested
pilot repository: something small with deterministic tests. Of the 13
registered in Orca, `inmet-api` or `Portfolio` are the least risky; avoid
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
