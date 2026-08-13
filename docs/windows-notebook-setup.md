# Windows Notebook Setup

Use this guide after cloning `ai-dev-controller` on another Windows device.
It keeps shared project identity in version control and stores only that
device's repository paths locally.

## Quick start

Run an audit first:

```powershell
.\scripts\setup-windows.ps1
```

To install missing prerequisites with `winget`, install dependencies, create a
missing `.env`, generate local repository paths, and run migrations:

```powershell
.\scripts\setup-windows.ps1 -Install -RepositoryRoot C:\Code
```

To additionally register the optional current-user Windows supervisor:

```powershell
.\scripts\setup-windows.ps1 -Install -RepositoryRoot C:\Code -InstallSupervisor
```

The installer uses `winget` only when `-Install` is supplied. It can install
Node.js LTS, Git, GitHub CLI, Codex CLI, and Orca when Orca is available from
the configured package source. It enables Corepack and activates the exact
`pnpm` version declared in `package.json`; it never substitutes `pnpm@latest`.

## Manual actions

The script deliberately cannot complete interactive authentication or provide
secrets. Complete these after installation:

```powershell
gh auth login
codex login
```

Open and sign in to the Orca desktop application, then add `LINEAR_API_KEY` to
the generated `.env`. The GitHub token is optional when the authenticated `gh`
identity already has `repo` and `workflow` scopes.

If a fresh Node installation is not visible to the current terminal, open a
new PowerShell window and rerun the same command. The bootstrapper stops with
that instruction instead of proceeding without a supported Node version.

After a successful install, confirm the live dependencies before enabling
unattended work:

```powershell
pnpm cli doctor
pnpm supervisor:status
```

`doctor` contacts configured services and performs a real Codex availability
probe. A green binary lookup alone is not proof that the account can run work.

## Device-specific repository paths

`projects/registry.yaml` is shared configuration. It defines the stable
project ID, GitHub repository, base branch, Linear mapping, validation policy,
and CI policy. Do not change these fields simply because a notebook uses a
different drive or clone location.

The bootstrapper writes the local, gitignored file
`projects/registry.local.yaml`. It contains only paths, for example:

```yaml
projects:
  lorebound:
    repository:
      path: C:/Code/Pessoais/Lorebound
```

The controller merges that path over the corresponding shared project entry.
It rejects unknown project IDs and any attempt to override groups, GitHub
slugs, branches, Linear mappings, validation, or CI policy.

The generated file is preserved on later runs. Use `-Force` only when you
intend to replace that device's complete local path mapping:

```powershell
.\scripts\setup-windows.ps1 -Install -RepositoryRoot D:\Projects -Force
```

## Audit behavior and troubleshooting

The default audit does not install packages, create local files, or register a
scheduled task. It does check command availability, account status, controller
configuration, and `pnpm cli doctor`. That final command can contact configured
providers, so expect it to expose expired authentication or unavailable
services. If Codex authentication is expired, run `codex login` and audit
again.

Use these commands to inspect or remove the optional supervisor:

```powershell
pnpm supervisor:status
pnpm supervisor:uninstall
```

The supervisor is a limited, current-user Scheduled Task. It starts at logon,
enforces a single controller process, restarts the controller after an
unexpected exit, and checks the Orca desktop runtime every 30 seconds. It does
not elevate or merge pull requests. Repository changes remain the normal,
bounded responsibility of the controller workflow it supervises.
