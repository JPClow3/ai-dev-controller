import { NotImplementedError } from '../util/errors.js';

/**
 * Concurrency enforcement. Limits come from config/global.yaml:
 *   active_issues 4 | workers_per_issue 3 | global_agents 7
 *   gpt_heavy_agents 2 | gpt_luna_workers 3 | ollama_workers 3
 *   agents_per_repository 5
 */
export interface CapacitySnapshot {
  activeIssues: number;
  globalAgents: number;
  perRepository: Record<string, number>;
  perProviderClass: Record<string, number>;
  remaining: {
    issues: number;
    agents: number;
    gptHeavy: number;
    lunaWorkers: number;
    ollamaWorkers: number;
  };
}

export function snapshot(): CapacitySnapshot {
  throw new NotImplementedError('capacity.snapshot');
}

/** Would dispatching this worker breach any limit? */
export function canDispatch(_workerId: string, _projectId: string): boolean {
  throw new NotImplementedError('capacity.canDispatch');
}

/**
 * Throttle new starts when providers approach quota or the remediation backlog
 * grows. Finishing beats starting.
 */
export function shouldThrottleNewWork(): boolean {
  throw new NotImplementedError('capacity.shouldThrottleNewWork');
}
