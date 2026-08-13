import { describe, expect, it, vi } from 'vitest';
import {
  createGit,
  assertControllerBranch,
  assertNotBaseBranch,
  ForbiddenGitOperation,
} from '../../src/git/repository.js';
import { createIntegrator } from '../../src/git/integration.js';

function fakeGit(handler: (args: string[]) => string | Promise<string>) {
  const calls: string[][] = [];
  const runner = vi.fn(async (_cwd: string, args: string[]) => {
    calls.push(args);
    return handler(args);
  });
  return { calls, git: createGit(runner), runner };
}

function missingRefError(): Error & { exitCode: number } {
  return Object.assign(new Error('unknown revision'), { exitCode: 1 });
}

describe('patch presence', () => {
  it('detects whether a worker patch is already present on the parent', async () => {
    const { calls, git } = fakeGit((args) => args[0] === 'cherry' ? '- abc123' : '');

    await expect(git.patchPresent('C:/parent', 'abc123')).resolves.toBe(true);
    expect(calls).toContainEqual(['cherry', 'HEAD', 'abc123']);
  });
});

describe('push guard is an allow-list, not a deny-list', () => {
  it('accepts a properly prefixed controller branch', () => {
    expect(() => assertControllerBranch('ai/UNI-142-thing', 'ai/', 'main')).not.toThrow();
  });

  it('refuses the base branch', () => {
    expect(() => assertControllerBranch('main', 'ai/', 'main')).toThrow(ForbiddenGitOperation);
    expect(() => assertControllerBranch('master', 'ai/', 'master')).toThrow(ForbiddenGitOperation);
  });

  /**
   * The reason the guard is an allow-list: branch protection is unavailable on
   * six of the nine private repositories, and the controller authenticates as
   * the repository admin, who bypasses protection anyway. This check is in
   * practice the only barrier.
   */
  it('refuses any branch the controller did not create', () => {
    expect(() => assertControllerBranch('develop', 'ai/', 'main')).toThrow(/not a controller branch/);
    expect(() => assertControllerBranch('feature/manual', 'ai/', 'main')).toThrow(/not a controller branch/);
    expect(() => assertControllerBranch('', 'ai/', 'main')).toThrow(ForbiddenGitOperation);
  });

  it('refuses malformed branch names', () => {
    expect(() => assertControllerBranch('ai/../main', 'ai/', 'main')).toThrow(/malformed/);
    expect(() => assertControllerBranch('ai/has space', 'ai/', 'main')).toThrow(/malformed/);
    expect(() => assertControllerBranch('ai/trailing/', 'ai/', 'main')).toThrow(/malformed/);
  });

  it('still catches main even when the base branch is master', () => {
    expect(() => assertNotBaseBranch('main', 'master')).toThrow(ForbiddenGitOperation);
  });

  it('blocks the push at the API, not just in policy', async () => {
    const { git, runner } = fakeGit(() => '');
    await expect(git.pushBranch('/repo', 'main', 'main')).rejects.toThrow(ForbiddenGitOperation);
    expect(runner).not.toHaveBeenCalled();
  });

  it('pushes a fully qualified refspec so no config can redirect it', async () => {
    const { calls, git } = fakeGit(() => '');
    await git.pushBranch('/repo', 'ai/UNI-1-x', 'main');
    expect(calls[0]).toEqual([
      'push',
      '--set-upstream',
      'origin',
      'ai/UNI-1-x:refs/heads/ai/UNI-1-x',
    ]);
  });

  it('force-push is unreachable by construction', () => {
    const { git } = fakeGit(() => '');
    expect(() => git.forcePush()).toThrow(/force-push/);
  });
});

describe('fresh base', () => {
  it('fetches before resolving, so the base is genuinely current', async () => {
    const { calls, git } = fakeGit((args) => (args[0] === 'rev-parse' ? 'deadbeef' : ''));
    const sha = await git.fetchFreshBase('/repo', 'master');

    expect(calls[0]).toEqual(['fetch', 'origin', 'master', '--prune']);
    expect(calls[1]).toEqual(['rev-parse', 'origin/master']);
    expect(sha).toBe('deadbeef');
  });

  it('resolves the declared base branch, not a hardcoded main', async () => {
    const { calls, git } = fakeGit(() => 'sha');
    await git.fetchFreshBase('/repo', 'master');
    expect(calls[1]![1]).toBe('origin/master');
  });
});

