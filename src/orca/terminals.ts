import { join } from 'node:path';
import type { OrcaClient } from './client.js';

export interface OrcaTerminal {
  handle: string;
  worktreeId?: string;
  title?: string;
  status?: string;
  exitCode?: number | null;
}

export async function listTerminals(client: OrcaClient, worktreeSelector?: string): Promise<OrcaTerminal[]> {
  const args = ['terminal', 'list'];
  if (worktreeSelector) args.push('--worktree', worktreeSelector);
  const result = await client.json<{ terminals: OrcaTerminal[] }>(args);
  return result.terminals ?? [];
}

/**
 * Orca wraps a single object under a named key: `result.terminal`. Reading
 * `.handle` off the wrapper silently yields undefined.
 */
export function unwrapTerminal(result: unknown): OrcaTerminal {
  const wrapped = (result as { terminal?: OrcaTerminal })?.terminal;
  const terminal = wrapped ?? (result as OrcaTerminal);
  if (!terminal?.handle) {
    throw new Error(`Orca returned no terminal handle: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return terminal;
}

export async function createTerminal(
  client: OrcaClient,
  input: { worktreeSelector: string; command: string; title?: string },
): Promise<OrcaTerminal> {
  const args = ['terminal', 'create', '--worktree', input.worktreeSelector, '--command', input.command];
  if (input.title) args.push('--title', input.title);
  return client.json<OrcaTerminal>(args);
}

export async function readTerminal(
  client: OrcaClient,
  handle: string,
  cursor?: number,
): Promise<{ output: string; cursor: number }> {
  const args = ['terminal', 'read', '--terminal', handle];
  if (cursor !== undefined) args.push('--cursor', String(cursor));
  return client.json<{ output: string; cursor: number }>(args);
}

export type WaitCondition = 'exit' | 'tui-idle';

/**
 * Waits for an agent terminal to settle.
 *
 * The timeout is enforced by the controller, not left to the agent: a worker
 * that hangs must become a failed attempt with a classifiable outcome, not an
 * occupied slot forever. Callers should treat a timeout as an interrupted
 * attempt and apply the retry policy.
 */
export async function waitForTerminal(
  client: OrcaClient,
  handle: string,
  condition: WaitCondition,
  timeoutMs: number,
): Promise<{ settled: boolean; exitCode: number | null; reason: 'exited' | 'idle' | 'timeout' }> {
  try {
    const result = await client.json<{ exitCode?: number | null; state?: string }>(
      ['terminal', 'wait', '--terminal', handle, '--for', condition, '--timeout-ms', String(timeoutMs)],
      timeoutMs + 30_000,
    );
    return {
      settled: true,
      exitCode: result.exitCode ?? null,
      reason: condition === 'exit' ? 'exited' : 'idle',
    };
  } catch (err) {
    if (/timed? ?out/i.test(String(err))) {
      return { settled: false, exitCode: null, reason: 'timeout' };
    }
    throw err;
  }
}

export async function stopTerminals(client: OrcaClient, worktreeSelector: string): Promise<void> {
  await client.json(['terminal', 'stop', '--worktree', worktreeSelector]);
}

/**
 * Launches a worker agent in its own worktree.
 *
 * `agentName` is the Orca custom agent (e.g. "Ollama DeepSeek V4"), which maps
 * to `codex --profile ollama-deepseek`. The controller chooses the alias; Orca
 * owns the session.
 */
export async function launchAgent(
  client: OrcaClient,
  input: { worktreeSelector: string; agentName: string; prompt: string },
): Promise<OrcaTerminal> {
  return client.json<OrcaTerminal>([
    'terminal',
    'create',
    '--worktree',
    input.worktreeSelector,
    '--command',
    input.agentName,
    '--title',
    `agent:${input.agentName}`,
  ]);
}

/**
 * Names of a worker's control files.
 *
 * These live in a controller-owned directory OUTSIDE the worktree. Written
 * into the worktree they showed up as untracked files next to the worker's
 * own changes, one `git add -A` away from being committed into the pull
 * request — the controller's scratch has no business in the user's diff.
 */
export const WORKER_PROMPT_FILE = 'prompt.txt';
export const WORKER_RESULT_FILE = 'result.txt';
export const WORKER_SCRIPT_FILE = 'run.ps1';
export const WORKER_EXIT_FILE = 'exit.txt';
export const WORKER_HEARTBEAT_FILE = 'heartbeat.txt';
export const WORKER_HEARTBEAT_STALE_MS = 120_000;

/**
 * The launcher script a worker terminal runs.
 *
 * Written to a file and executed with an explicit `pwsh -File` rather than
 * typed into the terminal as a one-liner, for two reasons found by running it:
 *
 *   1. Orca terminals are PowerShell, and PowerShell has no `<` operator — the
 *      previous inline command died on "The '<' operator is reserved for
 *      future use." before codex was ever invoked. `Get-Content | codex -`
 *      is the portable equivalent.
 *
 *   2. Orca terminals are long-lived shells with no exit code and no status in
 *      `terminal list`, so the controller cannot observe completion through
 *      Orca at all. The script records the exit status itself, which also
 *      survives a controller or Orca restart in a way terminal state does not.
 */
export interface WorkerScriptOptions {
  /** The repository's own preparation command, run before the agent. */
  setupCommand?: string;
}

export function workerScript(profile: string, controlDir: string, options: WorkerScriptOptions = {}): string {
  const { setupCommand } = options;
  const q = (name: string) => `'${join(controlDir, name).replace(/'/g, "''")}'`;

  // The repository's own preparation, run before the agent rather than by it.
  // A fresh worktree has no dependencies, and the first live worker said so
  // itself: "node_modules is absent, so the focused script cannot find Vitest
  // (and installing dependencies would modify paths outside my ownership)".
  // It was right on both counts — which is why the controller does it.
  const setup = setupCommand
    ? [`Write-Host "ai-dev worker: ${setupCommand}"`, setupCommand, '']
    : [];

  // No `--add-dir` for the git directory, deliberately. Granting it does let
  // the worker commit, but on Windows it pushes codex onto the elevated
  // sandbox helper, which cannot run unattended:
  //
  //   windows sandbox failed: orchestrator_helper_launch_canceled:
  //   ShellExecuteExW failed to launch setup helper: 1223
  //
  // 1223 is ERROR_CANCELLED — a UAC prompt nobody is there to answer. The
  // controller commits the worker's changes instead, which needs no privilege
  // widening and lets the ownership rule be enforced by pathspec rather than
  // by asking the model nicely.
  const codex = [
    'codex exec',
    `--profile ${profile}`,
    '--sandbox workspace-write',
    // `windows.sandbox` defaults to whatever the user's top-level config says,
    // and "elevated" launches a helper through ShellExecuteExW that raises a
    // UAC prompt. Unattended, nobody answers it:
    //
    //   windows sandbox failed: orchestrator_helper_launch_canceled:
    //   ShellExecuteExW failed to launch setup helper: 1223   (ERROR_CANCELLED)
    //
    // The worker could not read or write a single file. "unelevated" is the
    // only other accepted value and needs no prompt; a disposable worktree
    // does not need administrator rights either way.
    `-c 'windows.sandbox="unelevated"'`,
    '--skip-git-repo-check',
    `--output-last-message ${q(WORKER_RESULT_FILE)}`,
    '-',
  ].join(' ');

  return [
    '$ErrorActionPreference = "Continue"',
    `$heartbeatPath = ${q(WORKER_HEARTBEAT_FILE)}`,
    'Set-Content -Path $heartbeatPath -Value ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -Encoding ascii',
    '$heartbeatJob = Start-Job -ScriptBlock {',
    '  param($path)',
    '  while ($true) {',
    '    Set-Content -Path $path -Value ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -Encoding ascii',
    '    Start-Sleep -Seconds 10',
    '  }',
    '} -ArgumentList $heartbeatPath',
    ...setup,
    `Get-Content -Raw ${q(WORKER_PROMPT_FILE)} | ${codex}`,
    '$code = $LASTEXITCODE',
    'if ($null -eq $code) { $code = 0 }',
    'Stop-Job -Job $heartbeatJob -ErrorAction SilentlyContinue',
    'Remove-Job -Job $heartbeatJob -Force -ErrorAction SilentlyContinue',
    `Set-Content -Path ${q(WORKER_EXIT_FILE)} -Value $code -Encoding ascii`,
    'Write-Host "ai-dev worker finished with exit $code"',
    '',
  ].join('\n');
}

