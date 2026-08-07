import type { WorkflowState } from '../workflow/states.js';

export type Risk = 'low' | 'medium' | 'high';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type CriterionVerdict = 'PASS' | 'PARTIAL' | 'FAIL' | 'UNCERTAIN';
export type Pressure = 'LOW' | 'NORMAL' | 'HIGH' | 'EXHAUSTED';

export interface ProjectRow {
  id: string;
  enabled: boolean;
  repoPath: string;
  githubSlug: string;
  baseBranch: string;
  linearProject: string | null;
  knowledgeStatus: 'unverified' | 'verified';
  maxAgents: number;
  routingProfile: string;
}

export interface IssueRow {
  id: string;
  projectId: string | null;
  linearUuid: string | null;
  title: string | null;
  role: string | null;
  risk: Risk | null;
  state: WorkflowState;
  paused: boolean;
  acceptanceCriteria: AcceptanceCriterion[];
}

export interface AcceptanceCriterion {
  id: string;
  statement: string;
  kind?: string;
}

export interface RunRecord {
  id: string;
  issueId: string;
  repositoryId: string;
  attempt: number;
  state: WorkflowState;
  branch: string | null;
  baseSha: string | null;
  orcaWorktreeId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface TaskRow {
  id: number;
  runId: string;
  taskKey: string;
  summary: string | null;
  role: string | null;
  risk: Risk;
  owns: string[];
  blockedBy: string[];
  acceptanceCriteria: string[];
  state: string;
  branch: string | null;
  orcaWorktreeId: string | null;
}

export interface AttemptRow {
  id: number;
  taskId: number;
  attemptNo: number;
  aliasId: string;
  role: AttemptRole;
  isChallenger: boolean;
  failureClass: string | null;
  compositeScore: number | null;
  wallClockSeconds: number | null;
  resourceCost: number | null;
}

export type AttemptRole =
  | 'curator'
  | 'planner'
  | 'worker'
  | 'classifier'
  | 'integration_reviewer'
  | 'final_reviewer'
  | 'bootstrap';

export interface PullRequestRow {
  runId: string;
  number: number;
  url: string;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
}

export interface DependencyRow {
  issueId: string;
  blockedBy: string;
  source: 'linear' | 'manual';
  /** Set only when the blocking issue's PR is MERGED. */
  satisfiedAt: string | null;
}

export interface RoutingStatRow {
  scope: 'global' | 'repository';
  projectId: string | null;
  role: string;
  aliasId: string;
  samples: number;
  compositeAvg: number | null;
  firstPassCi: number | null;
  successRate: number | null;
  medianMinutes: number | null;
}
