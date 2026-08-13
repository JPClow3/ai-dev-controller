# Windows Bootstrap and Local Registry Implementation Plan

> Historical implementation plan. The current bootstrap contract is in
> `docs/windows-notebook-setup.md`: Corepack activates the exact pnpm release
> declared by `package.json`, not `pnpm@latest`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows bootstrapper that installs and validates controller prerequisites, while allowing each device to override only repository paths.

**Architecture:** The loader will read the committed registry and apply an allowlisted local overlay that may change only `projects.<id>.repository.path`. A PowerShell script will audit tools by default, optionally use `winget` to install missing dependencies, safely provision local files, and invoke existing CLI checks.

**Tech Stack:** Node.js 24+, TypeScript, Vitest, PowerShell 7, winget, pnpm.

## Global Constraints

- Node must be version 24 or newer; Node 26 is supported by `better-sqlite3@^13`.
- Use `winget` only when the operator passes `-Install`.
- Never overwrite `.env`, `projects/registry.yaml`, or an existing local registry unless `-Force` is supplied.
- `projects/registry.local.yaml` may only override the path of an existing project; it may not change groups, GitHub, branch, Linear, validation, CI, or routing policy.
- Scheduled-task installation is opt-in with `-InstallSupervisor`.
- Account login remains manual: `gh auth login`, `codex login`, and Orca desktop setup.

---

### Task 1: Safe local registry path overlay

**Files:**
- Modify: `src/config/load-config.ts`
- Modify: `tests/config/load-config.test.ts`

**Interfaces:**
- Consumes committed `projects/registry.yaml` and optional `projects/registry.local.yaml`.
- Produces `loadControllerConfig(rootDir)` with local paths substituted and all other committed fields preserved.

- [ ] **Step 1: Write failing tests**

Add focused tests using `scratchRoot()` and `writeFileSync`:

```ts
it('overlays a local repository path while retaining committed metadata', () => {
  const dir = scratchRoot();
  writeFileSync(join(dir, 'projects/registry.local.yaml'),
    `projects:\n  lorebound:\n    repository:\n      path: C:/Code/Pessoais/Lorebound\n`);
  const project = loadControllerConfig(dir).registry.projects.lorebound!;
  expect(project.repository.path).toBe('C:/Code/Pessoais/Lorebound');
  expect(project.repository.github).toBe('JPClow3/Lorebound');
  expect(project.repository.baseBranch).toBe('main');
});

it('rejects a local path override for an unknown project', () => {
  const dir = scratchRoot();
  writeFileSync(join(dir, 'projects/registry.local.yaml'),
    `projects:\n  missing:\n    repository:\n      path: C:/Code/missing\n`);
  expect(() => loadControllerConfig(dir)).toThrow(/unknown project "missing"/);
});
```

- [ ] **Step 2: Verify red**

Run `pnpm test tests/config/load-config.test.ts`. Expected: the first test fails because the current loader replaces the committed registry with the local file.

- [ ] **Step 3: Implement the allowlisted merge**

Add `mergeLocalRegistry(committed: Record<string, unknown>, local: Record<string, unknown>): Record<string, unknown>` to `src/config/load-config.ts`. It must reject local `groups`, unknown project IDs, values other than `repository.path`, and non-string paths. It must copy each committed project and replace only its path. Load committed registry first, merge optional local values, then validate the merged result through `projectRegistrySchema`.

- [ ] **Step 4: Verify green**

Run `pnpm test tests/config/load-config.test.ts`. Expected: all tests pass.

- [ ] **Step 5: Commit**

Run `git add src/config/load-config.ts tests/config/load-config.test.ts` then `git commit -m "feat: safely overlay local registry paths"`.

### Task 2: Windows bootstrap and readiness audit

**Files:**
- Create: `scripts/setup-windows.ps1`
- Modify: `README.md`

**Interfaces:**
- Consumes `[switch]$Install`, `[string]$RepositoryRoot`, `[switch]$InstallSupervisor`, `[switch]$Force`.
- Produces clear pass/fail output and nonzero exit status for unavailable required dependencies/configuration.

