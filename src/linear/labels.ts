import type { AiLifecycleLabel } from '../workflow/states.js';
import { AI_LIFECYCLE_LABELS } from '../workflow/states.js';
import { getLinearClient } from './client.js';

/**
 * `ai-ready` is a human input. The controller reads it and never writes it —
 * that gate is the entire boundary between "AI improved my ticket" and "AI is
 * allowed to change my repository".
 */
export const CONTROLLER_WRITABLE_LABELS: readonly AiLifecycleLabel[] = AI_LIFECYCLE_LABELS.filter(
  (l) => l !== 'ai-ready',
);

export class ForbiddenLabelWrite extends Error {
  constructor(label: string) {
    super(`The controller may never apply "${label}". Only a human authorises implementation.`);
    this.name = 'ForbiddenLabelWrite';
  }
}

export function assertLabelWritable(label: AiLifecycleLabel): void {
  if (!CONTROLLER_WRITABLE_LABELS.includes(label)) throw new ForbiddenLabelWrite(label);
}

/** Fails startup before curation can persist only half of its Linear write. */
export async function assertLifecycleLabelsExist(): Promise<void> {
  const labels = await getLinearClient().issueLabels();
  const present = new Set(labels.nodes.map((label) => label.name));
  const missing = AI_LIFECYCLE_LABELS.filter((label) => !present.has(label));
  if (missing.length > 0) {
    throw new Error(`Linear workspace is missing required lifecycle label(s): ${missing.join(', ')}`);
  }
}

/**
 * Sets exactly one lifecycle label, removing the others.
 *
 * Non-lifecycle labels (Bug, Feature, repo:*) are preserved — the controller
 * owns the ai-* namespace and nothing else.
 */
export async function setAiLifecycleLabel(issueId: string, label: AiLifecycleLabel): Promise<void> {
  assertLabelWritable(label);

  const client = getLinearClient();
  const issue = await client.issue(issueId);
  const existing = await issue.labels();

  const lifecycle = new Set<string>(AI_LIFECYCLE_LABELS);
  const keep = existing.nodes.filter((l) => !lifecycle.has(l.name)).map((l) => l.id);

  const all = await client.issueLabels();
  const target = all.nodes.find((l) => l.name === label);
  if (!target) throw new Error(`Linear label "${label}" does not exist in this workspace`);

  await client.updateIssue(issue.id, { labelIds: [...keep, target.id] });
}

/** Clears controller lifecycle state after a human merge. */
export async function clearAiLifecycleLabels(issueId: string): Promise<void> {
  const client = getLinearClient();
  const issue = await client.issue(issueId);
  const existing = await issue.labels();
  const lifecycle = new Set<string>(AI_LIFECYCLE_LABELS);
  const keep = existing.nodes.filter((label) => !lifecycle.has(label.name)).map((label) => label.id);
  await client.updateIssue(issue.id, { labelIds: keep });
}

export async function hasLabel(issueId: string, label: string): Promise<boolean> {
  const issue = await getLinearClient().issue(issueId);
  const labels = await issue.labels();
  return labels.nodes.some((l) => l.name === label);
}
