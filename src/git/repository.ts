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

    /** Pushes an ai/* branch. Refuses anything resembling a base branch. */
    async pushBranch(repoPath: string, branch: string, baseBranch: string): Promise<void> {
      assertNotBaseBranch(branch, baseBranch);
      await git(repoPath, ['push', '--set-upstream', 'origin', branch]);
    },

    /** Present so the boundary is explicit and greppable. */
    forcePush(): never {
      throw new ForbiddenGitOperation('force-push');
    },
  };
}

export type Git = ReturnType<typeof createGit>;
