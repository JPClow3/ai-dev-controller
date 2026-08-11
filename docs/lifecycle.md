# Lifecycle

## What you touch

```
new Linear issue -> automatic ai-curate
                              |
                           curator  -- insufficient context --> ai-needs-context
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
| NEEDS_CONTEXT | `ai-needs-context` |
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
