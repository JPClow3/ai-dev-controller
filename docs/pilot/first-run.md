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

_Filled in below once the run completed._
