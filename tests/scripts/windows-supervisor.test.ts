import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const supervisorPath = resolve(root, 'scripts/controller-supervisor.ps1');
const managerPath = resolve(root, 'scripts/manage-windows-supervisor.ps1');

describe.runIf(process.platform === 'win32')('Windows controller supervision', () => {
  it('ships PowerShell scripts that the installed pwsh parser accepts', async () => {
    for (const path of [supervisorPath, managerPath]) {
      const escaped = path.replaceAll("'", "''");
      const command = [
        '$errors = @()',
        '$tokens = $null',
        `[void][Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors)`,
        "if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }",
      ].join('; ');
      await expect(execa('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command])).resolves.toMatchObject({
        exitCode: 0,
      });
    }
  });

  it('registers a limited logon task with bounded restart behavior', () => {
    const manager = readFileSync(managerPath, 'utf8');
    expect(manager).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(manager).toContain('-LogonType Interactive -RunLevel Limited');
    expect(manager).toContain('-RestartCount 999');
    expect(manager).toContain('-MultipleInstances IgnoreNew');
    expect(manager).toContain('Stop-ControllerOwnedByRepository');
  });

  it('isolates controller pipes and restores Orca without restarting the supervisor', () => {
    const supervisor = readFileSync(supervisorPath, 'utf8');
    expect(supervisor).toContain('AiDevControllerSupervisor-');
    expect(supervisor).toContain('RedirectStandardOutput $controllerStdout');
    expect(supervisor).toContain('RedirectStandardError $controllerStderr');
    expect(supervisor).toContain('while (-not $child.WaitForExit($OrcaCheckSeconds * 1000))');
    expect(supervisor).toContain('Ensure-OrcaRuntime');
    expect(supervisor).toContain("@('open', '--json')");
  });
});
