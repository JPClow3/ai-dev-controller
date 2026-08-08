import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createOrcaClient } from '../../src/orca/client.js';
import {
  createParentWorktree,
  createWorkerWorktree,
  unwrapWorktree,
  branchNameFor,
} from '../../src/orca/worktrees.js';
import {
  launchWorker,
  unwrapTerminal,
  workerCommand,
  workerScript,
  readWorkerExit,
} from '../../src/orca/terminals.js';

/** Controller-owned scratch directory, deliberately outside any worktree. */
const CONTROL = 'C:/ai-dev/data/workers/run-1/api';

function fakeCli(result: unknown) {
  const calls: string[][] = [];
  const run = vi.fn(async (_bin: string, args: string[]) => {
    calls.push(args);
    return { stdout: JSON.stringify({ id: 't', ok: true, result }), stderr: '' };
  });
  return { calls, client: createOrcaClient({ run }) };
}

/**
 * Regression for the defect that cost the most time to find.
 *
 * Orca returns `result.worktree`, not the worktree. Reading `.id` off the
 * wrapper yielded undefined, which was stored as a null worktree id and only
 * surfaced several states later as "run has no parent worktree" — far from the
 * cause, and with nothing pointing back to it.
 */
describe('Orca wraps single objects under a named key', () => {
  const WORKTREE = {
    id: 'repo::C:/wt/ai-JP-7',
    path: 'C:/wt/ai-JP-7',
    branch: 'ai/JP-7',
  };

  it('unwraps result.worktree on parent creation', async () => {
    const { client } = fakeCli({ worktree: WORKTREE });
    const wt = await createParentWorktree(client, {
      repoSelector: 'id:r',
      name: 'ai/JP-7',
      baseBranch: 'main',
    });
    expect(wt.id).toBe(WORKTREE.id);
    expect(wt.path).toBe('C:/wt/ai-JP-7');
  });

  it('unwraps result.worktree on child creation', async () => {
    const { client } = fakeCli({ worktree: WORKTREE });
    const wt = await createWorkerWorktree(client, {
      parentSelector: 'id:p',
      repoSelector: 'id:r',
      name: 'ai-JP-7-api',
    });
    expect(wt.id).toBe(WORKTREE.id);
  });

  it('still accepts an already-unwrapped object', () => {
    expect(unwrapWorktree(WORKTREE).id).toBe(WORKTREE.id);
  });

  /** Storing undefined silently is exactly what made this so slow to find. */
  it('throws immediately rather than yielding an id-less worktree', () => {
    expect(() => unwrapWorktree({ worktree: { path: 'x' } })).toThrow(/no worktree id/);
    expect(() => unwrapWorktree({})).toThrow(/no worktree id/);
    expect(() => unwrapWorktree(null)).toThrow(/no worktree id/);
  });

  it('unwraps result.terminal on worker launch', async () => {
    const { client } = fakeCli({ terminal: { handle: 'term_abc', title: 'JP-7/api' } });
    const term = await launchWorker(client, {
      worktreeSelector: 'id:w',
      title: 'JP-7/api',
      controlDir: 'C:/ctl/JP-7/api',
    });
    expect(term.handle).toBe('term_abc');
  });

  it('throws rather than yielding a handle-less terminal', () => {
    expect(() => unwrapTerminal({ terminal: { title: 'x' } })).toThrow(/no terminal handle/);
    expect(() => unwrapTerminal({})).toThrow(/no terminal handle/);
  });
});

/**
 * Regression: naming a child `ai/JP-7-routine-behavior/github-fallback-tests`
 * made Orca exit 1. The parent link already expresses the relationship.
 */
describe('worker worktree names carry no path separators', () => {
  it('flattens the parent branch into the child name', () => {
    const parentBranch = 'ai/JP-7-routine-behavior';
    const name = `${parentBranch.replace(/\//g, '-')}-github-fallback-tests`;
    expect(name).toBe('ai-JP-7-routine-behavior-github-fallback-tests');
    expect(name).not.toContain('/');
  });

  it('creates the child with the parent link, not a nested path', async () => {
    const { calls, client } = fakeCli({ worktree: { id: 'w', path: 'p' } });
    await createWorkerWorktree(client, {
      parentSelector: 'id:parent',
      repoSelector: 'id:repo',
      name: 'ai-JP-7-api',
    });

    const args = calls[0]!;
    expect(args[args.indexOf('--name') + 1]).not.toContain('/');
    expect(args).toContain('--parent-worktree');
    // Orca rejects a child worktree without --repo, even when the parent is
    // given: "Missing repo selector. Pass --repo or run from inside an
    // Orca-managed worktree."
    expect(args).toContain('--repo');
  });
});

