# Actionable Controller Status Design

## Goal

Make every controller-generated commit, pull request, and Linear lifecycle
update answer three questions without requiring an operator to inspect local
SQLite state: what happened, who owns the next action, and what happens next.
The controller must also repair routine validation failures automatically
within its existing bounded remediation policy.

## Observed failure

JP-6 and JP-7 entered `BLOCKED_HUMAN` after local `test` and `build` failed.
Their Portfolio workflow contract declares validation commands but no setup
command, even though the repository has `package-lock.json`. Fresh worktrees
therefore lacked `node_modules` and Vitest. The controller then moved to
`REMEDIATING` without recording any remediation tasks, so the next tick
reported `remediation_empty` and projected only `ai-blocked` to Linear.

This is controller and repository-automation work, not a product decision for
the issue author.

## Status contract

### Linear

`ai-blocked` remains the single, readable lifecycle label. It represents
state, never diagnosis. Before applying it, the controller posts one
structured status comment containing:

- **State**: `AI blocked`.
- **Why**: the durable transition reason.
- **Evidence**: failed command names and compact output when validation is the
  cause; the blocked issue identifiers for a dependency; or the specific
  planner/review reason otherwise.
- **Owner**: `controller`, `repository`, or `you`.
- **Next action**: an imperative, trigger-specific action. For example,
  `remediation_empty` says the controller requires repair; an unresolved
  requirement asks the issue author to answer the listed question; a missing
  validation contract asks the repository owner to declare it.
- **Resume behavior**: whether the controller will retry automatically, or
  the exact `pnpm cli resume <issue>` command to run after the stated action.

The label write happens after the comment. If Linear rejects either write, the
durable escalation is still retained locally and the controller logs the
failure.

### Commits

Controller-created commits use a concise conventional subject:

`<kind>(<project>): <imperative task summary> (<issue>)`

The body records the task identifier, owned paths, the worker's factual
summary, and verification status. A worker report never becomes an assertion
that a check passed. If verification did not run, the commit says why.

### Pull requests

The draft stub and final provenance body start with a `## Decision` section.
It distinguishes CI scaffolding from a review-ready draft and explicitly says
one of:

- `Not ready — CI is running.`
- `Not ready — remediation is in progress.`
- `Ready for your review — draft PR; you remain the merge authority.`

The final body presents a compact verification table before implementation
provenance. Failed, missing, and pending checks are never rendered as a
generic `FAIL` without the command or the next action.

## Automatic validation recovery

1. Before running validation in a fresh worktree, use the repository-declared
   setup command when present.
2. When no setup command is declared, safely infer only lockfile-backed,
   deterministic setup commands: `npm ci` for `package-lock.json`,
   `pnpm install --frozen-lockfile` for `pnpm-lock.yaml`, and `yarn install
   --immutable` for `yarn.lock`. Do not infer setup for a repository without a
   supported lockfile.
3. Record setup as validation evidence. A setup failure is reported as an
   environment/repository issue with its command and output, not disguised as
   a product-test failure.
4. For a real required validation failure after setup succeeds, persist a
   bounded remediation task before transitioning to `REMEDIATING`. The task
   includes the failed command, output digest, current changed files, and the
   original author exclusion. A different worker fixes the issue, then the
   controller repeats setup and validation.
5. Integration conflicts and failed CI receive the same persisted-remediation
   guarantee. No path may enter `REMEDIATING` with an empty remediation plan.
6. Only failures that cannot be safely fixed within the bounded policy become
   `ai-blocked`; their Linear comment identifies the owner and exact action.

## Guardrails

- Never install dependencies without a recognized lockfile or run an
  undeclared arbitrary package-manager command.
- Never update human-owned labels; only controller-owned lifecycle labels are
  changed.
- Keep automatic remediation within the configured cycle budget and use a
  worker other than the original author.
- Do not resume a previously blocked issue automatically after the controller
  code changes. Its existing evidence must be preserved and the operator must
  explicitly resume it after reviewing the new status comment.

## Acceptance criteria

1. A fresh lockfile-backed Node worktree with no declared setup runs the safe
   inferred setup before validation and records it.
2. A post-setup validation failure persists non-empty remediation work before
   the run enters `REMEDIATING`.
3. Every `BLOCKED_HUMAN` path posts an actionable Linear comment before the
   `ai-blocked` label is applied.
4. The rendered stub and final PR bodies state readiness, evidence, and next
   action at the top.
5. Controller-created commit messages identify the project, issue, task,
   scope, and verification truth without claiming unrun checks passed.
6. Existing label-preservation, remediation-budget, workflow-transition,
   typecheck, build, and test coverage remains green.
