import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLinearClient } from '../../src/linear/client.js';
import { listIssuesCreatedBetween, updateIssueContract } from '../../src/linear/issues.js';

beforeEach(() => setLinearClient(null));
afterEach(() => setLinearClient(null));

describe('curated Linear contract write-back', () => {
  it('updates both the title and description from the validated contract', async () => {
    const updateIssue = vi.fn(async () => ({ success: true }));
    setLinearClient({
      issue: vi.fn(async () => ({ id: 'issue-uuid' })),
      updateIssue,
    } as never);

    await updateIssueContract('JP-10', {
      title: 'Report an Ink shortfall',
      body: '# Goal\nReport the shortfall.',
    });

    expect(updateIssue).toHaveBeenCalledWith('issue-uuid', {
      title: 'Report an Ink shortfall',
      description: '# Goal\nReport the shortfall.',
    });
  });
});

describe('new Linear issue discovery', () => {
  it('uses a closed cursor window, drains pagination and skips completed issues', async () => {
    const live = {
      id: 'live-id',
      identifier: 'JP-20',
      title: 'New issue',
      description: 'Repository: Lorebound',
      url: 'https://linear.example/JP-20',
      createdAt: new Date('2026-08-11T12:30:00.000Z'),
      updatedAt: new Date('2026-08-11T12:31:00.000Z'),
      archivedAt: null,
      canceledAt: null,
      completedAt: null,
      labels: vi.fn(async () => ({ nodes: [{ name: 'Feature' }] })),
      project: Promise.resolve({ name: 'Lorebound' }),
    };
    const completed = { ...live, id: 'done-id', identifier: 'JP-19', completedAt: new Date() };
    const result = {
      nodes: [completed] as Array<typeof live | typeof completed>,
      pageInfo: { hasNextPage: true },
      async fetchNext() {
        this.nodes.push(live);
        this.pageInfo.hasNextPage = false;
        return this;
      },
    };
    const issues = vi.fn(async () => result);
    setLinearClient({ issues } as never);

    const found = await listIssuesCreatedBetween(
      '2026-08-11T12:00:00.000Z',
      '2026-08-11T13:00:00.000Z',
    );

    expect(issues).toHaveBeenCalledWith({
      filter: {
        createdAt: {
          gt: '2026-08-11T12:00:00.000Z',
          lte: '2026-08-11T13:00:00.000Z',
        },
      },
      first: 100,
    });
    expect(found).toEqual([
      expect.objectContaining({ identifier: 'JP-20', projectName: 'Lorebound', labels: ['Feature'] }),
    ]);
  });
});
