import { getLinearClient } from './client.js';
import { commentOnIssue } from './issues.js';
import { drainConnection } from './pagination.js';

export interface LinearDependency {
  issueIdentifier: string;
  blockedByIdentifier: string;
}

/**
 * Explicit blocker relations only.
 *
 * The scheduler trusts nothing else. A curator may *propose* a dependency, but
 * until a human approves the relation in Linear it does not exist as far as
 * wave computation is concerned — otherwise a model could silently reorder
 * your roadmap.
 */
export async function getExplicitBlockers(identifier: string): Promise<LinearDependency[]> {
  const client = getLinearClient();
  const issue = await client.issue(identifier);
  // A blocking issue owns the forward `blocks` relation. The blocked issue's
  // prerequisites therefore live on its inverse relation connection.
  const relations = await issue.inverseRelations({ first: 100 });
  await drainConnection(relations);

  const blockers: LinearDependency[] = [];
  for (const relation of relations.nodes) {
    if (relation.type !== 'blocks') continue;
    const blocker = await relation.issue;
    if (!blocker) continue;
    blockers.push({ issueIdentifier: issue.identifier, blockedByIdentifier: blocker.identifier });
  }
  return blockers;
}

export interface DependencyProposal {
  issueIdentifier: string;
  blockingIdentifier: string;
  acceptanceCriterion: string;
  reason: string;
}

/**
 * Posts a proposal as a comment for human approval. Deliberately a comment and
 * not a relation: creating the relation here is exactly the silent DAG
 * mutation the design forbids.
 */
export async function postDependencyProposal(proposal: DependencyProposal): Promise<string> {
  const body = [
    '**Suggested dependency**',
    '',
    `\`${proposal.issueIdentifier}\` should be blocked by \`${proposal.blockingIdentifier}\`.`,
    '',
    `**Acceptance criterion:** ${proposal.acceptanceCriterion}`,
    '',
    `**Reason:** ${proposal.reason}`,
    '',
    '_Approve by creating the relation in Linear. The scheduler only trusts explicit relations._',
  ].join('\n');
  return commentOnIssue(proposal.issueIdentifier, body);
}

export async function postBlockerQuestion(identifier: string, question: string): Promise<string> {
  return commentOnIssue(identifier, ['**Execution paused**', '', question].join('\n'));
}
