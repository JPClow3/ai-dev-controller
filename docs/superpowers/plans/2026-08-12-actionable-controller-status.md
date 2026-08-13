# Actionable Controller Status Implementation Plan

> Historical implementation plan. The implemented behavior now also pins
> validation contracts to a run's base SHA and screens setup and validation
> commands against the configured safety policy. See `docs/lifecycle.md` and
> `docs/operations.md` for the live contract.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Ensure controller status is actionable in Linear, commits, and PRs, while automatically preparing lockfile-backed worktrees and remediating ordinary validation failures.

**Architecture:** Keep ai-* labels as concise lifecycle projections and publish detailed state in a structured Linear comment. Centralize safe validation setup discovery and remediation-task construction so every transition into REMEDIATING has durable work. Keep presentation pure in commit and PR renderers, with workflow steps supplying factual evidence.

**Tech Stack:** TypeScript, Vitest, Linear SDK, GitHub CLI, SQLite controller state, Node filesystem APIs.

## Global Constraints

- Preserve human-owned Linear labels; modify controller-owned ai-* labels only.
- Post the detailed Linear blocker comment before applying ai-blocked.
- Infer setup only from a supported lockfile; never discover arbitrary package-manager commands.
- A remediation worker must exclude original authors and remain within the configured remediation budget.
- Do not automatically resume existing blocked runs.
- Never claim validation passed unless the recorded command exit code proves it.

---

### Task 1: Safe validation setup discovery

**Files:**
- Modify: src/validation/local.ts
- Modify: tests/validation/local.test.ts

**Interfaces:**
- Produces: readEffectiveSetupCommand(repoPath): ValidationCommand | null.
- Consumes: declared validation.setup, filesystem lockfiles, and ValidationCommand.
- Precedence: declared setup wins; otherwise infer npm ci from package-lock.json, pnpm install --frozen-lockfile from pnpm-lock.yaml, or yarn install --immutable from yarn.lock.

- [ ] **Step 1: Write the failing tests**

    expect(readEffectiveSetupCommand(scratchRepo({ 'package-lock.json': '{}' })))
      .toEqual({ name: 'setup', command: 'npm ci', required: true });
    expect(readEffectiveSetupCommand(scratchRepo({ 'pnpm-lock.yaml': 'lockfileVersion: 9' })))
      .toEqual({ name: 'setup', command: 'pnpm install --frozen-lockfile', required: true });
    expect(readEffectiveSetupCommand(scratchRepo({ 'requirements.txt': 'x' }))).toBeNull();

Include a declared setup plus package-lock.json fixture proving declaration precedence.

- [ ] **Step 2: Run it to verify it fails**

Run: pnpm test tests/validation/local.test.ts

Expected: FAIL because readEffectiveSetupCommand does not exist.

- [ ] **Step 3: Implement the minimum safe lookup**

    export function readEffectiveSetupCommand(repoPath: string): ValidationCommand | null {
      return readSetupCommand(repoPath) ?? inferredLockfileSetup(repoPath);
    }

inferredLockfileSetup checks only the three recognized lockfiles in the order stated above.

- [ ] **Step 4: Run it to verify it passes**

Run: pnpm test tests/validation/local.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

    git add src/validation/local.ts tests/validation/local.test.ts
    git commit -m "fix(validation): prepare lockfile-backed worktrees"

### Task 2: Persist remediation for every automatic failure path

**Files:**
- Modify: src/reviews/remediation.ts
- Modify: src/workflow/orchestrator.ts
- Modify: tests/workflow/orchestrator.test.ts

**Interfaces:**
- Produces: pure factories for validation, CI, and integration-conflict RemediationTask arrays.
- Consumes: ValidationSummary, failed CI check names, conflict paths, and original worker aliases.
- Invariant: no route may transition to REMEDIATING without a non-empty persisted plan.

- [ ] **Step 1: Write the failing transition tests**

    const result = await advanceRun(ctx('LOCAL_VALIDATION'), deps({ runValidation: failingValidation }));
    expect(result.to).toBe('REMEDIATING');
    expect(repos.pendingRemediation(run.id)).toEqual([
      expect.objectContaining({
        file: '.',
        suggestedValidation: 'pnpm test',
        instruction: expect.stringContaining('Expected true to be false'),
      }),
    ]);

Add equivalent assertions for failed required CI, INTEGRATING conflicts, and PR_READY CI regression.

- [ ] **Step 2: Run it to verify it fails**

Run: pnpm test tests/workflow/orchestrator.test.ts

Expected: FAIL because those paths leave pendingRemediation empty.

- [ ] **Step 3: Implement and persist before transition**

    deps.repos.recordRemediationPlan(
      ctx.run.id,
      remediationForValidation(summary, deps.originalAuthors(ctx.run.id)),
    );
    return move(ctx, deps, 'REMEDIATING', {
      reason: "local validation failed: " + summary.failedRequired.join(', '),
    });

Use failureDigest(summary) in task instructions and the failed command as suggestedValidation. Use . only when no precise changed file is attributable; retain exact conflict paths. Never overwrite an existing non-empty plan during recovery.

- [ ] **Step 4: Run it to verify it passes**

Run: pnpm test tests/workflow/orchestrator.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

    git add src/reviews/remediation.ts src/workflow/orchestrator.ts tests/workflow/orchestrator.test.ts
    git commit -m "fix(workflow): persist remediation for failed gates"

### Task 3: Run effective setup and capture honest evidence

**Files:**
- Modify: src/workflow/steps.ts
- Modify: tests/workflow/steps.test.ts

**Interfaces:**
- Consumes: readEffectiveSetupCommand() and runRequiredValidation().
- Produces: a validation summary whose first result is setup whenever it is declared or safely inferred.

