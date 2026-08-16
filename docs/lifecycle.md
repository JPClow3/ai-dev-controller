# Lifecycle

## What you touch

```
new Linear issue -> automatic ai-curate
                              |
                           curator
                              |
                       automatic ai-ready
                              |
                          ai-running
                              |
                     autonomous work  -- genuine blocker --> ai-blocked
                              |
                        ai-reviewing
                              |
                          draft PR -> ai-pr-open -> YOU MERGE
```

From issue creation through draft PR, the system owns the flow unless it hits a
genuine blocker. There are no routine approval checkpoints.

Curation gathers the available issue and repository context, then moves the
issue directly to `ai-ready`. An unresolved external product decision or
repository ambiguity is a genuine `ai-blocked` interruption.

## What an AI-blocked issue tells you

The `ai-blocked` label marks only the state. Its accompanying Linear comment
states the durable reason, relevant evidence, the owner (`controller`,
`repository`, or `you`), the next action, and whether `pnpm cli resume <issue>`
is appropriate. A label is never meant to force operators to inspect the local
controller database to find out what happened.

Test, build, CI, and integration failures after setup are normally repaired
automatically: the controller prepares a fresh Node worktree through explicit
or recognized lockfile-backed setup, records the failure evidence, and
dispatches a bounded remediation task to a different worker. A failed setup,
exhausted budget, unsafe action, or incomplete recovery path becomes
`ai-blocked`.

## Validation is trusted, not assumed

When a run has a recorded base commit, the controller reads
`.ai-workflow/project.yaml` from that exact commit. It does not use the current
working copy as a fallback, so a worker cannot introduce or replace the command
contract mid-run.

An explicit repository setup command takes precedence. Otherwise the controller
can infer setup only when exactly one recognized lockfile exists at that base:

| Lockfile | Setup |
| --- | --- |
| `package-lock.json` | `npm ci` |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| `yarn.lock` | `yarn install --immutable` |

Missing, unreadable, or conflicting lockfiles produce no guessed setup. Every
setup and validation command is screened against the configured forbidden
operations before the shell is called. A refusal is durable failed evidence
(exit 126), not a skipped check or an implicit permission grant.

## Interruptions you will NOT get

- "Worker A is finished. Continue?"
- "CI passed. Should I ask the reviewer?"
- "Reviewer approved. Should I open the PR?"

## Interruptions you WILL get

```
LIN-301 BLOCKED

The issue requires choosing between two externally visible API behaviours.
Neither the repository documentation nor the Linear issue defines which is
intended.

Question: should unknown risk categories return
  A) HTTP 400
  B) an empty result

Execution paused before implementation.
```

```
LIN-417 BLOCKED

The orchestrator discovered that LIN-417 depends on LIN-390, but no Linear
dependency currently exists.

Suggested relation: LIN-417 blockedBy LIN-390
Execution paused pending DAG approval.
```

## Internal state vs what Linear & Orca Board sees

Linear stays readable on purpose, and Orca's workspace board columns automatically track active issue progress.

| Internal State | Linear Label | Orca Workspace Board |
| --- | --- | --- |
| DISCOVERED, CURATING | `ai-curate` | `todo` |
| WAITING_READY | `ai-ready` | `todo` |
| QUEUED, PLANNING, IMPLEMENTING, INTEGRATING, LOCAL_VALIDATION, PR_DRAFT_OPEN, REMEDIATING | `ai-running` | `in-progress` |
| CI, FINAL_REVIEW, PR_READY, PR_OPEN | `ai-reviewing` / `ai-pr-open` | `in-review` |
| MERGED, CANCELLED | (done / closed) | `completed` |
| DEPENDENCY_BLOCKED, BLOCKED_HUMAN, FAILED | `ai-blocked` | `todo` |

## Git Tagging Best Practice

Git tags provide immutable release anchors, rollback targets, and audit checkpoints across all managed projects.

### Tagging Standards
1. **Semantic Versioning (`vMAJOR.MINOR.PATCH`)**:
   - `MAJOR`: Breaking changes or major architectural redesigns.
   - `MINOR`: New features, endpoints, or backward-compatible capabilities.
   - `PATCH`: Bug fixes, security remediations, and maintenance tasks.
2. **Annotated Tags**: Always use annotated tags (`-a`) with descriptive changelog summaries.
3. **Monorepo / Component Tagging**: In monorepos (e.g. `lorebound`, `throughline`), prefix tags with the package or app name (e.g., `packages/core@v1.2.0`, `apps/web@v2.0.0`).
4. **Pre-release & RC Tags**: Use `-rc.N` or `-beta.N` (e.g., `v1.5.0-rc.1`) before deploying production milestones.

### Workflow Example
```powershell
# Create an annotated release tag on the current merged commit
git tag -a v1.2.0 -m "Release v1.2.0: Multi-project worktree status tracking and Luna-heavy routing"

# Push the tag to remote
git push origin v1.2.0

# List existing tags
git tag -n -l "v*"
```

## One issue, one PR

Linear represents product/development units. Orca represents agent-level
implementation decomposition. An issue with five internal tasks still yields:

```
Linear issue -> one parent worktree/branch -> internal worker tasks
             -> integrated result -> one PR
```

## Waves

```
A ------------+
              +--> D --> F
B --> C ------+
      |
      +----------> E
```

```
Wave 1: A, B
Wave 2: C            (after B merged)
Wave 3: D, E         (after A and C merged)
Wave 4: F            (after D merged)
```

Merged, not "worker finished", not "tests passed", not "PR opened", not
"reviewer approved". Merged.

Every issue branches from a freshly fetched base at the moment it becomes
eligible, so wave 2 never implements against yesterday's `main`.

## Your day

```
Morning:            write / edit issues
During the day:     occasionally check Orca
Later:              GitHub has draft PRs waiting
You:                review -> merge
```

Merging re-opens whatever the explicit dependency graph permits next, on the
following polling cycle.

## Operator commands

Use the CLI to inspect first. State-changing commands are deliberate because
`BLOCKED_HUMAN` is sticky until its underlying cause is resolved.

| Need | Command | Effect |
| --- | --- | --- |
| Check all work | `pnpm cli status` | Read-only active runs and open escalations. |
| Understand one issue | `pnpm cli inspect JP-123` | Read-only branch, worktree, dependency, and transition history. |
| Check integrations | `pnpm cli doctor` | Read-only configuration, Linear, Orca, and Codex reachability. |
| Pause future scheduling | `pnpm cli pause JP-123` | Does not kill an already-running agent. Stop that agent in Orca if required. |
| Resume after resolving a real blocker | `pnpm cli resume JP-123` | Unpauses and requeues a paused or human-blocked run. |
| Re-attempt a bounded repair | `pnpm cli retry JP-123` | Uses a remaining remediation cycle; never overrides the configured budget. |
| Compare durable state with external systems | `pnpm cli recover` | Report-only by default. Add `--apply` only after reviewing the report. |

The controller never merges a pull request. `PR_OPEN` means the draft is ready
for human review and merge.
