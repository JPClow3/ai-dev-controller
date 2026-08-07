import { getLinearClient } from './client.js';

export interface LinearIssueSummary {
  id: string;
  identifier: string;
  title: string;
  labels: string[];
  projectName: string | null;
  url: string;
  updatedAt: string;
}

export interface LinearIssueContract extends LinearIssueSummary {
  description: string;
  /** Explicit blockedBy identifiers. Never inferred from prose. */
  blockedBy: string[];
}

/**
 * Returns only issues actually carrying `label`.
 *
 * The server-side filter is re-checked locally: a filter that silently widens
 * would start work on issues nobody authorised, so the label set is verified
 * on every returned issue.
 */
export async function listIssuesByLabel(label: string): Promise<LinearIssueSummary[]> {
  const client = getLinearClient();
  const result = await client.issues({ filter: { labels: { name: { eq: label } } } });

  const summaries: LinearIssueSummary[] = [];
  for (const issue of result.nodes) {
    const [labels, project] = await Promise.all([issue.labels(), issue.project]);
    const names = labels.nodes.map((l) => l.name);
    if (!names.includes(label)) continue;
    summaries.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      labels: names,
      projectName: project?.name ?? null,
      url: issue.url,
      updatedAt:
        issue.updatedAt instanceof Date ? issue.updatedAt.toISOString() : String(issue.updatedAt ?? ''),
    });
  }
  return summaries;
}

export async function getIssueContract(identifier: string): Promise<LinearIssueContract> {
  const client = getLinearClient();
  const issue = await client.issue(identifier);
  const [labels, project, relations] = await Promise.all([
    issue.labels(),
    issue.project,
    issue.relations(),
  ]);

  const blockedBy: string[] = [];
  for (const relation of relations.nodes) {
    if (relation.type !== 'blocks') continue;
    const related = await relation.relatedIssue;
    if (related) blockedBy.push(related.identifier);
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    labels: labels.nodes.map((l) => l.name),
    projectName: project?.name ?? null,
    url: issue.url,
    updatedAt: issue.updatedAt instanceof Date ? issue.updatedAt.toISOString() : String(issue.updatedAt ?? ''),
    blockedBy,
  };
}

/** Curated body write-back. The original description is not preserved by
 *  Linear's API, so the curator's output must be a superset of the intent. */
export async function updateIssueBody(identifier: string, body: string): Promise<void> {
  const client = getLinearClient();
  const issue = await client.issue(identifier);
  await client.updateIssue(issue.id, { description: body });
}

export async function commentOnIssue(identifier: string, body: string): Promise<string> {
  const client = getLinearClient();
  const issue = await client.issue(identifier);
  const payload = await client.createComment({ issueId: issue.id, body });
  const comment = await payload.comment;
  return comment?.id ?? '';
}
