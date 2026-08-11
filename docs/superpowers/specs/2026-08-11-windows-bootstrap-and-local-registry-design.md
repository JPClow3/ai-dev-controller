# Windows Bootstrap and Local Registry Design

## Goal

Make a fresh Windows notebook ready to operate the controller through one PowerShell entry point, while keeping device-specific repository paths out of committed configuration.

## Scope

The change adds `scripts/setup-windows.ps1` and corrects the existing local-registry overlay behavior. It does not create or change a Linear issue, modify GitHub repositories, create a scheduled task unless explicitly requested, or automate account login.

## User Interface

`scripts/setup-windows.ps1` supports these modes:

- Default: read-only readiness audit.
- `-Install`: install missing prerequisites through `winget`, install controller dependencies, create `.env` from `.env.example` only when absent, run migrations, and then rerun the audit.
- `-RepositoryRoot <path>`: generate the notebook's `projects/registry.local.yaml` with local repository paths under the selected root.
- `-InstallSupervisor`: explicitly install the current-user Windows scheduled-task supervisor after the audit passes.

The script never overwrites `.env`, `projects/registry.yaml`, or an existing `projects/registry.local.yaml` without an explicit force option. It reports manual next steps for credentials and interactive sign-in: `LINEAR_API_KEY`, `gh auth login`, `codex login`, and Orca desktop setup.

## Local Registry Model

`projects/registry.yaml` stays committed and contains all shared repository identity and policy: project IDs, GitHub slugs, branches, Linear mappings, validation policy, and CI policy.

`projects/registry.local.yaml` remains gitignored and contains only repository path overrides:

```yaml
projects:
  lorebound:
    repository:
      path: C:/Code/Pessoais/Lorebound
```

On load, the controller deep-merges a local entry over the matching committed project entry. It rejects a local entry for an unknown project. It does not allow the local file to define groups or change GitHub, Linear, branch, validation, or CI policy. This prevents a local device from silently changing shared scheduling behavior.

## Bootstrap Flow

1. Resolve the repository root from the script location.
2. Inspect `winget`, Node 24+, pnpm, Git, GitHub CLI, Codex CLI, and Orca CLI/runtime.
3. With `-Install`, install missing package-manager dependencies using `winget` and refresh PATH lookup in the running session where possible.
4. Run `pnpm install`, create `.env` only if absent, generate local path overrides when `-RepositoryRoot` is supplied, and run `pnpm cli migrate`.
5. Run `pnpm cli doctor` plus local configuration and path checks.
6. Install the supervisor only when `-InstallSupervisor` is supplied and all prerequisite checks have passed.

## Failure Handling

Each check has an explicit pass/fail result and useful repair command. The script does not pretend an interactive sign-in or a secret is complete. Missing prerequisites during read-only mode return a nonzero exit code; installable missing prerequisites become manual failures only if `winget` fails or the refreshed command remains unavailable.

## Tests and Verification

Add a configuration regression test that proves a local path override preserves the committed repository metadata, and one that rejects unknown local projects. Validate the PowerShell script with PowerShell's parser and execute its default read-only audit. Then run the focused TypeScript test, full typecheck, full tests, and production build.