describe('worker launch needs no GUI-registered agent', () => {
  /**
   * Custom agents can only be added through the Orca desktop app, which would
   * make the pipeline un-runnable from a script.
   */
  it('runs codex exec as a plain command', () => {
    const script = workerScript('gpt-luna-high', CONTROL);
    expect(script).toContain('codex exec');
    expect(script).toContain('--profile gpt-luna-high');
    expect(script).toContain('--sandbox workspace-write');
  });

  /**
   * Regression for the defect that silently killed every worker: Orca
   * terminals are PowerShell, and PowerShell answers `<` with "The '<'
   * operator is reserved for future use." The command failed before codex was
   * ever invoked, and nothing in the controller could see it.
   */
  it('pipes the prompt instead of redirecting it', () => {
    const script = workerScript('x', CONTROL);
    expect(script).not.toMatch(/<\s*'?\S*prompt/);
    expect(script).toContain(`Get-Content -Raw '${join(CONTROL, 'prompt.txt')}' |`);
  });

  it('reads the prompt from a file, not argv', () => {
    // The prompt plus schema exceeds the Windows command-line limit.
    expect(workerScript('x', CONTROL)).toContain(join(CONTROL, 'prompt.txt'));
  });

  it('captures only the final message', () => {
    expect(workerScript('x', CONTROL)).toContain(`--output-last-message '${join(CONTROL, 'result.txt')}'`);
  });

  /**
   * The controller's scratch used to sit in the worktree, one `git add -A`
   * away from being committed into the pull request.
   */
  it('keeps every control file out of the repository', () => {
    const script = workerScript('x', CONTROL);
    for (const name of ['prompt.txt', 'result.txt', 'exit.txt']) {
      expect(script).toContain(join(CONTROL, name));
    }
    expect(script).not.toMatch(/(^|\s)'?\.\//m);
  });

  /**
   * Orca terminals are long-lived shells: `terminal list` reports no status
   * and no exit code, so completion has to be recorded by the worker itself.
   */
  it('records its own exit status where the controller can read it', () => {
    const script = workerScript('x', CONTROL);
    expect(script).toContain('$LASTEXITCODE');
    expect(script).toContain(`Set-Content -Path '${join(CONTROL, 'exit.txt')}'`);
  });

  it('launches the script through an explicit pwsh, not the ambient shell', () => {
    expect(workerCommand(CONTROL)).toBe(
      `pwsh -NoProfile -ExecutionPolicy Bypass -File '${join(CONTROL, 'run.ps1')}'`,
    );
  });

  /**
   * The first live worker refused to run tests and said why: "node_modules is
   * absent, so the focused script cannot find Vitest (and installing
   * dependencies would modify paths outside my ownership)". Both halves were
   * correct, so the controller prepares the worktree instead.
   */
  it('runs the repository setup before the agent, when one is declared', () => {
    const script = workerScript('x', CONTROL, { setupCommand: 'npm ci' });
    expect(script.indexOf('npm ci')).toBeLessThan(script.indexOf('codex exec'));
  });

  it('omits setup entirely when the repository declares none', () => {
    expect(workerScript('x', CONTROL)).not.toContain('ai-dev worker: ');
  });

  /**
   * Granting the git directory did let the worker commit, and on Windows it
   * also pushed codex onto an elevated sandbox helper that cannot run
   * unattended (ERROR_CANCELLED 1223 from an unanswerable UAC prompt). The
   * controller commits instead, so the worker needs no widening at all.
   */
  it('widens the sandbox for nothing', () => {
    expect(workerScript('x', CONTROL)).not.toContain('--add-dir');
    expect(workerScript('x', CONTROL, { setupCommand: 'npm ci' })).not.toContain('--add-dir');
  });

  /**
   * The elevated Windows sandbox launches its helper through ShellExecuteExW,
   * which raises a UAC prompt. Unattended it comes back ERROR_CANCELLED
   * (1223) and the worker cannot read or write a single file.
   */
  it('never asks for a UAC prompt nobody can answer', () => {
    expect(workerScript('x', CONTROL)).toContain('windows.sandbox="unelevated"');
  });

  it('treats a missing sentinel as still running, never as success', () => {
    expect(readWorkerExit(null)).toBeNull();
    expect(readWorkerExit('0')).toBe(0);
    expect(readWorkerExit('1\n')).toBe(1);
    // Unparseable is a failure, not a pass.
    expect(readWorkerExit('what')).toBe(1);
  });

  it('never passes --agent', async () => {
    const { calls, client } = fakeCli({ worktree: { id: 'w', path: 'p' } });
    await createParentWorktree(client, { repoSelector: 'id:r', name: 'ai/x', baseBranch: 'main' });
    expect(calls[0]).not.toContain('--agent');
  });
});
