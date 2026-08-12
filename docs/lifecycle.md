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

## Internal state vs what Linear sees

Linear stays readable on purpose. `worker_retry_2`, `glm_review`, `ci_pending`
live in the controller, never in the issue tracker.

| Internal | Linear |
| --- | --- |
| DISCOVERED, CURATING | `ai-curate` |
| WAITING_READY | `ai-ready` |
| QUEUED, PLANNING, IMPLEMENTING, INTEGRATING, LOCAL_VALIDATION, REMEDIATING | `ai-running` |
| CI, FINAL_REVIEW, PR_READY | `ai-reviewing` |
| DEPENDENCY_BLOCKED, BLOCKED_HUMAN, FAILED | `ai-blocked` |
| PR_OPEN | `ai-pr-open` |

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
