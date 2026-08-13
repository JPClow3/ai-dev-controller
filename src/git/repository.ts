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

export function isMissingRef(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'exitCode' in error && error.exitCode === 1;
}

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
  if (!prefix || !hasControllerPrefix(branch, prefix)) {
    throw new ForbiddenGitOperation(
      `push to "${branch}", which is not a controller branch (expected segment "${prefix}")`,
    );
  }
  if (branch.includes('..') || branch.includes(' ') || branch.endsWith('/')) {
    throw new ForbiddenGitOperation(`push to malformed branch name "${branch}"`);
  }
}

/**
 * Whether a branch carries the controller's prefix as a segment.
 *
 * Not `startsWith`, because the controller does not get to name its branches.
 * Asking Orca for `ai/JP-9-work` yields `JPClow3/ai-JP-9-work`: it namespaces
 * under the GitHub owner AND flattens the separator, and offers no flag to
 * override either. An anchored `ai/` test rejected every branch the system
 * actually produces.
 *
 * So the stem is matched at a segment boundary with either separator after
 * it. That still rejects `JPClow3/hotfix` and `feature/ai-thing`, which is the
 * property this guard exists for.
 */
export function hasControllerPrefix(branch: string, prefix: string): boolean {
  if (!prefix) return false;
  // Branches the controller creates itself — the knowledge bootstrap — keep
  // the prefix exactly where it was put.
  if (branch.startsWith(prefix)) return true;
  // Branches Orca creates from our requested name are identified by the
  // issue id that follows the prefix. Matching the prefix alone is too weak:
  // `feature/ai-thing` would pass, and that is not our branch.
  return controllerBranchIssueId(branch, prefix) !== null;
}

/**
 * The issue a controller branch belongs to, or null if it is not one.
 *
 * The controller only ever asks for `<prefix><ISSUE-ID>-<slug>`, so the issue
 * id immediately after the prefix is what identifies the branch as ours —
 * through whatever renaming Orca applies on the way.
 */
export function controllerBranchIssueId(branch: string, prefix: string): string | null {
  const stem = prefix.replace(/[/-]+$/, '');
  if (!stem) return null;
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|/)${escaped}[/-]([A-Z][A-Z0-9]*-\\d+)`).exec(branch);
  return match?.[1] ?? null;
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

    /**
     * Pins a newly-created controller worktree to the exact fetched base.
     *
     * Orca's `--base-branch main` resolves the local branch, which may lag
     * `origin/main` even after fetch. A fast-forward merge preserves the
     * controller branch and refuses divergence instead of rewriting history.
     */
    async fastForwardTo(repoPath: string, sha: string): Promise<void> {
      await git(repoPath, ['merge', '--ff-only', sha]);
      const head = await git(repoPath, ['rev-parse', 'HEAD']);
      if (head !== sha) {
        throw new Error(`worktree HEAD ${head} does not match fetched base ${sha}`);
      }
    },

    async currentBranch(repoPath: string): Promise<string> {
      return git(repoPath, ['symbolic-ref', '--short', 'HEAD']);
    },

    async branchExists(repoPath: string, branch: string): Promise<boolean> {
      try {
        await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
        return true;
      } catch (error) {
        if (!isMissingRef(error)) throw error;
        try {
          await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
          return true;
        } catch (remoteError) {
          if (!isMissingRef(remoteError)) throw remoteError;
          return false;
        }
      }
    },

    /**
     * Checks the remote directly instead of trusting a possibly stale
     * `refs/remotes/origin/*` left behind before the controller restarted.
     */
    async remoteBranchExists(repoPath: string, branch: string): Promise<boolean> {
      const out = await git(repoPath, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
      return out.trim().length > 0;
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

    /** True when HEAD already contains an exact or patch-equivalent commit. */
    async patchPresent(repoPath: string, sha: string): Promise<boolean> {
      try {
        const state = await git(repoPath, ['cherry', 'HEAD', sha]);
        return state.trimStart().startsWith('-');
      } catch {
        return false;
      }
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

    /** Exact two-ref diff used to attribute churn to one worker attempt. */
    async changedFilesBetween(
      repoPath: string,
      baseSha: string,
      headSha: string,
    ): Promise<Array<{ path: string; insertions: number; deletions: number }>> {
      const out = await git(repoPath, ['diff', '--numstat', `${baseSha}..${headSha}`]);
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
