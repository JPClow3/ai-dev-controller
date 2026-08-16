import type { ConcurrencyConfig } from '../config/schema.js';

/** A live agent, as the capacity check sees it. */
export interface RunningAgent {
  issueId: string;
  repositoryId: string;
  aliasId: string;
  provider: 'chatgpt';
  /** Terra and Sol are the heavy GPT tiers and have their own sub-limit. */
  heavy: boolean;
  luna: boolean;
}

export interface CapacityState {
  activeIssues: string[];
  agents: RunningAgent[];
}

export interface CapacityDecision {
  allowed: boolean;
  /** Populated when `allowed` is false. Names the first limit hit. */
  limit?: string;
  remaining: {
    issues: number;
    agents: number;
    gptHeavy: number;
    lunaWorkers: number;
    repository: number;
    issueWorkers: number;
  };
}

export interface DispatchRequest {
  issueId: string;
  repositoryId: string;
  /**
   * Left undefined for work that has not been routed to a model yet.
   *
   * Provider sub-limits are only meaningful once an alias is chosen.
   */
  provider?: 'chatgpt';
  heavy?: boolean;
  luna?: boolean;
  /** True when this dispatch would also open a new issue slot. */
  startsNewIssue: boolean;
  /** Per-repository override from the registry, if any. */
  repositoryMaxAgents?: number;
}

function remainingFor(state: CapacityState, config: ConcurrencyConfig, request: DispatchRequest) {
  const agents = state.agents;
  const repoCap = request.repositoryMaxAgents ?? config.agentsPerRepository;

  return {
    issues: config.activeIssues - state.activeIssues.length,
    agents: config.globalAgents - agents.length,
    gptHeavy: config.gptHeavyAgents - agents.filter((a) => a.heavy).length,
    lunaWorkers: config.gptLunaWorkers - agents.filter((a) => a.luna).length,
    repository: repoCap - agents.filter((a) => a.repositoryId === request.repositoryId).length,
    issueWorkers: config.workersPerIssue - agents.filter((a) => a.issueId === request.issueId).length,
  };
}

/**
 * Would dispatching this agent breach any limit?
 *
 * Every limit is checked, and the first breach is named — "no capacity" with
 * no reason is useless when you are trying to work out why nothing is running.
 */
export function availableCapacity(
  state: CapacityState,
  config: ConcurrencyConfig,
  request: DispatchRequest,
): CapacityDecision {
  const remaining = remainingFor(state, config, request);

  const checks: Array<[boolean, string]> = [
    [request.startsNewIssue && remaining.issues <= 0, 'active_issues'],
    [remaining.agents <= 0, 'global_agents'],
    [remaining.issueWorkers <= 0, 'workers_per_issue'],
    [remaining.repository <= 0, 'agents_per_repository'],
    // Provider sub-limits apply only once a model has actually been chosen.
    [request.heavy === true && remaining.gptHeavy <= 0, 'gpt_heavy_agents'],
    [request.luna === true && remaining.lunaWorkers <= 0, 'gpt_luna_workers'],
  ];

  for (const [breached, limit] of checks) {
    if (breached) return { allowed: false, limit, remaining };
  }
  return { allowed: true, remaining };
}

/**
 * Finishing beats starting.
 *
 * Six new implementations running while three PRs sit at 95% is the failure
 * mode this guards against.
 */
export function shouldThrottleNewWork(input: {
  remediationBacklog: number;
  remediationBacklogThreshold: number;
  providerPressures: Array<'LOW' | 'NORMAL' | 'HIGH' | 'EXHAUSTED'>;
}): { throttle: boolean; reason?: string } {
  if (input.remediationBacklog >= input.remediationBacklogThreshold) {
    return { throttle: true, reason: 'remediation backlog is growing; finish active work first' };
  }
  if (input.providerPressures.length > 0 && input.providerPressures.every((p) => p === 'EXHAUSTED')) {
    return { throttle: true, reason: 'every provider is EXHAUSTED' };
  }
  return { throttle: false };
}
