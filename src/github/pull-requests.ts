import type { GitHub } from './client.js';

export interface PullRequestRef {
  number: number;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headSha: string;
  merged: boolean;
  mergedAt: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
}

interface GhPr {
  number: number;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid?: string;
  mergedAt?: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
}

function toRef(pr: GhPr): PullRequestRef {
  return {
    number: pr.number,
    url: pr.url,
    isDraft: pr.isDraft,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headSha: pr.headRefOid ?? '',
    merged: pr.state === 'MERGED',
    mergedAt: pr.mergedAt ?? null,
    state: pr.state,
  };
}

const FIELDS = 'number,url,isDraft,headRefName,baseRefName,headRefOid,mergedAt,state';

export async function findPullRequestByBranch(
  gh: GitHub,
  slug: string,
  branch: string,
): Promise<PullRequestRef | null> {
  const list = await gh.api<GhPr[]>([
    'pr',
    'list',
    '--repo',
    slug,
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    FIELDS,
  ]);
  const pr = (list ?? [])[0];
  return pr ? toRef(pr) : null;
}

export interface DraftPrInput {
  slug: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

/**
 * Creates the draft PR, or returns the existing one.
 *
 * Idempotent by necessity: on a `pull_request` repository this runs early,
 * purely to trigger CI, and a controller restart mid-run must not open a
 * second PR for the same branch.
 *
 * Always `--draft`. The controller has no code path that opens a ready PR.
 */
export async function ensureDraftPullRequest(gh: GitHub, input: DraftPrInput): Promise<PullRequestRef> {
  const existing = await findPullRequestByBranch(gh, input.slug, input.head);
  if (existing && existing.state === 'OPEN') return existing;

  await gh.api<unknown>([
    'pr',
    'create',
    '--repo',
    input.slug,
    '--head',
    input.head,
    '--base',
    input.base,
    '--title',
    input.title,
    '--body',
    input.body,
    '--draft',
  ]).catch(async (err: unknown) => {
    // A concurrent create is fine as long as a PR now exists.
    const found = await findPullRequestByBranch(gh, input.slug, input.head);
    if (!found) throw err;
    return null;
  });

  const created = await findPullRequestByBranch(gh, input.slug, input.head);
  if (!created) throw new Error(`Draft PR for ${input.head} was not created`);
  return created;
}

/** Replaces the stub body with the full provenance write-up. */
export async function updatePullRequestBody(
  gh: GitHub,
  slug: string,
  number: number,
  body: string,
): Promise<void> {
  await gh.api<unknown>(['pr', 'edit', String(number), '--repo', slug, '--body', body]);
}

/**
 * Merged PRs since the last poll. Detection only — the controller never merges.
 * This is what advances the dependency wave.
 */
export async function listRecentlyMerged(gh: GitHub, slug: string, limit = 50): Promise<PullRequestRef[]> {
  const list = await gh.api<GhPr[]>([
    'pr',
    'list',
    '--repo',
    slug,
    '--state',
    'merged',
    '--limit',
    String(limit),
    '--json',
    FIELDS,
  ]);
  return (list ?? []).map(toRef);
}

/**
 * `ai/UNI-142-...` -> `UNI-142`, so a merged PR can release its blockers.
 *
 * Also matches `owner/ai/UNI-142-...`: Orca namespaces the branches it creates
 * under the GitHub owner, so an anchored match found the prefix in none of the
 * branches this controller actually pushes.
 */
export function issueIdFromBranch(branch: string, prefix: string): string | null {
  const normalised = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const at = branch.startsWith(normalised) ? 0 : branch.indexOf(`/${normalised}`) + 1;
  if (at <= 0 && !branch.startsWith(normalised)) return null;
  const rest = branch.slice(at + normalised.length);
  const match = /^([A-Z][A-Z0-9]*-\d+)/.exec(rest);
  return match?.[1] ?? null;
}