- [ ] **Step 1: Write the failing workflow test**

Create a temporary worktree with package-lock.json and project YAML declaring npm run test:unit. Assert the runner receives setup npm ci followed by the declared test.

- [ ] **Step 2: Run it to verify it fails**

Run: pnpm test tests/workflow/steps.test.ts

Expected: FAIL because only declared setup is included today.

- [ ] **Step 3: Implement the effective setup invocation**

    const setup = readEffectiveSetupCommand(contractPath(ctx));
    const commands = [...(setup ? [setup] : []), ...readValidationCommands(contractPath(ctx))];

Keep repos.recordValidation unchanged so a setup failure is durable evidence.

- [ ] **Step 4: Run it to verify it passes**

Run: pnpm test tests/workflow/steps.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

    git add src/workflow/steps.ts tests/workflow/steps.test.ts
    git commit -m "fix(workflow): run deterministic validation setup"

### Task 4: Render actionable Linear blocker notices

**Files:**
- Modify: src/linear/dependencies.ts
- Modify: tests/linear/dependencies.test.ts
- Modify: src/workflow/steps.ts
- Modify: tests/workflow/steps.test.ts

**Interfaces:**
- Produces: renderBlockerNotice({ issueId, trigger, reason, evidence? }) and postBlockerNotice().
- Consumes: controller trigger, durable reason, optional failure digest, and issue identifier.
- Behavior: writes the structured comment before setAiLifecycleLabel(issueId, ai-blocked).

- [ ] **Step 1: Write failing renderer and ordering tests**

    expect(renderBlockerNotice({ issueId: 'JP-6', trigger: 'remediation_empty', reason: '...' }))
      .toContain('**Owner:** controller');
    expect(notice).toContain('**Next action:** Repair the controller remediation plan before resuming this issue.');
    expect(commentCallOrder).toBeLessThan(labelCallOrder);

Cover unresolved_requirement, no_validation_available, and remediation_empty. Include pnpm cli resume JP-6 only when the action belongs to the issue or repository owner.

- [ ] **Step 2: Run them to verify they fail**

Run: pnpm test tests/linear/dependencies.test.ts tests/workflow/steps.test.ts

Expected: FAIL because the current comment contains only Execution paused.

- [ ] **Step 3: Implement exhaustive trigger-to-action mapping**

Unknown triggers must default to controller ownership and an explicit investigation action. Have blockForHuman call the new posting function, then set the lifecycle label.

- [ ] **Step 4: Run them to verify they pass**

Run: pnpm test tests/linear/dependencies.test.ts tests/workflow/steps.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

    git add src/linear/dependencies.ts tests/linear/dependencies.test.ts src/workflow/steps.ts tests/workflow/steps.test.ts
    git commit -m "feat(linear): publish actionable blocker notices"

### Task 5: Improve commit and PR decision messaging

**Files:**
- Modify: src/github/pr-body.ts
- Modify: tests/github/pr-body.test.ts
- Modify: src/workflow/steps.ts
- Modify: tests/workflow/steps.test.ts

**Interfaces:**
- Adds: a structured decision and validation-detail fields to PrBodyInput.
- Adds: a pure controller commit-message formatter used by commitWorkerChanges.
- Consumes: project id, issue id, task category/summary, owned files, worker report, and recorded validation evidence.

- [ ] **Step 1: Write failing renderer tests**

    expect(renderStubPrBody('JP-6')).toMatch(/## Decision[\s\S]*Not ready — CI is running\./);
    expect(renderPrBody(base)).toMatch(/## Decision[\s\S]*Ready for your review/);
    expect(renderPrBody({ ...base, validation: [{ name: 'test', passed: false, command: 'pnpm test' }] }))
      .toContain('pnpm test');
    expect(formatWorkerCommitMessage(input).split('\n')[0])
      .toBe('test(portfolio): cover GitHub fallback activity (JP-6)');

- [ ] **Step 2: Run them to verify they fail**

Run: pnpm test tests/github/pr-body.test.ts tests/workflow/steps.test.ts

Expected: FAIL because decision rendering and the formatter are absent.

- [ ] **Step 3: Implement concise, factual renderers**

Render the decision first, then a compact validation table with status, command, and next action. Derive commit kind only from a finite task-category map with chore fallback. Keep issue ID intact while limiting the generated subject to 72 characters. The body retains task ID, owned paths, worker report, and verification truth.

- [ ] **Step 4: Run them to verify they pass**

Run: pnpm test tests/github/pr-body.test.ts tests/workflow/steps.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

    git add src/github/pr-body.ts tests/github/pr-body.test.ts src/workflow/steps.ts tests/workflow/steps.test.ts
    git commit -m "feat(github): surface review decisions and verification"

### Task 6: Document lifecycle semantics and validate integration

**Files:**
- Modify: README.md
- Modify: docs/lifecycle.md
- Test: full repository suite

- [ ] **Step 1: Update user-facing lifecycle documentation**

Document that ai-blocked is paired with an actionable Linear comment, setup is inferred only from recognized lockfiles, and normal validation failures enter bounded automatic remediation.

- [ ] **Step 2: Verify documentation consistency**

Run: rg -n "ai-blocked|setup|remediation" README.md docs/lifecycle.md

Expected: both documents describe the same owner and next-action contract.

- [ ] **Step 3: Run complete verification**

    pnpm test
    pnpm typecheck
    pnpm build
    git diff --check

Expected: every command exits 0.

- [ ] **Step 4: Inspect final scope**

Run: git diff --check; git diff --stat; git status --short

Expected: planned controller, test, and documentation files changed; unrelated user work remains preserved.

- [ ] **Step 5: Commit**

    git add README.md docs/lifecycle.md
    git commit -m "docs: explain actionable controller lifecycle status"
