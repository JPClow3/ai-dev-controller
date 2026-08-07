import type { LinearLabel } from '../types/index.js';
import { NotImplementedError } from '../util/errors.js';

/**
 * Linear expresses intent and dependency state. The controller decides what is
 * mechanically runnable.
 *
 * We deliberately do NOT mirror internal agent state into Linear. Things like
 * worker_retry_2, glm_review or ci_pending belong in the controller and Orca -
 * putting them in the issue tracker turns it into a log.
 */

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  labels: string[];
  projectName: string | null;
  blockedBy: string[];
  url: string;
}

export function client(): unknown {
  throw new NotImplementedError('linear.client');
}

export async function fetchIssuesWithLabel(_label: LinearLabel): Promise<LinearIssue[]> {
  throw new NotImplementedError('linear.fetchIssuesWithLabel');
}

/** Explicit relations only. `trust_inferred_dependencies` is false. */
export async function fetchDependencies(_issueId: string): Promise<string[]> {
  throw new NotImplementedError('linear.fetchDependencies');
}

export async function setLabel(_issueId: string, _label: LinearLabel): Promise<void> {
  throw new NotImplementedError('linear.setLabel');
}

/** Curated body write-back. Never touches the original description history. */
export async function updateIssueBody(_issueId: string, _body: string): Promise<void> {
  throw new NotImplementedError('linear.updateIssueBody');
}

/**
 * Dependency proposals are posted as comments for human approval. The AI never
 * mutates the DAG - once you approve the relation in Linear it becomes
 * authoritative, and only then does the scheduler see it.
 */
export async function postDependencyProposal(
  _issueId: string,
  _blockingIssue: string,
  _reason: string,
): Promise<string> {
  throw new NotImplementedError('linear.postDependencyProposal');
}

export async function postBlockerQuestion(_issueId: string, _question: string): Promise<void> {
  throw new NotImplementedError('linear.postBlockerQuestion');
}
