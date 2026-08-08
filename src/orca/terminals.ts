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
export function workerScript(profile: string, controlDir: string, setupCommand?: string): string {
  const q = (name: string) => `'${join(controlDir, name).replace(/'/g, "''")}'`;

  // The repository's own preparation, run before the agent rather than by it.
  // A fresh worktree has no dependencies, and the first live worker said so
  // itself: "node_modules is absent, so the focused script cannot find Vitest
  // (and installing dependencies would modify paths outside my ownership)".
  // It was right on both counts — which is why the controller does it.
  const setup = setupCommand
    ? [`Write-Host "ai-dev worker: ${setupCommand}"`, setupCommand, '']
    : [];

  const codex = [
    'codex exec',
    `--profile ${profile}`,
    '--sandbox workspace-write',
    '--skip-git-repo-check',
    `--output-last-message ${q(WORKER_RESULT_FILE)}`,
    '-',
  ].join(' ');

  return [
    '$ErrorActionPreference = "Continue"',
    ...setup,
    `Get-Content -Raw ${q(WORKER_PROMPT_FILE)} | ${codex}`,
    '$code = $LASTEXITCODE',
    'if ($null -eq $code) { $code = 0 }',
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
