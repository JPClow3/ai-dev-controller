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

export interface BlockerNoticeInput {
  issueId: string;
  trigger: string;
  reason: string;
  evidence?: string;
}

interface BlockerAction {
  owner: 'controller' | 'repository' | 'you';
  nextAction: string;
  resumable: boolean;
}

const BLOCKER_ACTIONS: Readonly<Record<string, BlockerAction>> = {
  unresolved_requirement: {
    owner: 'you',
    nextAction: 'Answer the unresolved product requirement in this issue.',
    resumable: true,
  },
  curation_needs_context: {
    owner: 'you',
    nextAction: 'Answer the curation questions in this issue.',
    resumable: true,
  },
  no_validation_available: {
    owner: 'repository',
    nextAction: 'Declare a reliable validation command or CI contract for this repository.',
    resumable: true,
  },
  setup_failed: {
    owner: 'repository',
    nextAction: 'Repair the declared or lockfile-backed dependency setup, then resume this issue.',
    resumable: true,
  },
  pr_not_draft: {
    owner: 'you',
    nextAction: 'Restore this pull request to draft status or confirm that it is not controller-owned.',
    resumable: true,
  },
  repository_resolution_ambiguous: {
    owner: 'you',
    nextAction: 'Add one valid repo:<project-id> marker to the issue.',
    resumable: true,
  },
  dependency_cycle_detected: {
    owner: 'you',
    nextAction: 'Remove or correct the circular Linear dependency before resuming this issue.',
    resumable: true,
  },
  remediation_empty: {
    owner: 'controller',
    nextAction: 'Repair the controller remediation plan before resuming this issue.',
    resumable: false,
  },
  plan_ownership_conflict: {
    owner: 'controller',
    nextAction: 'Repair the task decomposition so parallel tasks have disjoint ownership.',
    resumable: false,
  },
  review_inconclusive: {
    owner: 'controller',
    nextAction: 'Repair the review evidence or remediation plan before resuming this issue.',
    resumable: false,
  },
  retry_budget_exhausted: {
    owner: 'you',
    nextAction: 'Review the recorded failures and decide the product or repository change required.',
    resumable: true,
  },
};

function blockerAction(trigger: string): BlockerAction {
  return BLOCKER_ACTIONS[trigger] ?? {
    owner: 'controller',
    nextAction: 'Investigate and repair the controller path that produced this blocker.',
    resumable: false,
  };
}

/** A lifecycle label is terse; this comment carries the actionable diagnosis. */
export function renderBlockerNotice(input: BlockerNoticeInput): string {
  const action = blockerAction(input.trigger);
  return [
    '## AI blocked',
    '',
    `**Why:** ${input.reason}`,
    ...(input.evidence ? ['', '**Evidence:**', input.evidence] : []),
    '',
    `**Owner:** ${action.owner}`,
    '',
    `**Next action:** ${action.nextAction}`,
    '',
    action.resumable
      ? `**Resume:** After completing that action, run \`pnpm cli resume ${input.issueId}\`.`
      : '**Resume:** Do not resume this issue until the owner action is complete.',
  ].join('\n');
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

export async function postBlockerNotice(input: BlockerNoticeInput): Promise<string> {
  return commentOnIssue(input.issueId, renderBlockerNotice(input));
}

/** Compatibility seam for callers that only have a reason. */
export async function postBlockerQuestion(identifier: string, question: string, trigger = 'controller_attention'): Promise<string> {
  return postBlockerNotice({ issueId: identifier, trigger, reason: question });
}
