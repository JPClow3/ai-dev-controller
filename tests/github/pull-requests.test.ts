import { describe, expect, it, vi } from 'vitest';
import { createGitHub, ForbiddenGitHubOperation } from '../../src/github/client.js';
import {
  ensureDraftPullRequest,
  findPullRequestByBranch,
  listRecentlyMerged,
  issueIdFromBranch,
} from '../../src/github/pull-requests.js';
import { readChecks } from '../../src/github/checks.js';

const PR = {
  number: 192,
  url: 'https://github.com/o/r/pull/192',
  isDraft: true,
  headRefName: 'ai/UNI-142-thing',
  baseRefName: 'main',
  headRefOid: 'abc123',
  mergedAt: null,
  state: 'OPEN' as const,
};

/** Scripts `gh` responses by the subcommand being run. */
function fakeGh(handler: (args: string[]) => unknown) {
  const calls: string[][] = [];
  const gh = vi.fn(async (args: string[]) => {
    calls.push(args);
    return JSON.stringify(handler(args) ?? null);
  });
  return { calls, github: createGitHub(gh), gh };
}

describe('the controller is structurally incapable of merging', () => {
  it('throws on merge', () => {
    const { github } = fakeGh(() => null);
    expect(() => github.mergePullRequest()).toThrow(ForbiddenGitHubOperation);
    expect(() => github.mergePullRequest()).toThrow(/merge authority/);
  });

  it('throws on branch protection changes', () => {
    const { github } = fakeGh(() => null);
    expect(() => github.setBranchProtection()).toThrow(ForbiddenGitHubOperation);
  });
});

describe('draft PR creation is idempotent', () => {
  it('creates a draft PR when none exists', async () => {
    let created = false;
    const { calls, github } = fakeGh((args) => {
      if (args[1] === 'create') {
        created = true;
        return null;
      }
      return created ? [PR] : [];
    });

    const pr = await ensureDraftPullRequest(github, {
      slug: 'o/r',
      head: 'ai/UNI-142-thing',
      base: 'main',
      title: 't',
      body: 'b',
    });

    expect(pr.number).toBe(192);
    expect(calls.some((c) => c.includes('create') && c.includes('--draft'))).toBe(true);
  });

  /** A controller restart must never open a second PR for the same branch. */
  it('returns the existing PR instead of opening a second one', async () => {
    const { calls, github } = fakeGh((args) => (args[1] === 'list' ? [PR] : null));

    const pr = await ensureDraftPullRequest(github, {
      slug: 'o/r',
      head: 'ai/UNI-142-thing',
      base: 'main',
      title: 't',
      body: 'b',
    });

    expect(pr.number).toBe(192);
    expect(calls.some((c) => c[1] === 'create')).toBe(false);
  });

  it('always passes --draft; there is no ready-PR path', async () => {
    let created = false;
    const { calls, github } = fakeGh((args) => {
      if (args[1] === 'create') {
        created = true;
        return null;
      }
      return created ? [PR] : [];
    });
    await ensureDraftPullRequest(github, { slug: 'o/r', head: 'ai/x', base: 'main', title: 't', body: 'b' });
    const create = calls.find((c) => c[1] === 'create')!;
    expect(create).toContain('--draft');
  });

  it('survives losing a create race if a PR now exists', async () => {
    let attempts = 0;
    const gh = vi.fn(async (args: string[]) => {
      if (args[1] === 'create') {
        attempts += 1;
        throw new Error('a pull request already exists');
      }
      return JSON.stringify(attempts > 0 ? [PR] : []);
    });
    const github = createGitHub(gh);
    const pr = await ensureDraftPullRequest(github, {
      slug: 'o/r',
      head: 'ai/x',
      base: 'main',
      title: 't',
      body: 'b',
    });
    expect(pr.number).toBe(192);
  });

  it('returns null when a branch has no PR', async () => {
    const { github } = fakeGh(() => []);
    expect(await findPullRequestByBranch(github, 'o/r', 'ai/none')).toBeNull();
  });
});

describe('merge detection drives the dependency wave', () => {
  it('reports merged PRs', async () => {
    const { github } = fakeGh(() => [{ ...PR, state: 'MERGED', mergedAt: '2026-08-08T00:00:00Z' }]);
    const merged = await listRecentlyMerged(github, 'o/r');
    expect(merged[0]!.merged).toBe(true);
  });

  it('maps a controller branch back to its issue', () => {
    expect(issueIdFromBranch('ai/UNI-142-add-filtering', 'ai/')).toBe('UNI-142');
    expect(issueIdFromBranch('ai/HFS-7-x', 'ai/')).toBe('HFS-7');
  });

  it('ignores branches the controller did not create', () => {
    expect(issueIdFromBranch('feature/manual-work', 'ai/')).toBeNull();
    expect(issueIdFromBranch('ai/no-issue-here', 'ai/')).toBeNull();
  });
});

describe('checks', () => {
  const rollup = (states: Array<[string, string]>) => ({
    headRefOid: 'abc123',
    statusCheckRollup: states.map(([name, state]) => ({ name, state })),
  });

  it('passes only when every required check succeeded', async () => {
    const { github } = fakeGh(() => rollup([['test', 'SUCCESS'], ['build', 'SUCCESS']]));
    const summary = await readChecks(github, 'o/r', 192);
    expect(summary.allRequiredPassed).toBe(true);
    expect(summary.complete).toBe(true);
  });

  it('is not complete while a check is pending', async () => {
    const { github } = fakeGh(() => rollup([['test', 'IN_PROGRESS']]));
    const summary = await readChecks(github, 'o/r', 192);
    expect(summary.complete).toBe(false);
    expect(summary.allRequiredPassed).toBe(false);
    expect(summary.pending).toEqual(['test']);
  });

  it('reports failures by name', async () => {
    const { github } = fakeGh(() => rollup([['test', 'FAILURE'], ['build', 'SUCCESS']]));
    const summary = await readChecks(github, 'o/r', 192);
    expect(summary.failed).toEqual(['test']);
    expect(summary.allRequiredPassed).toBe(false);
  });

  /**
   * Zero checks usually means the workflow never triggered - the exact failure
   * PR_DRAFT_OPEN exists to prevent. Treating it as success would let unbuilt
   * code reach a PR marked green.
   */
  it('does not treat "no checks at all" as a pass', async () => {
    const { github } = fakeGh(() => ({ headRefOid: 'abc', statusCheckRollup: [] }));
    const summary = await readChecks(github, 'o/r', 192);
    expect(summary.allRequiredPassed).toBe(false);
  });

  it('honours an explicit required-checks list', async () => {
    const { github } = fakeGh(() => rollup([['test', 'SUCCESS'], ['optional-lint', 'FAILURE']]));
    const summary = await readChecks(github, 'o/r', 192, ['test']);
    expect(summary.allRequiredPassed).toBe(true);
    expect(summary.failed).toEqual([]);
  });

  it('treats neutral and skipped as passing', async () => {
    const { github } = fakeGh(() => rollup([['a', 'SKIPPED'], ['b', 'NEUTRAL']]));
    expect((await readChecks(github, 'o/r', 192)).allRequiredPassed).toBe(true);
  });
});
