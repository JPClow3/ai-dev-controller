import type { ControllerConfig } from '../config/load-config.js';
import type { ControllerRepositories } from '../state/repositories.js';
import type { RunRecord, Risk } from '../state/types.js';
import type { CiTrigger, WorkflowState } from './states.js';
import type { ValidationSummary } from '../validation/result.js';
import type { ChecksSummary } from '../github/checks.js';
import type {
  ReviewAssessment,
  ReviewResult,
} from '../reviews/review.js';

export interface PlanTask {
  id: string;
  summary: string;
  task_category: string;
  owns: string[];
  blocked_by?: string[];
  acceptance_criteria: string[];
  risk?: Risk;
  /** Internal remediation routing constraint; planner output never sets it. */
  exclude_aliases?: string[];
}

export interface StepContext {
  run: RunRecord;
  projectId: string;
  ciTrigger: CiTrigger;
  risk: Risk;
  baseBranch: string;
  branch: string;
  /**
   * The parent Orca worktree, where this run's branch is actually checked out.
   *
   * Distinct from the registry's repository path, which holds the base branch.
   * Every git and validation operation after PLANNING belongs here; running
   * them in the registry path operates on the wrong tree entirely.
   */
  worktreePath: string;
}

/**
 * Side effects the orchestrator needs, each one already implemented elsewhere.
 *
 * Injected rather than imported so a step can be exercised without Orca,
 * GitHub or a model being reachable — which is the only way this is testable
 * before a pilot.
 */
export interface OrchestratorDeps {
  config: ControllerConfig;
  repos: ControllerRepositories;

  dependenciesMerged: (issueId: string) => boolean;
  fetchFreshBase: (ctx: StepContext) => Promise<string>;

  plan: (ctx: StepContext) => Promise<{ tasks: PlanTask[]; blocked?: string }>;
  createWorktrees: (ctx: StepContext, tasks: PlanTask[]) => Promise<void>;

  workersSettled: (ctx: StepContext) => Promise<{ allSettled: boolean; interrupted: string[] }>;
  /** Relaunch interrupted tasks when their persisted attempt budget permits. */
  retryInterruptedWorkers: (ctx: StepContext, taskIds: string[]) => Promise<boolean>;
  /** Launches tasks whose blockers have finished; returns how many started. */
  dispatchNextWave: (ctx: StepContext) => Promise<{ started: number; capacityBlocked: boolean }>;
  integrate: (ctx: StepContext) => Promise<{ conflicts: string[]; headSha: string | null }>;

  runValidation: (ctx: StepContext) => Promise<ValidationSummary>;
  pushBranch: (ctx: StepContext) => Promise<void>;
  ensureDraftPr: (ctx: StepContext) => Promise<{ number: number }>;
  readChecks: (ctx: StepContext) => Promise<ChecksSummary>;
  retryEnvironmentalCi: (ctx: StepContext, checks: ChecksSummary) => Promise<boolean>;
  /** Read from GitHub, never assumed. */
  pullRequestIsDraft: (ctx: StepContext) => Promise<boolean>;

  review: (ctx: StepContext) => Promise<ReviewResult>;
  /**
   * The assessment is threaded through rather than recomputed, so the PR body
   * reports what the reviewer actually concluded. Rendering it independently
   * is how a body ends up claiming every criterion passed.
   */
  writeProvenanceBody: (ctx: StepContext, assessment: ReviewAssessment | null) => Promise<void>;
  /** Persist immutable routing samples before the run reaches its human gate. */
  recordScores: (ctx: StepContext) => Promise<number>;

  remediationCycles: (runId: string) => number;
  originalAuthors: (runId: string) => string[];
  dispatchRemediation: (ctx: StepContext, tasks: unknown[]) => Promise<void>;

  blockForHuman: (ctx: StepContext, trigger: string, question: string) => Promise<void>;
}

export interface StepResult {
  from: WorkflowState;
  to: WorkflowState | null;
  action: string;
  detail?: string;
}

