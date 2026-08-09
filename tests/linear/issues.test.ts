import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLinearClient } from '../../src/linear/client.js';
import { updateIssueContract } from '../../src/linear/issues.js';

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
