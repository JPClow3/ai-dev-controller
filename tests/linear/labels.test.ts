import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { setLinearClient } from '../../src/linear/client.js';
import {
  setAiLifecycleLabel,
  clearAiLifecycleLabels,
  assertLabelWritable,
  CONTROLLER_WRITABLE_LABELS,
  assertLifecycleLabelsExist,
} from '../../src/linear/labels.js';
import { AI_LIFECYCLE_LABELS } from '../../src/workflow/states.js';

/**
 * A fake Linear client.
 *
 * Label changes use Linear's atomic add/remove mutations, so concurrent user
 * edits to Bug/Feature labels cannot be overwritten by the controller.
 */
function fakeLinear(issueLabels: string[]) {
  const workspaceLabels = [...AI_LIFECYCLE_LABELS, 'Bug', 'Feature', 'Improvement'].map((name, i) => ({
    id: `label-${i}`,
    name,
  }));

  const issueAddLabel = vi.fn(async () => ({ success: true }));
  const issueRemoveLabel = vi.fn(async () => ({ success: true }));

  const client = {
    issue: vi.fn(async () => ({
      id: 'issue-uuid',
      labels: async () => ({
        nodes: issueLabels.map((name) => workspaceLabels.find((l) => l.name === name)!),
      }),
    })),
    issueLabels: vi.fn(async () => ({ nodes: workspaceLabels })),
    issueAddLabel,
    issueRemoveLabel,
  };

  setLinearClient(client as never);
  return { issueAddLabel, issueRemoveLabel, workspaceLabels };
}

beforeEach(() => setLinearClient(null));
afterEach(() => setLinearClient(null));

describe('controller-owned autonomous lifecycle', () => {
  it('includes ai-ready in the controller-writable set', () => {
    expect(CONTROLLER_WRITABLE_LABELS).toContain('ai-ready');
    expect(CONTROLLER_WRITABLE_LABELS).toEqual(AI_LIFECYCLE_LABELS);
  });

  it('allows ai-ready to be applied by the controller', () => {
    expect(() => assertLabelWritable('ai-ready')).not.toThrow();
  });

  it('promotes ai-curate to ai-ready through the normal call path', async () => {
    const { issueAddLabel, issueRemoveLabel, workspaceLabels } = fakeLinear(['ai-curate']);
    await setAiLifecycleLabel('UNI-1', 'ai-ready');
    expect(issueAddLabel).toHaveBeenCalledWith(
      'issue-uuid',
      workspaceLabels.find((label) => label.name === 'ai-ready')!.id,
    );
    expect(issueRemoveLabel).toHaveBeenCalledWith(
      'issue-uuid',
      workspaceLabels.find((label) => label.name === 'ai-curate')!.id,
    );
  });

  it('allows every lifecycle label', () => {
    for (const label of AI_LIFECYCLE_LABELS) {
      expect(() => assertLabelWritable(label)).not.toThrow();
    }
  });
});

describe('lifecycle label write preserves everything it does not own', () => {
  it('keeps the user own labels', async () => {
    const { issueAddLabel, issueRemoveLabel, workspaceLabels } = fakeLinear([
      'ai-curate',
      'Bug',
      'Improvement',
    ]);
    await setAiLifecycleLabel('UNI-1', 'ai-running');

    expect(issueAddLabel).toHaveBeenCalledTimes(1);
    expect(issueRemoveLabel).toHaveBeenCalledTimes(1);
    expect(issueRemoveLabel).toHaveBeenCalledWith(
      'issue-uuid',
      workspaceLabels.find((label) => label.name === 'ai-curate')!.id,
    );
  });

  it('replaces the previous lifecycle label rather than accumulating', async () => {
    const { issueRemoveLabel, workspaceLabels } = fakeLinear(['ai-curate']);
    await setAiLifecycleLabel('UNI-1', 'ai-reviewing');

    expect(issueRemoveLabel).toHaveBeenCalledWith(
      'issue-uuid',
      workspaceLabels.find((label) => label.name === 'ai-curate')!.id,
    );
  });

  it('replaces ai-ready with ai-running while preserving user labels', async () => {
    const { issueAddLabel, issueRemoveLabel } = fakeLinear(['ai-ready', 'Feature']);
    await setAiLifecycleLabel('UNI-1', 'ai-running');

    expect(issueAddLabel).toHaveBeenCalledTimes(1);
    expect(issueRemoveLabel).toHaveBeenCalledTimes(1);
  });

  it('works on an issue that has no labels at all', async () => {
    const { issueAddLabel, issueRemoveLabel } = fakeLinear([]);
    await setAiLifecycleLabel('UNI-1', 'ai-curate');
    expect(issueAddLabel).toHaveBeenCalledTimes(1);
    expect(issueRemoveLabel).not.toHaveBeenCalled();
  });

  it('fails loudly when the workspace is missing the label', async () => {
    const workspaceLabels = [{ id: 'l1', name: 'Bug' }];
    setLinearClient({
      issue: vi.fn(async () => ({ id: 'x', labels: async () => ({ nodes: [] }) })),
      issueLabels: vi.fn(async () => ({ nodes: workspaceLabels })),
      issueAddLabel: vi.fn(),
      issueRemoveLabel: vi.fn(),
    } as never);

    await expect(setAiLifecycleLabel('UNI-1', 'ai-running')).rejects.toThrow(/does not exist in this workspace/);
  });

  it('clears lifecycle state after merge while preserving user labels', async () => {
    const { issueAddLabel, issueRemoveLabel, workspaceLabels } = fakeLinear([
      'ai-pr-open',
      'Feature',
    ]);
    await clearAiLifecycleLabels('UNI-1');

    expect(issueAddLabel).not.toHaveBeenCalled();
    expect(issueRemoveLabel).toHaveBeenCalledTimes(1);
    expect(issueRemoveLabel).toHaveBeenCalledWith(
      'issue-uuid',
      workspaceLabels.find((label) => label.name === 'ai-pr-open')!.id,
    );
  });
});

describe('startup lifecycle-label contract', () => {
  it('passes when every configured lifecycle label exists', async () => {
    fakeLinear([]);
    await expect(assertLifecycleLabelsExist()).resolves.toBeUndefined();
  });

  it('fails before polling when workspace labels are missing', async () => {
    setLinearClient({
      issueLabels: vi.fn(async () => ({ nodes: [{ id: 'l1', name: 'ai-ready' }] })),
    } as never);

    await expect(assertLifecycleLabelsExist()).rejects.toThrow(/ai-curated/);
  });

  it('finds required workspace labels beyond the first page', async () => {
    const labels = AI_LIFECYCLE_LABELS.map((name, index) => ({ id: `label-${index}`, name }));
    const connection = {
      nodes: labels.slice(0, 1),
      pageInfo: { hasNextPage: true },
      async fetchNext() {
        this.nodes.push(...labels.slice(1));
        this.pageInfo.hasNextPage = false;
      },
    };
    setLinearClient({ issueLabels: vi.fn(async () => connection) } as never);

    await expect(assertLifecycleLabelsExist()).resolves.toBeUndefined();
  });
});
