import type { WorkerIdentity, WorkerAlias, FailureClass, Risk } from '../types/index.js';
import { NotImplementedError } from '../util/errors.js';

/**
 * We route TASK TYPES, not whole issues. One issue routinely uses four models:
 * cleanup on DeepSeek, planning on Terra, a mechanical serializer change on
 * DeepSeek, complex frontend behaviour on Kimi, review on GLM.
 *
 * This is the core philosophy - the system must never collapse into "the GPT
 * pipeline" or "the Ollama pipeline".
 */

export interface RouteRequest {
  projectId: string;
  taskCategory: string;
  risk: Risk;
  alias?: WorkerAlias;
  /** Set when this is an escalation rather than a first attempt. */
  failureClass?: FailureClass;
  previousWorkers?: string[];
  /** Approximate context the task needs, in tokens. Gates small-window models. */
  contextEstimate?: number;
}

export interface RouteDecision {
  worker: WorkerIdentity;
  reason: 'champion' | 'challenger' | 'escalation' | 'pressure_shift' | 'alias_fallback';
  isChallenger: boolean;
  utility: number;
  rejected: Array<{ workerId: string; why: string }>;
}

/**
 * utility = expected_score - scarcity_penalty - latency_penalty
 *
 * Champion comes from routing_stats for (repository, task_category) when it has
 * enough samples, otherwise from config/routing.yaml -> matrix.
 */
export function route(_req: RouteRequest): RouteDecision {
  throw new NotImplementedError('router.route');
}

/**
 * Escalation is policy-bounded: the classifier says WHAT went wrong, this
 * returns only the workers config/escalation.yaml permits for that class.
 * A `mechanical` failure can never reach Sol.
 */
export function legalEscalationTargets(
  _failureClass: FailureClass,
  _previousWorkers: string[],
): string[] {
  throw new NotImplementedError('router.legalEscalationTargets');
}

/**
 * Reviewer selection by authorship, not by rigid rule. Compute an authorship
 * score from changed lines/tasks per family and prefer a reviewer outside the
 * dominant family.
 */
export function selectReviewer(
  _runId: string,
  _strategy: 'opposite_family_from_authors' | 'least_involved_family',
): WorkerIdentity {
  throw new NotImplementedError('router.selectReviewer');
}

export function authorshipByFamily(_runId: string): Record<string, number> {
  throw new NotImplementedError('router.authorshipByFamily');
}

/** True ~15% of the time for low-risk eligible tasks. Never dual-runs. */
export function shouldExplore(_projectId: string, _taskCategory: string, _risk: Risk): boolean {
  throw new NotImplementedError('router.shouldExplore');
}
