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
  const [labels, project, inverseRelations] = await Promise.all([
    issue.labels(),
    issue.project,
    // `inverseRelations`, not `relations`. Linear stores one row per pair: the
    // blocking issue owns a `blocks` relation pointing at the blocked one.
    // Reading `relations` therefore yields the issues THIS one blocks, and
    // recording those as its blockers inverted the entire dependency graph —
    // the scheduler ran dependents first and held their prerequisites.
    issue.inverseRelations(),
  ]);

  const blockedBy: string[] = [];
  for (const relation of inverseRelations.nodes) {
    if (relation.type !== 'blocks') continue;
    const blocker = await relation.issue;
    if (blocker) blockedBy.push(blocker.identifier);
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

/** Writes the full curator result back to Linear as one coherent contract. */
export async function updateIssueContract(
  identifier: string,
  contract: { title: string; body: string },
): Promise<void> {
  const client = getLinearClient();
  const issue = await client.issue(identifier);
  await client.updateIssue(issue.id, { title: contract.title, description: contract.body });
}

export async function commentOnIssue(identifier: string, body: string): Promise<string> {
  const client = getLinearClient();
  const issue = await client.issue(identifier);
  const payload = await client.createComment({ issueId: issue.id, body });
  const comment = await payload.comment;
  return comment?.id ?? '';
}
