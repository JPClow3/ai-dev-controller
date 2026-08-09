# Pilot: JP-8 on Lorebound

**Date:** 2026-08-08
**Repository:** [JPClow3/Lorebound](https://github.com/JPClow3/Lorebound), base `main`
**Issue:** [JP-8 — Add an affordability check to the shared Ink model](https://linear.app/jpclow/issue/JP-8/add-an-affordability-check-to-the-shared-ink-model)
**Model portfolio:** ChatGPT-backed Codex profiles only. Both Ollama providers were
disabled with `AI_DEV_DISABLED_PROVIDERS=ollama,ollama_local`, so every role
resolved through the provider-pressure path to a Codex alias.

A second issue, [JP-9](https://linear.app/jpclow/issue/JP-9/report-the-ink-shortfall-in-quoteink),
was created blocked by JP-8 to exercise the dependency gate. It is expected to
stay out of every ready wave until JP-8's pull request merges.

## What this pilot was for

Not to prove the controller worked. To find out where it did not.

The first attempt stalled with no diagnosis available from inside the system:
a run sat in `IMPLEMENTING` with two worker terminals that had produced
nothing, and the controller reported no error. Reading that run backwards
turned up a chain of defects, each hidden behind the one in front of it.

## Defects found and fixed

Ordered as they were hit, which is also roughly the order they were hiding
each other in.

| # | Defect | Consequence |
|---|---|---|
| 1 | `pnpm-workspace.yaml` carried unanswered `allowBuilds` placeholders | Every `pnpm` invocation failed; the controller could not start at all |
| 2 | Worker launch redirected its prompt with `<` | Orca terminals are PowerShell: "The '<' operator is reserved for future use." No worker ever started |
| 3 | `terminal list` exposes no status and no exit code | "No terminal is running" was vacuously true on the first tick; every worker was declared settled the instant it launched |
| 4 | Worker settle check was scoped to the parent worktree | Worker terminals live in child worktrees, so it was querying a set that is always empty |
| 5 | Nothing ever wrote `attempts.result_json` | `workerCommits` always found zero commits; every run died at `INTEGRATING` with "no worker produced any commit" |
| 6 | Integration, validation, the review diff and the push all ran in the registry clone | That clone has the **base branch** checked out, and Orca worktrees share its object store — cherry-picking there lands worker commits on `main` |
| 7 | Tasks with `blocked_by` were recorded but never dispatched | A plan with any sequential step silently lost its dependent half and reported that every task reached a terminal state |
| 8 | Linear blockers were read from `issue.relations()` | That yields the issues this one *blocks*. The dependency graph was inverted: the first live tick dispatched JP-9 and held JP-8 |
| 9 | Branch identity assumed the controller names its own branches | Orca namespaces under the GitHub owner **and** flattens the separator: `ai/JP-8` becomes `JPClow3/ai-JP-8`. The push guard rejected it, duplicate detection never matched it, and no merged branch resolved back to its issue |
| 10 | Dispatch and provisioning derived different branch names for the same run | Two Orca worktrees for one issue |
| 11 | Nothing stopped a second controller process on the same database | Two controllers polled the same issue; the unique index produced one run, but the loser had already created a worktree and branch for it |
| 12 | Acceptance criteria were never populated | The review packet carried an empty criteria list and the PR body an empty checklist |
| 13 | A stale Orca quota reading was taken at face value | A window at 100% whose reset had already passed marked the only usable provider `EXHAUSTED` |
| 14 | Reviewer selection ignored provider pressure | It picks the *least involved* family — precisely the one most likely to be the disabled one |
| 15 | An empty GitHub check rollup was read as complete-and-failed | Runs went to `REMEDIATING` with an empty list of failures, remediating a CI result that did not exist yet |
| 16 | Worker control files were written into the worktree | Untracked, beside the worker's own changes, one `git add -A` from the pull request |
| 17 | The planner prompt promises a file tree it never received | Every `owns` glob was guessed from the issue text |
| 18 | A fresh worktree has no dependencies installed | Every declared validation command failed for a reason unrelated to the change |
| 19 | A linked worktree's `.git` is outside the sandbox's writable root | The worker did the work and then could not commit it |
| 20 | `windows.sandbox` inherited `elevated` from the user's codex config | The elevated helper raises a UAC prompt: `ERROR_CANCELLED (1223)`. The worker could not touch a single file |
| 21 | `.ai-workflow/project.yaml` is untracked in all nine repositories | A fresh worktree has no validation contract, so a run had no setup and no validation commands at all |
| 22 | `renderPrBody` accepted an `issueUrl` nothing supplied | The PR named the issue instead of linking it |
| 23 | GitHub check parsing read `state`, but the real `gh` CheckRun shape is `status` + `conclusion` | Completed Actions jobs were converted back to `PENDING`, leaving the run in `CI` forever |
| 24 | A transient package-mirror `403 Forbidden` had no bounded retry path | Product checks were green, but the run could only enter an empty remediation state |
| 25 | `review.schema.json` did not require `findings`, while `assessReview` assumed it existed | A valid zero-finding approval was persisted and then crashed on `undefined.filter` |
| 26 | The final-review packet supported CI evidence, but the live wiring never supplied it | The reviewer marked AC-7 uncertain even though local validation and GitHub Actions were green |
| 27 | `gh pr create` and `gh pr edit` were sent through the JSON parser | Their normal URL stdout caused a parse error after the remote operation succeeded |
| 28 | The multi-system reconciler existed, but the polling loop called only `advanceAll` | Restart recovery depended on each workflow step happening to be idempotent; completed external side effects were not observed before resumption |
| 29 | A `null` recovery observation meant “provider unavailable” but was treated as “object absent” | A temporary Orca/GitHub outage could turn healthy work into `BLOCKED_HUMAN` during startup |
| 30 | An interrupted worker entered generic `REMEDIATING`, but no remediation task was recorded | The next tick blocked on an empty remediation plan instead of relaunching the task |
| 31 | A missing worker exit sentinel was interpreted as “still running” forever | A terminal or machine crash during `codex exec` could strand an issue in `IMPLEMENTING` indefinitely |
| 32 | `MERGED` projected no Linear label, but never removed the previous lifecycle label | A merged issue could remain visibly stuck on `ai-pr-open` |
| 33 | Curator prompts, schema and agent role existed, but the polling loop never fetched `ai-curate` issues | The documented issue-to-curator entry point was inert; pilots only worked with already-structured `ai-ready` issues |
| 34 | Curator criteria were structured in JSON but their `AC-*` identifiers were not guaranteed in the Linear Markdown | Rebuilding controller state from Linear could lose the review yardstick even though the original database retained it |
| 35 | Refreshing Linear dependency rows deleted and recreated already-satisfied relations | A merged prerequisite could become unsatisfied again on the next poll |
| 36 | `DEPENDENCY_BLOCKED` had no transition back to `QUEUED` | A dependent issue stayed blocked after every prerequisite merged |
| 37 | A configured required check that GitHub did not report was absent from the normalized rollup | CI could be declared green without every required check existing |
| 38 | Recovery could advance only one ordinary state-machine edge per observation | A crash after several completed external effects could not converge directly to the authoritative state |
| 39 | Worker-attempt persistence happened after Orca worktree creation | A crash in that window could launch a duplicate child worktree on restart |
| 40 | Generic recovery could move `BLOCKED_HUMAN` automatically | A state intended to require a human decision was not sticky |
| 41 | Successful curation projected `ai-needs-context` | Linear could not distinguish a contract ready for human approval from one missing information |
| 42 | Curated role and risk were persisted but overwritten or ignored during dispatch | The planner could receive a different routing context from the curator's decision |
| 43 | `branch_push` and `none` CI modes never ensured a pull request existed | Those supported policies could reach `PR_READY` without a PR to finalize |
| 44 | The initially-created draft PR retained its provisional `JP-8: in progress` title | The final GitHub handoff did not reflect the curated Linear issue title |
| 45 | Restart recovery mapped a pushed branch to `CI` even when the repository declared `ci: none` | A no-CI project could wait forever for checks that cannot exist |
| 46 | The controller wrote a worker heartbeat before Orca launched the worker | A crash in that interval made restart recovery mistake dispatch intent for a live process |
| 47 | Passing GitHub checks alone allowed recovery to fast-forward to final review | A stale database could skip the repository's required local-validation gate |
| 48 | Worker routing used only the task risk and defaulted an omitted value to low | A high-risk issue could be silently assigned to a lower-risk model route |
| 49 | Polling started without verifying that every lifecycle label existed in Linear | A new workspace could persist curation locally and fail only at the final label write |
| 50 | Composite-scoring modules and tables existed, but no workflow step recorded a completed run | `ai-dev metrics` stayed empty after a successful real PR, so routing could never learn from the pilot |
| 51 | A final reviewer could omit an acceptance criterion and still approve | The omitted criterion was inferred as satisfied in the PR body instead of being made explicitly uncertain |
| 52 | The first scoring integration used cumulative worktree diffs and generic remediation counts | Retries could inherit another attempt's churn, review remediation distorted first-pass CI, and missing scoring evidence could delay `PR_OPEN` |
| 53 | Draft-PR creation and adoption never populated the existing `pull_requests` durability table | SQLite could know a run was `PR_OPEN` while retaining no durable PR identity; restart reconciliation now backfills every complete GitHub PR observation, including state-machine noops, without mutating report-only runs |
| 54 | Recovery treated the parent planning worktree as an interrupted worker | A restart could move `PLANNING` without a durable plan or first-wave worktrees |
| 55 | Orca created a new parent from stale local `main` after the controller fetched `origin/main` | The recorded base SHA and the actual worktree HEAD disagreed, producing avoidable integration conflicts |
| 56 | Recovery let `REMEDIATING` fall through generic worker recovery | A persisted remediation plan could be skipped and the run returned to ordinary implementation |
| 57 | Remediation counted recovery state transitions as retry-budget consumption | Restart noise could exhaust the budget before any repair worker ran |
| 58 | Remediation findings were dispatched as overlapping per-finding tasks | Multiple workers could own the same file; findings are now grouped into disjoint file-owned tasks and routed away from the original author |
| 59 | Restarted integration cherry-picked an already-applied worker commit again | Patch-equivalent commits now use `git cherry` as the idempotency proof |
| 60 | A remediation child started from the repository base rather than the integrated parent HEAD | The repair worker could review or edit an obsolete version of the change |
| 61 | Green checks from the previous PR head outranked an active or newly-settled remediation worker | Recovery could skip harvesting or integrating the repair; worker and integration evidence now take precedence |
| 62 | Final-review packets contained only the diff, not unchanged current files named by acceptance criteria | A reviewer could mark an unchanged but already-exact test uncertain because it could not inspect it |
| 63 | One exhausted Codex reviewer profile failed the entire final-review step | The controller now tries every eligible independent Codex alias before concluding the provider is unavailable |
| 64 | Provider quota refusal was reduced to an ordinary error and retried every polling tick | The typed refusal and reset deadline are persisted in SQLite; model routes pause across restarts and automatically become eligible after expiry |
| 65 | `ai-dev routes` ignored durable transport pressure | Operators saw `chatgpt NORMAL` while the scheduler correctly had it exhausted; the CLI now renders the same effective map |
| 66 | Old green PR checks could outrank a harvested remediation commit not yet present on the parent | `INTEGRATING` now proves every recorded worker patch is present before recovery considers GitHub checks |

Two of these deserve more than a table row.

**The dependency inversion (8)** is the one that would have been most
expensive to discover later. It was verified against the live API rather than
reasoned about:

```
JP-8  relations:        type=blocks  related=JP-9
JP-9  inverseRelations: type=blocks  issue=JP-8
```

Linear stores one row per pair, owned by the blocking issue. Reading
`relations()` and filtering on `blocks` collects what this issue blocks — the
exact inverse of what the scheduler needs.

**The wrong working tree (6)** was the most dangerous. Orca worktrees are real
`git worktree`s sharing the main clone's object store, so the worker branches
were visible from the registry clone and `git cherry-pick` there would have
succeeded — applying worker commits directly onto the user's checked-out
`main`.

## Design decisions this run forced

**The controller commits, not the worker.** Granting the shared git directory
with `--add-dir` let the worker commit and simultaneously pushed codex onto
the elevated Windows sandbox helper, which cannot run unattended. Rather than
widen further, the worker now leaves its changes in the working tree and the
controller stages the task's declared `owns` globs as git pathspecs. Ownership
stops being a sentence in a prompt and becomes a property of the thing that
writes the commit: a change outside the declared set cannot reach the pull
request, and anything left dirty is logged as the scope violation it is.

**The repository declares how to prepare itself.** A fresh worktree has no
`node_modules`. The first live worker diagnosed this unprompted — *"node_modules
is absent, so the focused script cannot find Vitest (and installing
dependencies would modify paths outside my ownership)"* — and was right on
both counts. Preparation is neither the worker's job nor the controller's
knowledge, so it joins validation in the repository's own `project.yaml`:

```yaml
validation:
  setup:
    command: npm ci
```

## Standing gap: the knowledge bootstrap has not merged anywhere

`.ai-workflow/` exists as an untracked directory in all nine registered
repositories and is committed in none of them. Until each repository's
bootstrap pull request merges, its validation contract does not travel with
the branch, and a run on an old base is judged by today's rules.

The controller now falls back to the registry clone's working copy and warns
every time it does, so the gap is visible rather than silent. The durable fix
is `ai-dev onboard <path>` per repository, and merging the resulting PR.

## Limitation: cross-family review is impossible in a Codex-only portfolio

Section 19 of the design wants the final reviewer drawn from the family least
involved in authoring. With every alias in the `openai` family, the reviewer is
necessarily the same family as the author. The selection code is exercised and
correct; the property it exists to provide is not available under this
constraint. Re-enabling an Ollama provider restores it.

## Outcome

JP-8 reached `PR_OPEN` and produced one real draft pull request:
[JPClow3/Lorebound#13](https://github.com/JPClow3/Lorebound/pull/13).

- One controller run, one parent worktree, one child worker worktree and one
  draft PR were created.
- The Codex worker used the `unelevated` Windows sandbox override and changed
  the two owned files without a UAC prompt.
- Local setup, typecheck, tests and build passed.
- The first GitHub Actions attempt failed while `apt` received `403 Forbidden`
  from `packages.microsoft.com`; the controller classified the raw evidence as
  environmental and requested one bounded failed-job rerun.
- The rerun passed typecheck, lint, tests, build, Playwright installation,
  Playwright smoke, Neon setup and Cloudflare Pages.
- The final Codex review approved with zero findings and AC-1 through AC-7 all
  satisfied after the controller supplied objective CI evidence.
- The PR stayed draft, Linear moved to `ai-pr-open`, and the human remains the
  only merge authority.
- The controller was restarted twice while the run was active. It resumed the
  same run and PR without duplication.
- Draft-PR creation/adoption now writes the PR identity before advancing, and
  startup reconciliation repairs the same record from authoritative GitHub
  metadata even when the run state is already current. Report-only recovery
  remains read-only. A controlled restart backfilled the live JP-8 row with
  PR #13, its URL, draft flag and head/base branches while retaining exactly
  one run, one PR record and one routing sample.
- After startup reconciliation was wired to Orca, Git, GitHub and Linear, the
  runner was force-killed once more. The replacement reclaimed the stale lock,
  completed a live recovery tick and retained exactly one run, one parent
  worktree, one child worktree and one draft PR.
- Future workers now maintain a durable heartbeat. A stale heartbeat triggers
  a bounded task relaunch; exhaustion becomes an explicit human block instead
  of an infinite wait or an empty remediation cycle.
- Before a bounded relaunch, the failed attempt's owned diff is archived in
  its external control directory and its tracked/untracked owned changes are
  removed from the child worktree. Any remaining out-of-scope dirt blocks the
  retry, so a replacement alias cannot inherit or receive credit for another
  worker's code.
- Dispatch intent, Orca launch confirmation and process heartbeat are distinct:
  retries reuse the same deterministic child worktree, and only Orca or the
  worker process may prove that launch began.
- Startup verifies the full Linear lifecycle-label contract before polling, so
  a missing workspace label fails diagnosis before any issue is partially
  curated.
- PR readiness now persists immutable, idempotent worker samples from final
  review evidence, attempt-bounded commit churn, objective CI history and elapsed time.
  Missing provider-quota telemetry is scored neutrally rather than as free
  usage, and legacy `PR_OPEN` runs are backfilled on the next polling tick.
  Scoring is best-effort learning after the durable `PR_OPEN` transition, so
  missing historical worktree evidence cannot delay human review.
- CI scoring deduplicates failed GitHub Actions executions by workflow run id,
  including across an environmental rerun request. Startup recovery persists
  the same check evidence before fast-forwarding state, and a merge observed
  after downtime still gets a best-effort scoring backfill.
- Every expected criterion is normalized into the final review. Reviewer
  silence becomes `uncertain`, and the provenance renderer checks explicit
  `satisfied` evidence rather than treating absence as success.
- After migration v3 and a controlled runner restart, the existing JP-8
  `PR_OPEN` run was backfilled into both repository and global routing stats:
  one `luna_high` / `routine_behavior` sample, composite `0.925`, first-pass
  CI `1.0`, success rate `1.0`. A later polling tick retained exactly one
  sample and one JP-8 run, proving the backfill is idempotent.
- The replacement process then remained alive for at least 58 minutes and 78
  polling ticks with the same PID and lock. During that window a GitHub GraphQL
  request for another registered repository timed out; the runner logged the
  provider error, completed the tick, and continued polling without a restart,
  duplicate run, or state change. This is direct pilot evidence that a transient
  provider outage is isolated rather than becoming a controller crash.
- A separate rough Lorebound issue, [JP-10](https://linear.app/jpclow/issue/JP-10/add-a-display-helper-for-ink-shortfalls),
  was created with only `ai-curate`. The live runner invoked `gpt-luna-low`
  through `codex exec` with `windows.sandbox="unelevated"`, rewrote the issue
  into a repository-aware contract with AC-1 through AC-6, and stopped at
  `ai-curated`, awaiting the human `ai-ready` decision. It created no run,
  branch, worktree or PR.

## Second-wave evidence: JP-9 and JP-10

After the human merged JP-8's PR and applied `ai-ready` to JP-10, the live
Codex-only controller unblocked both issues without recreating JP-8 or requiring
an operator state transition.

- JP-10 completed planning and implementation with Codex, passed the full local
  validation contract and GitHub Actions, received a zero-finding final review,
  and reached `PR_OPEN` as draft [Lorebound PR #14](https://github.com/JPClow3/Lorebound/pull/14).
- JP-9 completed its worker change, local validation and GitHub Actions and
  opened draft [Lorebound PR #15](https://github.com/JPClow3/Lorebound/pull/15).
  Its first review questioned AC-5 because the packet omitted unchanged file
  contents. A different Codex remediation worker verified that the exact test
  already existed and correctly produced no artificial commit.
- On the repeated JP-9 final review, all four eligible Codex profiles reported
  the same account-wide usage limit. A direct CLI probe reported reset at
  **2026-08-15 19:14 America/Sao_Paulo**. This is a technical provider wait,
  not a human gate and not a controller failure.
- The controller persisted `chatgpt = EXHAUSTED` with reset
  `2026-08-15T22:14:00.000Z`. A controlled second tick made no `codex exec`
  call, and the hidden polling process remains available to resume JP-9 at the
  same `FINAL_REVIEW` checkpoint after the deadline.

The two low-risk implementation runs now exist and both reached green draft
pull requests. Final acceptance remains open only because JP-9's independent
model review cannot execute before the Codex provider restores allowance (or
the account receives additional credits); the controller has no authority to
merge either draft.
