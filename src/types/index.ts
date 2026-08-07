/**
 * Core domain types. The controller's vocabulary.
 *
 * Rule that shapes everything here: models return *recommendations*; the
 * controller validates preconditions and performs every write.
 */

/** Internal run state. Strictly more precise than the Linear labels. */
export const RUN_STATES = [
  'DISCOVERED',
  'CURATING',
  'WAITING_READY',
  'QUEUED',
  'DEPENDENCY_BLOCKED',
  'PLANNING',
  'IMPLEMENTING',
  'INTEGRATING',
  'LOCAL_VALIDATION',
  'CI',
  'FINAL_REVIEW',
  'REMEDIATING',
  'PR_READY',
  'PR_OPEN',
  'MERGED',
  // exceptional
  'NEEDS_CONTEXT',
  'BLOCKED_HUMAN',
  'FAILED',
  'CANCELLED',
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** What Linear is allowed to see. Deliberately coarser than RunState. */
export type LinearLabel =
  | 'ai-curate'
  | 'ai-needs-context'
  | 'ai-ready'
  | 'ai-running'
  | 'ai-blocked'
  | 'ai-reviewing'
  | 'ai-pr-open';

export type Risk = 'low' | 'medium' | 'high';
export type CriterionVerdict = 'PASS' | 'PARTIAL' | 'FAIL' | 'UNCERTAIN';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Pressure = 'LOW' | 'NORMAL' | 'HIGH' | 'EXHAUSTED';

export type FailureClass =
  | 'mechanical'
  | 'localized_logic'
  | 'missing_repository_context'
  | 'architecture_or_integration'
  | 'flaky_or_environmental'
  | 'requirement_ambiguity'
  | 'unknown';

export type WorkerAlias =
  | 'cheap_structured'
  | 'routine_worker'
  | 'complex_worker'
  | 'large_context'
  | 'orchestrator'
  | 'high_risk'
  | 'independent_review';

/** Worker identity is model + effort + harness. Never just the model name. */
export interface WorkerIdentity {
  id: string;
  provider: string;
  model: string;
  effort?: string;
  harness: string;
  family: string;
  contextWindow?: number;
  usageClass?: string;
}

export interface AcceptanceCriterion {
  id: string;
  statement: string;
  kind?: string;
  verificationHint?: string;
}

export interface ProjectEntry {
  id: string;
  enabled: boolean;
  repoPath: string;
  githubSlug: string;
  baseBranch: string;
  linearProject?: string;
  knowledgeStatus: 'unverified' | 'verified';
  maxAgents: number;
  routingProfile: string;
}

export interface IssueRecord {
  id: string;
  projectId: string | null;
  title: string | null;
  taskCategory: string | null;
  risk: Risk | null;
  state: RunState;
  paused: boolean;
  acceptanceCriteria: AcceptanceCriterion[];
}

export interface PlanTask {
  id: string;
  summary: string;
  taskCategory: string;
  recommendedAlias?: WorkerAlias;
  owns: string[];
  blockedBy: string[];
  acceptanceCriteria: string[];
  validation: string[];
  risk: Risk;
}

export interface RunRecord {
  id: string;
  issueId: string;
  attempt: number;
  state: RunState;
  active: boolean;
  branch: string | null;
  baseSha: string | null;
  orcaWorktreeId: string | null;
}

export interface Finding {
  severity: Severity;
  category: string;
  acceptanceCriterion: string | null;
  file: string;
  lines?: string;
  explanation: string;
  suggestedValidation: string;
}

export interface ReviewResult {
  verdict: 'approve' | 'request_changes' | 'escalate';
  stage: 'integration' | 'final';
  reviewer: WorkerIdentity;
  findings: Finding[];
  criteria: Array<{ id: string; status: 'satisfied' | 'unsatisfied' | 'uncertain' }>;
}

/** Score components, all normalised 0..1 before weighting. */
export interface ScoreComponents {
  acceptanceCriteria: number;
  firstPassCi: number;
  reviewerDefects: number;
  churn: number;
  resourceCost: number;
  wallClock: number;
}

export interface CompositeScore extends ScoreComponents {
  composite: number;
}