/** The command Orca types into the worker's terminal. */
export function workerCommand(controlDir: string): string {
  return `pwsh -NoProfile -ExecutionPolicy Bypass -File '${join(controlDir, WORKER_SCRIPT_FILE).replace(/'/g, "''")}'`;
}

/**
 * A worker's terminal state, read from the worktree rather than from Orca.
 *
 * `null` means the worker has not written its sentinel yet, which is the only
 * evidence available that it is still working.
 */
export function readWorkerExit(exitFileContents: string | null): number | null {
  if (exitFileContents === null) return null;
  const parsed = Number.parseInt(exitFileContents.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

export interface WorkerLiveness {
  state: 'running' | 'settled' | 'interrupted';
  exitCode: number | null;
}

/**
 * Classifies a worker from durable files rather than an Orca terminal handle.
 * A terminal can survive after its command exits, while a process can vanish
 * without writing an exit sentinel. The heartbeat distinguishes those two
 * cases after a bounded grace period.
 */
export function classifyWorkerLiveness(
  exitFileContents: string | null,
  heartbeatModifiedMs: number | null,
  nowMs = Date.now(),
  staleAfterMs = WORKER_HEARTBEAT_STALE_MS,
): WorkerLiveness {
  const exitCode = readWorkerExit(exitFileContents);
  if (exitCode !== null) return { state: 'settled', exitCode };
  if (heartbeatModifiedMs !== null && nowMs - heartbeatModifiedMs <= staleAfterMs) {
    return { state: 'running', exitCode: null };
  }
  return { state: 'interrupted', exitCode: null };
}

/** Launches a worker from the prompt and script already written into the worktree. */
export async function launchWorker(
  client: OrcaClient,
  input: { worktreeSelector: string; title: string; controlDir: string },
): Promise<OrcaTerminal> {
  return unwrapTerminal(
    await client.json([
      'terminal',
      'create',
      '--worktree',
      input.worktreeSelector,
      '--command',
      workerCommand(input.controlDir),
      '--title',
      input.title,
    ]),
  );
}
