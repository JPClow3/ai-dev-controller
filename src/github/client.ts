import { execa } from 'execa';

export class ForbiddenGitHubOperation extends Error {
  constructor(operation: string) {
    super(`Refused forbidden GitHub operation: ${operation}. You are the merge authority.`);
    this.name = 'ForbiddenGitHubOperation';
  }
}

export interface GhRunner {
  (args: string[]): Promise<string>;
}

/**
 * `gh` rather than a separate token.
 *
 * The CLI is already authenticated on this machine with repo + workflow
 * scopes, so this avoids a second credential to manage and keeps the
 * controller's GitHub identity identical to the operator's.
 */
export const realGh: GhRunner = async (args) => {
  const result = await execa('gh', args, { reject: true });
  return result.stdout;
};

export function createGitHub(gh: GhRunner = realGh) {
  async function api<T>(args: string[]): Promise<T> {
    const out = await gh(args);
    return JSON.parse(out || 'null') as T;
  }

  return {
    api,

    /** Raw stdout for gh commands whose contract is text rather than JSON. */
    text(args: string[]): Promise<string> {
      return gh(args);
    },

    /**
     * Refuses at the API boundary, so no code path can merge even by mistake.
     * Kept as a real method so the refusal is greppable.
     */
    mergePullRequest(): never {
      throw new ForbiddenGitHubOperation('pull request merge');
    },

    setBranchProtection(): never {
      throw new ForbiddenGitHubOperation('branch protection change');
    },
  };
}

export type GitHub = ReturnType<typeof createGitHub>;
