import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { setLinearClient } from '../../src/linear/client.js';
import {
  setAiLifecycleLabel,
  assertLabelWritable,
  ForbiddenLabelWrite,
  CONTROLLER_WRITABLE_LABELS,
} from '../../src/linear/labels.js';
import { AI_LIFECYCLE_LABELS } from '../../src/workflow/states.js';

/**
 * A fake Linear client.
 *
 * `setAiLifecycleLabel` does a read-modify-write on an issue's label set, so a
 * bug there silently strips the user's own Bug/Feature labels. These tests
 * exist to prove it does not.
 */
function fakeLinear(issueLabels: string[]) {
  const workspaceLabels = [...AI_LIFECYCLE_LABELS, 'Bug', 'Feature', 'Improvement'].map((name, i) => ({
    id: `label-${i}`,
    name,
  }));

  const updateIssue = vi.fn(async () => ({ success: true }));

  const client = {
    issue: vi.fn(async () => ({
      id: 'issue-uuid',
      labels: async () => ({
        nodes: issueLabels.map((name) => workspaceLabels.find((l) => l.name === name)!),
      }),
    })),
    issueLabels: vi.fn(async () => ({ nodes: workspaceLabels })),
    updateIssue,
  };

  setLinearClient(client as never);
  return { updateIssue, workspaceLabels, nameOf: (id: string) => workspaceLabels.find((l) => l.id === id)?.name };
}

beforeEach(() => setLinearClient(null));
afterEach(() => setLinearClient(null));

describe('ai-ready is a human input', () => {
  it('is excluded from the controller-writable set', () => {
    expect(CONTROLLER_WRITABLE_LABELS).not.toContain('ai-ready');
    expect(CONTROLLER_WRITABLE_LABELS).toContain('ai-running');
  });

  it('refuses to be applied by the controller', () => {
    expect(() => assertLabelWritable('ai-ready')).toThrow(ForbiddenLabelWrite);
  });

  it('cannot be written even through the normal call path', async () => {
    fakeLinear(['ai-curate']);
    await expect(setAiLifecycleLabel('UNI-1', 'ai-ready')).rejects.toThrow(ForbiddenLabelWrite);
  });

  it('allows every other lifecycle label', () => {
    for (const label of AI_LIFECYCLE_LABELS) {
      if (label === 'ai-ready') continue;
      expect(() => assertLabelWritable(label)).not.toThrow();
    }
  });
});

describe('lifecycle label write preserves everything it does not own', () => {
  it('keeps the user own labels', async () => {
    const { updateIssue, nameOf } = fakeLinear(['ai-curate', 'Bug', 'Improvement']);
    await setAiLifecycleLabel('UNI-1', 'ai-running');

    const [, payload] = updateIssue.mock.calls[0] as unknown as [string, { labelIds: string[] }];
    const names = payload.labelIds.map(nameOf).sort();
    expect(names).toEqual(['Bug', 'Improvement', 'ai-running']);
  });

  it('replaces the previous lifecycle label rather than accumulating', async () => {
    const { updateIssue, nameOf } = fakeLinear(['ai-curate']);
    await setAiLifecycleLabel('UNI-1', 'ai-reviewing');

    const [, payload] = updateIssue.mock.calls[0] as unknown as [string, { labelIds: string[] }];
    const names = payload.labelIds.map(nameOf);
    expect(names).toEqual(['ai-reviewing']);
    expect(names).not.toContain('ai-curate');
  });

  it('does not strip a human ai-ready when moving to ai-running', async () => {
    // The human applied ai-ready; the controller then marks it running. Both
    // are lifecycle labels, so ai-ready is legitimately replaced - but the
    // user's other labels must survive.
    const { updateIssue, nameOf } = fakeLinear(['ai-ready', 'Feature']);
    await setAiLifecycleLabel('UNI-1', 'ai-running');

    const names = (updateIssue.mock.calls[0] as unknown as [string, { labelIds: string[] }])[1].labelIds
      .map(nameOf)
      .sort();
    expect(names).toEqual(['Feature', 'ai-running']);
  });

  it('works on an issue that has no labels at all', async () => {
    const { updateIssue, nameOf } = fakeLinear([]);
    await setAiLifecycleLabel('UNI-1', 'ai-curate');
    const names = (updateIssue.mock.calls[0] as unknown as [string, { labelIds: string[] }])[1].labelIds.map(nameOf);
    expect(names).toEqual(['ai-curate']);
  });

  it('fails loudly when the workspace is missing the label', async () => {
    const workspaceLabels = [{ id: 'l1', name: 'Bug' }];
    setLinearClient({
      issue: vi.fn(async () => ({ id: 'x', labels: async () => ({ nodes: [] }) })),
      issueLabels: vi.fn(async () => ({ nodes: workspaceLabels })),
      updateIssue: vi.fn(),
    } as never);

    await expect(setAiLifecycleLabel('UNI-1', 'ai-running')).rejects.toThrow(/does not exist in this workspace/);
  });
});