- [ ] **Step 1: Define PowerShell contract**

Use this parameter block and comment help:

```powershell
[CmdletBinding()]
param(
  [switch]$Install,
  [string]$RepositoryRoot,
  [switch]$InstallSupervisor,
  [switch]$Force
)
```

Document the three supported commands: audit only, `-Install -RepositoryRoot C:\Code`, and the same command with `-InstallSupervisor`.

- [ ] **Step 2: Implement prerequisite audit and `winget` install**

Implement `Write-CheckResult`, `Find-Command`, `Test-NodeVersion`, and `Ensure-WingetPackage`. The latter only executes in install mode using `winget install --id <id> --exact --accept-package-agreements --accept-source-agreements`. Install Node via `OpenJS.NodeJS.LTS`, Git via `Git.Git`, GitHub CLI via `GitHub.cli`, Codex via `OpenAI.Codex`, and Orca only after `winget search --id <id> --exact` confirms an available package. Enable Corepack and activate the exact pnpm version declared by `package.json` after Node is available.

- [ ] **Step 3: Implement safe local provisioning**

Resolve the controller root from `$PSScriptRoot`. In install mode, copy `.env.example` to `.env` only when `.env` is absent. When `-RepositoryRoot` is provided, generate `projects/registry.local.yaml` using the shared registry's known project IDs and paths below `H:/Code`; map their suffixes to the supplied root. Generate only entries that exist locally. Refuse to replace an existing local registry without `-Force`; never clone repositories.

- [ ] **Step 4: Implement controller checks and optional supervisor installation**

After dependencies are installed, run `pnpm install` and `pnpm cli migrate`. In both modes run `pnpm cli config` and `pnpm cli doctor` when pnpm is available. Report missing `LINEAR_API_KEY`, GitHub/Codex login, and Orca runtime as manual failures. Run `pnpm supervisor:install` and `pnpm supervisor:status` only when `-InstallSupervisor` is supplied and all prerequisite checks pass.

- [ ] **Step 5: Document it**

Add a `## Windows notebook bootstrap` section after README setup with:

```powershell
.\scripts\setup-windows.ps1
.\scripts\setup-windows.ps1 -Install -RepositoryRoot C:\Code
```

Explain that `winget` is used only with `-Install`, credentials are never overwritten, and device paths live in gitignored `projects/registry.local.yaml`.

- [ ] **Step 6: Verify script syntax and read-only behavior**

Run `[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path .\scripts\setup-windows.ps1), [ref]$null, [ref]$parseErrors)` and fail if `$parseErrors.Count -gt 0`. Then run `.\scripts\setup-windows.ps1`. Expected: parser clean; audit reports readiness without installing or modifying machine state.

- [ ] **Step 7: Commit**

Run `git add scripts/setup-windows.ps1 README.md` then `git commit -m "feat: add Windows bootstrap audit"`.

### Task 3: Integrated validation

**Files:**
- Modify only to correct a defect found by validation.

**Interfaces:**
- Consumes the complete loader and bootstrapper implementation.
- Produces fresh evidence of production compatibility.

- [ ] **Step 1: Run all tests**

Run `pnpm test`. Expected: exit code 0 and no test failures.

- [ ] **Step 2: Run static and production checks**

Run `pnpm typecheck`, `pnpm build`, and `git diff --check`. Expected: all exit 0.

- [ ] **Step 3: Inspect the diff boundary**

Run `git status --short` and inspect the diff for `src/config/load-config.ts`, `tests/config/load-config.test.ts`, `scripts/setup-windows.ps1`, and `README.md`. Confirm unrelated existing edits were preserved.

- [ ] **Step 4: Commit the approved docs**

Run `git add docs/superpowers/specs/2026-08-11-windows-bootstrap-and-local-registry-design.md docs/superpowers/plans/2026-08-11-windows-bootstrap-and-local-registry.md` then `git commit -m "docs: document Windows bootstrap setup"`.
