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

/** Where a worker's prompt and final message live inside its worktree. */
export const WORKER_PROMPT_FILE = '.ai-worker-prompt.txt';
export const WORKER_RESULT_FILE = '.ai-worker-result.txt';

/**
 * The command that runs a worker inside its worktree.
 *
 * Uses `codex exec` directly rather than a registered Orca custom agent.
 * Custom agents can only be added through the desktop GUI, which would make
 * the whole pipeline un-runnable from a script; a plain command has no such
 * dependency. The prompt is redirected from a file because it exceeds the
 * Windows command-line limit.
 */
export function workerCommand(profile: string): string {
  return [
    'codex exec',
    `--profile ${profile}`,
    '--sandbox workspace-write',
    '--skip-git-repo-check',
    `--output-last-message ${WORKER_RESULT_FILE}`,
    `- < ${WORKER_PROMPT_FILE}`,
  ].join(' ');
}

/** Launches a worker from a prompt file already written into the worktree. */
export async function launchWorker(
  client: OrcaClient,
  input: { worktreeSelector: string; profile: string; title: string },
): Promise<OrcaTerminal> {
  return client.json<OrcaTerminal>([
    'terminal',
    'create',
    '--worktree',
    input.worktreeSelector,
    '--command',
    workerCommand(input.profile),
    '--title',
    input.title,
  ]);
}