describe('commit and diff parsing', () => {
  it('parses commits separated by the unit separator', async () => {
    const SEP = String.fromCharCode(31);
    const { git } = fakeGit(() => `abc${SEP}first commit\ndef${SEP}second: with, punctuation`);
    const commits = await git.commitsSince('/repo', 'base');
    expect(commits).toEqual([
      { sha: 'abc', message: 'first commit' },
      { sha: 'def', message: 'second: with, punctuation' },
    ]);
  });

  it('returns nothing when there are no commits', async () => {
    const { git } = fakeGit(() => '');
    expect(await git.commitsSince('/repo', 'base')).toEqual([]);
  });

  it('parses numstat into per-file line counts', async () => {
    const { git } = fakeGit(() => '10\t2\tsrc/a.ts\n0\t5\tsrc/b.ts');
    expect(await git.changedFiles('/repo', 'base')).toEqual([
      { path: 'src/a.ts', insertions: 10, deletions: 2 },
      { path: 'src/b.ts', insertions: 0, deletions: 5 },
    ]);
  });

  it('diffs the exact worker-attempt commit interval', async () => {
    const { calls, git } = fakeGit(() => '3\t1\tsrc/retry.ts');
    expect(await git.changedFilesBetween('/repo', 'attempt-base', 'attempt-head')).toEqual([
      { path: 'src/retry.ts', insertions: 3, deletions: 1 },
    ]);
    expect(calls[0]).toEqual(['diff', '--numstat', 'attempt-base..attempt-head']);
  });

  it('reports a branch as absent only after checking both local and remote', async () => {
    const tried: string[] = [];
    const runner = vi.fn(async (_cwd: string, args: string[]) => {
      tried.push(args.join(' '));
      throw missingRefError();
    });
    const git = createGit(runner);
    expect(await git.branchExists('/repo', 'ai/x')).toBe(false);
    expect(tried.some((t) => t.includes('refs/heads/ai/x'))).toBe(true);
    expect(tried.some((t) => t.includes('refs/remotes/origin/ai/x'))).toBe(true);
  });

  it('fails closed when branch lookup itself is unavailable', async () => {
    const git = createGit(vi.fn(async () => {
      throw new Error('git executable unavailable');
    }));

    await expect(git.branchExists('/repo', 'ai/x')).rejects.toThrow(/unavailable/);
    await expect(git.remoteBranchExists('/repo', 'ai/x')).rejects.toThrow(/unavailable/);
  });
});

describe('worker integration', () => {
  it('cherry-picks in dependency order', async () => {
    const { calls, git: _g } = fakeGit(() => 'HEAD_SHA');
    void _g;
    const runner = vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      return 'HEAD_SHA';
    });
    const integrator = createIntegrator(runner);

    const result = await integrator.integrate('/parent', [
      { taskKey: 'frontend', branch: 'b', order: 2, commits: ['c3'] },
      { taskKey: 'api', branch: 'a', order: 1, commits: ['c1', 'c2'] },
    ]);

    expect(result.integrated).toEqual(['c1', 'c2', 'c3']);
    const picks = calls.filter((c) => c[0] === 'cherry-pick' && c[1] === '-x').map((c) => c[2]);
    expect(picks).toEqual(['c1', 'c2', 'c3']);
  });

  it('skips a patch-equivalent worker commit that was already integrated before a restart', async () => {
    const runner = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === 'cherry') return `- ${args[2]}`;
      if (args[0] === 'rev-parse') return 'PARENT_HEAD';
      return '';
    });

    const result = await createIntegrator(runner).integrate('/parent', [
      { taskKey: 'api', branch: 'a', order: 1, commits: ['c1'] },
    ]);

    expect(result.conflicts).toEqual([]);
    expect(result.headSha).toBe('PARENT_HEAD');
    expect(runner).not.toHaveBeenCalledWith('/parent', ['cherry-pick', '-x', 'c1']);
  });

  /** Conflicts are resolved in the parent, never by letting workers edit each
   *  other's trees. The tree is left clean for the next attempt. */
  it('aborts a conflicted cherry-pick and reports the files', async () => {
    const runner = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === 'cherry-pick' && args[1] === '-x') throw new Error('conflict');
      if (args[0] === 'diff') return 'src/shared.ts';
      return 'HEAD';
    });
    const integrator = createIntegrator(runner);

    const result = await integrator.integrate('/parent', [
      { taskKey: 'api', branch: 'a', order: 1, commits: ['c1'] },
    ]);

    expect(result.conflicts).toEqual([{ taskKey: 'api', sha: 'c1', files: ['src/shared.ts'] }]);
    expect(runner.mock.calls.some(([, a]) => a[0] === 'cherry-pick' && a[1] === '--abort')).toBe(true);
  });

  it('stops that worker at its first conflict rather than piling up more', async () => {
    const attempted: string[] = [];
    const runner = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === 'cherry-pick' && args[1] === '-x') {
        attempted.push(args[2]!);
        throw new Error('conflict');
      }
      return '';
    });
    await createIntegrator(runner).integrate('/parent', [
      { taskKey: 'api', branch: 'a', order: 1, commits: ['c1', 'c2', 'c3'] },
    ]);
    expect(attempted).toEqual(['c1']);
  });
});
