import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The dependency graph was inverted, and the inversion was invisible until a
 * live tick dispatched the dependent issue and held its prerequisite.
 *
 * Linear stores one relation row per pair, owned by the BLOCKING issue. For
 * "JP-8 blocks JP-9", the API answers:
 *
 *   JP-8  relations:        type=blocks  related=JP-9
 *   JP-9  inverseRelations: type=blocks  issue=JP-8
 *
 * So an issue's blockers come from `inverseRelations`. Reading `relations()`
 * collects what it blocks — the exact opposite — and the scheduler then ran
 * dependents first, which is the one thing wave scheduling exists to prevent.
 */

const issue = vi.fn();
vi.mock('../../src/linear/client.js', () => ({
  getLinearClient: () => ({ issue }),
}));

const { getIssueContract } = await import('../../src/linear/issues.js');
const { getExplicitBlockers } = await import('../../src/linear/dependencies.js');

/** The two sides of a single "JP-8 blocks JP-9" relation, as Linear reports them. */
function linearIssue(identifier: string, sides: { blocks?: string[]; blockedBy?: string[] }) {
  return {
    id: `uuid-${identifier}`,
    identifier,
    title: identifier,
    description: '',
    url: `https://linear.app/x/issue/${identifier}`,
    updatedAt: new Date('2026-08-08T00:00:00Z'),
    labels: async () => ({ nodes: [] }),
    project: Promise.resolve({ name: 'Lorebound' }),
    relations: async () => ({
      nodes: (sides.blocks ?? []).map((other) => ({
        type: 'blocks',
        relatedIssue: Promise.resolve({ identifier: other }),
      })),
    }),
    inverseRelations: async () => ({
      nodes: (sides.blockedBy ?? []).map((other) => ({
        type: 'blocks',
        issue: Promise.resolve({ identifier: other }),
      })),
    }),
  };
}

beforeEach(() => issue.mockReset());

describe('an issue is blocked by what points at it', () => {
  it('reports the blocker on the blocked side', async () => {
    issue.mockResolvedValue(linearIssue('JP-9', { blockedBy: ['JP-8'] }));
    const contract = await getIssueContract('JP-9');
    expect(contract.blockedBy).toEqual(['JP-8']);
  });

  it('reports no blocker on the blocking side', async () => {
    // The inversion made this the failing case: JP-8 blocks JP-9, and JP-8 was
    // recorded as blocked by JP-9.
    issue.mockResolvedValue(linearIssue('JP-8', { blocks: ['JP-9'] }));
    const contract = await getIssueContract('JP-8');
    expect(contract.blockedBy).toEqual([]);
  });

  it('collects every blocker when there are several', async () => {
    issue.mockResolvedValue(linearIssue('JP-9', { blockedBy: ['JP-8', 'JP-7'] }));
    const contract = await getIssueContract('JP-9');
    expect(contract.blockedBy).toEqual(['JP-8', 'JP-7']);
  });

  it('ignores relation kinds that are not blocks', async () => {
    issue.mockResolvedValue({
      ...linearIssue('JP-9', {}),
      inverseRelations: async () => ({
        nodes: [
          { type: 'related', issue: Promise.resolve({ identifier: 'JP-1' }) },
          { type: 'duplicate', issue: Promise.resolve({ identifier: 'JP-2' }) },
          { type: 'blocks', issue: Promise.resolve({ identifier: 'JP-8' }) },
        ],
      }),
    });
    const contract = await getIssueContract('JP-9');
    expect(contract.blockedBy).toEqual(['JP-8']);
  });

  it('carries the issue url through, so the pull request can link it', async () => {
    issue.mockResolvedValue(linearIssue('JP-8', {}));
    const contract = await getIssueContract('JP-8');
    expect(contract.url).toBe('https://linear.app/x/issue/JP-8');
  });

  it('uses inverse relations and drains every page in the standalone dependency reader', async () => {
    const connection = {
      nodes: [] as Array<{ type: string; issue: Promise<{ identifier: string }> }>,
      pageInfo: { hasNextPage: true },
      async fetchNext() {
        this.nodes.push({ type: 'blocks', issue: Promise.resolve({ identifier: 'JP-8' }) });
        this.pageInfo.hasNextPage = false;
      },
    };
    issue.mockResolvedValue({
      ...linearIssue('JP-9', {}),
      inverseRelations: vi.fn(async () => connection),
      relations: vi.fn(() => {
        throw new Error('forward relations must not be read');
      }),
    });

    await expect(getExplicitBlockers('JP-9')).resolves.toEqual([
      { issueIdentifier: 'JP-9', blockedByIdentifier: 'JP-8' },
    ]);
  });
});
