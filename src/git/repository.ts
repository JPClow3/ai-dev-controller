import { execa } from 'execa';

export class ForbiddenGitOperation extends Error {
  constructor(operation: string) {
    super(`Refused forbidden git operation: ${operation}`);
    this.name = 'ForbiddenGitOperation';
  }
}

export interface GitRunner {
  (cwd: string, args: string[]): Promise<string>;
}

export const realGit: GitRunner = async (cwd, args) => {
  const result = await execa('git', args, { cwd, reject: true });
  return result.stdout.trim();
};

/**
 * ASCII unit separator. A commit subject can contain almost anything except a
 * control character, which makes it a safe field delimiter for `git log`.
 */
const SEP = String.fromCharCode(31);

/**
 * Branches the controller must never push to directly.
 *
 * This sits alongside GitHub branch protection rather than trusting it: the
 * controller should be incapable of pushing to a base branch even if
 * protection is misconfigured.
 */
export function assertNotBaseBranch(branch: string, baseBranch: string): void {
  if (branch === baseBranch || branch === 'main' || branch === 'master') {
    throw new ForbiddenGitOperation(`push to protected branch "${branch}"`);
  }
}

/**
 * Allow-list rather than deny-list: the branch must be one the controller
 * created.
 *
 * This carries more weight than it looks. GitHub branch protection cannot be
 * relied on here — six of the nine repositories are private on a free plan
 * (protection unavailable), and the controller authenticates as the repository
 * admin, who bypasses protection anyway. So this guard is in practice the only
 * barrier, and "not the base branch" is too weak a test: a typo producing an
 * empty or unexpected branch name would sail through it.
 */
export function assertControllerBranch(branch: string, prefix: string, baseBranch: string): void {
  assertNotBaseBranch(branch, baseBranch);
  if (!prefix || !branch.startsWith(prefix)) {
    throw new ForbiddenGitOperation(
      `push to "${branch}", which is not a controller branch (expected prefix "${prefix}")`,
    );
  }
  if (branch.includes('..') || branch.includes(' ') || branch.endsWith('/')) {
    throw new ForbiddenGitOperation(`push to malformed branch name "${branch}"`);
  }
}

export function createGit(git: GitRunner = realGit) {
  return {
    /**
     * Fetches and resolves the newest base commit.
     *
     * Every issue branches from this at the moment it becomes eligible — the
     * fix for wave 2 building against yesterday's assumptions.
     */
    async fetchFreshBase(repoPath: string, baseBranch: string): Promise<string> {
      await git(repoPath, ['fetch', 'origin', baseBranch, '--prune']);
      return git(repoPath, ['rev-parse', `origin/${baseBranch}`]);
    },

    async currentBranch(repoPath: string): Promise<string> {
      return git(repoPath, ['symbolic-ref', '--short', 'HEAD']);
    },

    async branchExists(repoPath: string, branch: string): Promise<boolean> {
      try {
        await git(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}`]);
        return true;
      } catch {
        try {
          await git(repoPath, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`]);
          return true;
        } catch {
          return false;
        }
      }
    },

    async headSha(repoPath: string): Promise<string> {
      return git(repoPath, ['rev-parse', 'HEAD']);
    },

    async commitsSince(repoPath: string, baseSha: string): Promise<Array<{ sha: string; message: string }>> {
      const out = await git(repoPath, ['log', '--format=%H%x1f%s', `${baseSha}..HEAD`]);
      if (!out) return [];
      return out.split('\n').map((line) => {
        const [sha, message] = line.split(SEP);
        return { sha: sha ?? '', message: message ?? '' };
      });
    },

    async diffAgainst(repoPath: string, baseSha: string): Promise<string> {
      return git(repoPath, ['diff', `${baseSha}...HEAD`]);
    },

    async changedFiles(
      repoPath: string,
      baseSha: string,
    ): Promise<Array<{ path: string; insertions: number; deletions: number }>> {
      const out = await git(repoPath, ['diff', '--numstat', `${baseSha}...HEAD`]);
      if (!out) return [];
      return out.split('\n').map((line) => {
        const [ins, del, path] = line.split('\t');
        return {
          path: path ?? '',
          insertions: Number.parseInt(ins ?? '0', 10) || 0,
          deletions: Number.parseInt(del ?? '0', 10) || 0,
        };
      });
    },

    /**
     * Pushes a controller branch.
     *
     * The refspec is fully qualified (`branch:refs/heads/branch`) so no local
     * refspec configuration or ambiguous ref can redirect the push somewhere
     * else.
     */
    async pushBranch(
      repoPath: string,
      branch: string,
      baseBranch: string,
      prefix = 'ai/',
    ): Promise<void> {
      assertControllerBranch(branch, prefix, baseBranch);
      await git(repoPath, ['push', '--set-upstream', 'origin', `${branch}:refs/heads/${branch}`]);
    },

    /** Present so the boundary is explicit and greppable. */
    forcePush(): never {
      throw new ForbiddenGitOperation('force-push');
    },
  };
}

export type Git = ReturnType<typeof createGit>;
