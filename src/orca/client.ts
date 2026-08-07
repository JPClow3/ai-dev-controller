import { NotImplementedError } from '../util/errors.js';

/**
 * Orca is the execution boundary. The controller tells Orca WHAT is allowed to
 * run, with which task and routing choice; Orca owns worktrees, agent sessions,
 * terminals, diffs and the shipping lifecycle.
 *
 * This adapter shells out to the Orca CLI with JSON output. It must never
 * screen-scrape a UI - recovery depends on machine-readable status.
 */

export interface OrcaWorktree {
  id: string;
  repository: string;
  branch: string;
  path: string;
  parentId: string | null;
  status: string;
}

export interface OrcaAgentSession {
  id: string;
  worktreeId: string;
  status: 'running' | 'stopped' | 'failed' | 'completed';
  agent: string;
  startedAt: string;
}

export function bin(): string {
  return process.env['ORCA_BIN'] ?? 'orca';
}

export async function json<T>(_args: string[]): Promise<T> {
  throw new NotImplementedError('orca.json');
}

export async function listWorktrees(_repository?: string): Promise<OrcaWorktree[]> {
  throw new NotImplementedError('orca.listWorktrees');
}

/** The issue's parent worktree, branched from a freshly fetched base. */
export async function createWorktree(_opts: {
  repository: string;
  branch: string;
  baseBranch: string;
}): Promise<OrcaWorktree> {
  throw new NotImplementedError('orca.createWorktree');
}

/**
 * Child worktrees give each worker filesystem isolation, so workers never
 * modify each other's environment. Integration happens in the parent.
 */
export async function createChildWorktree(_opts: {
  parentId: string;
  branch: string;
}): Promise<OrcaWorktree> {
  throw new NotImplementedError('orca.createChildWorktree');
}

/**
 * Launch a worker. `worker` carries model + effort + harness, so Codex-backed
 * Luna/Terra/Sol and Ollama-backed GLM/Kimi/DeepSeek go through the same path.
 */
export async function launchAgent(_opts: {
  worktreeId: string;
  worker: { provider: string; model: string; effort?: string; harness: string };
  prompt: string;
  contextPacket: string[];
}): Promise<OrcaAgentSession> {
  throw new NotImplementedError('orca.launchAgent');
}

export async function agentStatus(_sessionId: string): Promise<OrcaAgentSession> {
  throw new NotImplementedError('orca.agentStatus');
}

export async function collectDiff(_worktreeId: string): Promise<string> {
  throw new NotImplementedError('orca.collectDiff');
}

/** Integration: cherry-pick each worker's commits into the parent branch. */
export async function integrateChild(_opts: {
  parentId: string;
  childId: string;
}): Promise<{ conflicts: string[] }> {
  throw new NotImplementedError('orca.integrateChild');
}

export async function usageReport(): Promise<Record<string, unknown>> {
  throw new NotImplementedError('orca.usageReport');
}
