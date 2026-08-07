import { NotImplementedError } from '../util/errors.js';

/**
 * Dependency waves.
 *
 * THE RULE: a dependency is satisfied only when its PR has been MERGED into the
 * configured base branch. Not when the worker finished, not when tests passed,
 * not when the PR opened, not when a reviewer approved.
 *
 * This is what stops wave 2 from building against yesterday's assumptions.
 */

export interface DagNode {
  issueId: string;
  blockedBy: string[];
  merged: boolean;
}

export interface Wave {
  index: number;
  issueIds: string[];
}

/** Only explicit, human-approved Linear `blockedBy` relations are trusted. */
export function buildDag(_projectId?: string): DagNode[] {
  throw new NotImplementedError('dag.buildDag');
}

/** Issues whose every blocker has a merged PR. */
export function readyIssues(_dag: DagNode[]): string[] {
  throw new NotImplementedError('dag.readyIssues');
}

export function computeWaves(_dag: DagNode[]): Wave[] {
  throw new NotImplementedError('dag.computeWaves');
}

/** Reject cycles loudly rather than deadlocking the scheduler silently. */
export function detectCycles(_dag: DagNode[]): string[][] {
  throw new NotImplementedError('dag.detectCycles');
}
