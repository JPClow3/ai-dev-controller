import { describe, expect, it, vi } from 'vitest';
import { createOrcaClient } from '../../src/orca/client.js';
import {
  createParentWorktree,
  createWorkerWorktree,
  unwrapWorktree,
  branchNameFor,
} from '../../src/orca/worktrees.js';
import { launchWorker, unwrapTerminal, workerCommand } from '../../src/orca/terminals.js';

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
      profile: 'gpt-luna-high',
      title: 'JP-7/api',
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
    const cmd = workerCommand('gpt-luna-high');
    expect(cmd).toContain('codex exec');
    expect(cmd).toContain('--profile gpt-luna-high');
    expect(cmd).toContain('--sandbox workspace-write');
  });

  it('reads the prompt from a file, not argv', () => {
    // The prompt plus schema exceeds the Windows command-line limit.
    expect(workerCommand('x')).toMatch(/- < \.ai-worker-prompt\.txt/);
  });

  it('captures only the final message', () => {
    expect(workerCommand('x')).toContain('--output-last-message .ai-worker-result.txt');
  });

  it('never passes --agent', async () => {
    const { calls, client } = fakeCli({ worktree: { id: 'w', path: 'p' } });
    await createParentWorktree(client, { repoSelector: 'id:r', name: 'ai/x', baseBranch: 'main' });
    expect(calls[0]).not.toContain('--agent');
  });
});

describe('branch naming', () => {
  it('is git-safe for a realistic issue title', () => {
    const name = branchNameFor('ai/', 'JP-7', 'Add unit tests for the GitHub activity fallback path');
    expect(name).toMatch(/^ai\/JP-7-[a-z0-9-]+$/);
  });

  it('survives punctuation and unicode without producing an invalid ref', () => {
    for (const title of ['Fix: the *thing* — now?!', 'ação e configuração', '///', '   ']) {
      const name = branchNameFor('ai/', 'JP-9', title);
      expect(name.startsWith('ai/JP-9')).toBe(true);
      expect(name).not.toContain('//');
      expect(name).not.toMatch(/[ *?~^:[\]\\]/);
      expect(name.endsWith('-')).toBe(false);
    }
  });
});
