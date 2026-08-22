# Operations runbook

This is the day-to-day reference for a running controller. The normal path is
Linear issue to draft PR without CLI intervention; use these commands to
observe or recover an exceptional state.

## Start and verify

```powershell
pnpm install --frozen-lockfile
pnpm cli migrate
pnpm cli doctor
pnpm supervisor:install
pnpm supervisor:status
```

`pnpm cli doctor` checks the effective configuration, required Linear labels,
the Orca runtime, configured Codex profiles, and a real Codex availability
probe. `pnpm supervisor:status` verifies the Windows current-user supervisor;
the task owns the long-running polling process and starts it again after an
unexpected exit.

## Provider readiness and failover

```powershell
pnpm cli providers
pnpm cli providers --json
pnpm cli ui
```

The router selects only `ready` aliases: their transport is constructed, the
model is allowed by its provider plan, and the provider is not disabled or in a
cooldown. `verified` means a non-billing probe confirmed authentication;
`unknown` means credentials are configured but not proven without a model call.
An unavailable provider is removed from routing while healthy providers keep
working. If none are ready, active runs remain resumable and new work is
throttled until the next successful health refresh. `COMMAND_CODE_BIN` must be
`command-code` or an explicit path—never bare `cmd` on Windows.

For an attended one-off loop instead of the supervisor:

```powershell
pnpm cli run --once
pnpm cli run --dry-run --once
```

Do not start `pnpm cli run` while the supervisor already owns the controller
lock. The read-only commands below remain safe while it is running.

## Inspect before changing state

```powershell
pnpm cli status
pnpm cli inspect JP-123
pnpm cli routes
pnpm cli metrics
pnpm cli recover
```

`recover` is report-only by default. It compares SQLite state with Orca, git,
GitHub, and Linear. Review the report before applying reconciliation:

```powershell
pnpm cli recover --apply
```

## Human blocks and retries

`ai-blocked` has a matching Linear comment with the reason, evidence, owner,
next action, and whether resuming makes sense. Resolve that stated cause first,
then choose the narrowest action:

```powershell
pnpm cli resume JP-123  # unpauses/requeues a paused or human-blocked issue
pnpm cli retry JP-123   # enters one remaining remediation cycle
pnpm cli pause JP-123   # stops future scheduling; does not stop an active worker
```

`retry` cannot bypass the remediation budget. A usage-limit, authentication,
or external-provider interruption may need time or account remediation rather
than another controller attempt.

## Validation trust boundary

For a run with a persisted base SHA, the controller obtains
`.ai-workflow/project.yaml` and setup evidence from that exact commit. It never
falls back to the worker-modifiable worktree. The only inferred setup commands
are `npm ci`, `pnpm install --frozen-lockfile`, and `yarn install --immutable`,
and only when exactly one matching lockfile exists at the base.

Before a setup or validation command reaches a shell, the controller screens it
against `global.safety.forbidden_operations`. A rejected command is stored as
failed validation evidence with exit code 126. The controller does not treat a
repository contract as permission to deploy, mutate production data, delete
remote resources, rotate production secrets, force-push, merge a PR, or alter
branch protection.

## Verification before a change is published

```powershell
pnpm test:ci
pnpm typecheck
pnpm build
node dist/cli/main.js --help
pnpm audit --prod --audit-level high
```

On Windows, also run the script parser/linter gate used by CI:

```powershell
Import-Module PSScriptAnalyzer
Invoke-ScriptAnalyzer -Path scripts -Recurse -Severity Warning,Error
```

The GitHub workflow repeats these gates on locked Node 24 for pushes to `main`
and pull requests. A local pass is strong evidence, but remote CI is the final
published-change confirmation.

## Release management and Git tagging

Tagging creates deterministic recovery anchors and marks milestone releases across all repositories.

### Best practices
- Always create **annotated** tags with a message detailing key changes.
- Push tags explicitly using `git push origin <tag>` or `git push --tags`.
- Tag hotfixes immediately on the patch release commit.

```powershell
# Create an annotated release tag
git tag -a v0.1.0 -m "Release v0.1.0: Controller orchestration and Luna-heavy routing"

# Push tag to remote origin
git push origin v0.1.0
```
