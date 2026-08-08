import { describe, expect, it, vi } from 'vitest';
import {
  createOrcaClient,
  OrcaCommandError,
  OrcaNotRunningError,
  assertReady,
} from '../../src/orca/client.js';
import {
  createParentWorktree,
  createWorkerWorktree,
  findRepoBySlug,
  branchNameFor,
  hasExistingWork,
  type OrcaRepo,
} from '../../src/orca/worktrees.js';
import { waitForTerminal } from '../../src/orca/terminals.js';

function envelope(result: unknown, ok = true): string {
  return JSON.stringify({ id: 'test', ok, result, _meta: {} });
}

/** Captures the argv the adapter would have run. */
function fakeCli(stdout: string | ((args: string[]) => string)) {
  const calls: string[][] = [];
  const run = vi.fn(async (_bin: string, args: string[]) => {
    calls.push(args);
    return { stdout: typeof stdout === 'function' ? stdout(args) : stdout, stderr: '' };
  });
  return { calls, client: createOrcaClient({ run }), run };
}

describe('orca JSON discipline', () => {
  it('always passes --json, even when the caller forgets', async () => {
    const { calls, client } = fakeCli(envelope({ ok: true }));
    await client.json(['worktree', 'list']);
    expect(calls[0]).toContain('--json');
  });

  it('does not duplicate --json when already present', async () => {
    const { calls, client } = fakeCli(envelope({}));
    await client.json(['status', '--json']);
    expect(calls[0]!.filter((a) => a === '--json')).toHaveLength(1);
  });

  it('unwraps the result envelope', async () => {
    const { client } = fakeCli(envelope({ repos: [{ id: 'r1' }] }));
    await expect(client.json(['repo', 'list'])).resolves.toEqual({ repos: [{ id: 'r1' }] });
  });

  it('treats ok:false as a failure rather than returning empty data', async () => {
    const { client } = fakeCli(JSON.stringify({ id: 'x', ok: false, error: { message: 'no such repo' } }));
    await expect(client.json(['repo', 'show'])).rejects.toThrow(/no such repo/);
  });

  it('refuses to parse human-readable output', async () => {
    const { client } = fakeCli('Usage: orca <command> [options]');
    await expect(client.json(['status'])).rejects.toThrow(OrcaCommandError);
  });

  it('reports a missing CLI clearly instead of a raw ENOENT', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('spawn orca ENOENT'), { code: 'ENOENT' });
    });
    const client = createOrcaClient({ run });
    await expect(client.json(['status'])).rejects.toThrow(/Set ORCA_BIN or add it to PATH/);
  });

  it('recognises an unreachable runtime', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('fail'), { stderr: 'runtime not reachable', exitCode: 1 });
    });
    const client = createOrcaClient({ run });
    await expect(client.json(['status'])).rejects.toThrow(OrcaNotRunningError);
  });
});

describe('assertReady', () => {
  const ready = {
    app: { running: true },
    runtime: { state: 'ready', reachable: true, appVersion: '1.4.176', capabilities: [] },
    graph: { state: 'ready' },
  };

  it('passes when the runtime is ready', async () => {
    const { client } = fakeCli(envelope(ready));
    await expect(assertReady(client)).resolves.toBeUndefined();
  });

  it('fails fast when the app is not running', async () => {
    const { client } = fakeCli(envelope({ ...ready, app: { running: false } }));
    await expect(assertReady(client)).rejects.toThrow(OrcaNotRunningError);
  });

  it('fails fast when the runtime is still starting', async () => {
    const { client } = fakeCli(envelope({ ...ready, runtime: { ...ready.runtime, state: 'starting' } }));
    await expect(assertReady(client)).rejects.toThrow(OrcaNotRunningError);
  });
});

