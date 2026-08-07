import { ForbiddenOperationError, NotImplementedError } from '../util/errors.js';

/**
 * GitHub Actions is the final mechanical authority. The orchestrator may run
 * tests locally, but a PR is not created until required CI passes.
 *
 * Which checks are required is declared by the repository in
 * .ai-workflow/project.yaml - the central controller must never contain
 * "run pytest for Python". It asks the repository what validation means.
 */

export interface CiStatus {
  headSha: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  checks: Array<{ name: string; conclusion: string | null; required: boolean }>;
  allRequiredPassed: boolean;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  merged: boolean;
  mergeSha: string | null;
}

export function client(): unknown {
  throw new NotImplementedError('github.client');
}

export async function findOpenPr(_slug: string, _branch: string): Promise<PullRequestInfo | null> {
  throw new NotImplementedError('github.findOpenPr');
}

export async function createDraftPr(_opts: {
  slug: string;
  head: string;
  base: string;
  title: string;
  body: string;
}): Promise<PullRequestInfo> {
  throw new NotImplementedError('github.createDraftPr');
}

export async function updatePrBody(_slug: string, _number: number, _body: string): Promise<void> {
  throw new NotImplementedError('github.updatePrBody');
}

export async function ciStatus(_slug: string, _headSha: string): Promise<CiStatus> {
  throw new NotImplementedError('github.ciStatus');
}

/** Merge detection drives the dependency wave. Detect only - never perform. */
export async function pollMergedPrs(_slug: string): Promise<PullRequestInfo[]> {
  throw new NotImplementedError('github.pollMergedPrs');
}

/**
 * Present so the boundary is explicit and greppable. You are the merge
 * authority; the controller has no code path that merges.
 */
export function mergePr(): never {
  throw new ForbiddenOperationError('pr_merge');
}
