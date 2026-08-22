import type { AiLifecycleLabel } from '../domain/workflow.js';
import { AI_LIFECYCLE_LABELS } from '../domain/workflow.js';
import { getLinearClient } from './client.js';
import { drainConnection } from './pagination.js';

/** The controller owns the complete ai-* lifecycle through draft PR creation. */
export const CONTROLLER_WRITABLE_LABELS: readonly AiLifecycleLabel[] = AI_LIFECYCLE_LABELS;

export function assertLabelWritable(label: AiLifecycleLabel): void {
  if (!CONTROLLER_WRITABLE_LABELS.includes(label)) {
    throw new Error(`The controller does not own lifecycle label "${label}".`);
  }
}

/** Fails startup before curation can persist only half of its Linear write. */
export async function assertLifecycleLabelsExist(): Promise<void> {
  const labels = await getLinearClient().issueLabels({ first: 100 });
  await drainConnection(labels);
  const present = new Set(labels.nodes.map((label) => label.name));
  const missing = AI_LIFECYCLE_LABELS.filter((label) => !present.has(label));
  if (missing.length > 0) {
    throw new Error(`Linear workspace is missing required lifecycle label(s): ${missing.join(', ')}`);
  }
}

/**
 * Sets exactly one lifecycle label, removing the others with atomic label
 * mutations instead of replacing the issue's complete label set.
 *
 * Non-lifecycle labels (Bug, Feature, repo:*) are preserved — the controller
 * owns the ai-* namespace and nothing else.
 */
export async function setAiLifecycleLabel(issueId: string, label: AiLifecycleLabel): Promise<void> {
  assertLabelWritable(label);

  const client = getLinearClient();
  const issue = await client.issue(issueId);
  const [existing, all] = await Promise.all([
    issue.labels({ first: 100 }),
    client.issueLabels({ first: 100 }),
  ]);
  await Promise.all([drainConnection(existing), drainConnection(all)]);

  const lifecycle = new Set<string>(AI_LIFECYCLE_LABELS);
  const target = all.nodes.find((l) => l.name === label);
  if (!target) throw new Error(`Linear label "${label}" does not exist in this workspace`);

  if (!existing.nodes.some((existingLabel) => existingLabel.id === target.id)) {
    await client.issueAddLabel(issue.id, target.id);
  }
  for (const existingLabel of existing.nodes) {
    if (lifecycle.has(existingLabel.name) && existingLabel.id !== target.id) {
      await client.issueRemoveLabel(issue.id, existingLabel.id);
    }
  }
}

/** Clears controller lifecycle state after a human merge. */
export async function clearAiLifecycleLabels(issueId: string): Promise<void> {
  const client = getLinearClient();
  const issue = await client.issue(issueId);
  const existing = await issue.labels({ first: 100 });
  await drainConnection(existing);
  const lifecycle = new Set<string>(AI_LIFECYCLE_LABELS);
  for (const existingLabel of existing.nodes) {
    if (lifecycle.has(existingLabel.name)) {
      await client.issueRemoveLabel(issue.id, existingLabel.id);
    }
  }
}

export async function hasLabel(issueId: string, label: string): Promise<boolean> {
  const issue = await getLinearClient().issue(issueId);
  const labels = await issue.labels({ first: 100 });
  await drainConnection(labels);
  return labels.nodes.some((l) => l.name === label);
}