describe('worktree creation', () => {
  it('always pins the base branch explicitly', async () => {
    const { calls, client } = fakeCli(envelope({ id: 'wt1', path: 'H:/wt' }));
    await createParentWorktree(client, {
      repoSelector: 'name:Inova',
      name: 'ai/UNI-1-fix',
      baseBranch: 'master',
    });

    const args = calls[0]!;
    const idx = args.indexOf('--base-branch');
    expect(idx).toBeGreaterThan(-1);
    // Inova defaults to master; letting Orca guess would branch from a
    // non-existent `main`.
    expect(args[idx + 1]).toBe('master');
  });

  it('creates the parent with no lineage', async () => {
    const { calls, client } = fakeCli(envelope({ id: 'wt1', path: 'H:/wt' }));
    await createParentWorktree(client, {
      repoSelector: 'name:Lorebound',
      name: 'ai/UNI-2',
      baseBranch: 'main',
    });
    expect(calls[0]).toContain('--no-parent');
  });

  it('links the worktree to its Linear issue when given one', async () => {
    const { calls, client } = fakeCli(envelope({ id: 'wt1', path: 'H:/wt' }));
    await createParentWorktree(client, {
      repoSelector: 'name:Lorebound',
      name: 'ai/UNI-2',
      baseBranch: 'main',
      linearIssue: 'UNI-2',
    });
    expect(calls[0]).toContain('--linear-issue');
  });

  it('creates worker worktrees as children of the issue worktree', async () => {
    const { calls, client } = fakeCli(envelope({ id: 'wt2', path: 'H:/wt2' }));
    await createWorkerWorktree(client, {
      parentSelector: 'id:wt1',
      name: 'ai/UNI-2/api',
      agent: 'Ollama DeepSeek V4',
    });

    const args = calls[0]!;
    expect(args).toContain('--parent-worktree');
    expect(args[args.indexOf('--parent-worktree') + 1]).toBe('id:wt1');
    expect(args).toContain('--agent');
  });
});

describe('repo resolution and branch naming', () => {
  const repos: OrcaRepo[] = [
    {
      id: 'a',
      path: 'H:/Code/Pessoais/Lorebound',
      displayName: 'Lorebound',
      gitRemoteIdentity: { canonicalKey: 'github.com/JPClow3/Lorebound', remoteUrl: '' },
    },
    {
      id: 'b',
      path: 'H:/Code/Freelance/Inova',
      displayName: 'Inova',
      gitRemoteIdentity: { canonicalKey: 'github.com/JPClow3/Inova', remoteUrl: '' },
    },
  ];

  it('matches a repository by GitHub slug', () => {
    expect(findRepoBySlug(repos, 'JPClow3/Inova')?.id).toBe('b');
  });

  it('matches case-insensitively', () => {
    expect(findRepoBySlug(repos, 'jpclow3/lorebound')?.id).toBe('a');
  });

  it('returns null rather than guessing', () => {
    expect(findRepoBySlug(repos, 'JPClow3/Unknown')).toBeNull();
  });

  it('builds the ai/ branch name the design fixes', () => {
    expect(branchNameFor('ai/', 'UNI-142', 'Add filtering to risk map')).toBe(
      'ai/UNI-142-add-filtering-to-risk-map',
    );
  });

  it('keeps branch names git-safe and bounded', () => {
    const name = branchNameFor('ai/', 'UNI-1', 'Fix!! the *thing* — now?? '.repeat(5));
    expect(name).toMatch(/^ai\/UNI-1-[a-z0-9-]+$/);
    expect(name.endsWith('-')).toBe(false);
  });
});

describe('duplicate prevention', () => {
  it('treats any of the four sources as existing work', () => {
    const none = {
      controllerWorktreeId: null,
      orcaWorktree: null,
      gitBranchExists: false,
      openPullRequest: null,
    };
    expect(hasExistingWork(none)).toBe(false);
    expect(hasExistingWork({ ...none, controllerWorktreeId: 'x' })).toBe(true);
    expect(hasExistingWork({ ...none, orcaWorktree: { id: 'w', path: 'p' } })).toBe(true);
    expect(hasExistingWork({ ...none, gitBranchExists: true })).toBe(true);
    expect(hasExistingWork({ ...none, openPullRequest: 12 })).toBe(true);
  });
});

describe('waitForTerminal', () => {
  it('reports a settled agent', async () => {
    const { client } = fakeCli(envelope({ exitCode: 0 }));
    await expect(waitForTerminal(client, 'term_1', 'exit', 1000)).resolves.toEqual({
      settled: true,
      exitCode: 0,
      reason: 'exited',
    });
  });

  it('turns a hang into a classifiable timeout rather than occupying a slot forever', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('command timed out'), { timedOut: true, stderr: 'timed out' });
    });
    const client = createOrcaClient({ run });
    await expect(waitForTerminal(client, 'term_1', 'exit', 10)).resolves.toEqual({
      settled: false,
      exitCode: null,
      reason: 'timeout',
    });
  });
});
