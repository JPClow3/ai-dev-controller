import { describe, expect, it } from 'vitest';
import {
  availableCapacity,
  shouldThrottleNewWork,
  type CapacityState,
  type RunningAgent,
  type DispatchRequest,
} from '../../src/scheduler/capacity.js';
import { loadControllerConfig } from '../../src/config/load-config.js';

const config = loadControllerConfig(process.cwd()).global.concurrency;

function agent(over: Partial<RunningAgent> = {}): RunningAgent {
  return {
    issueId: 'UNI-1',
    repositoryId: 'repo-a',
    aliasId: 'luna_high',
    provider: 'chatgpt',
    heavy: false,
    luna: true,
    ...over,
  };
}

function state(agents: RunningAgent[], activeIssues = ['UNI-1']): CapacityState {
  return { activeIssues, agents };
}

function request(over: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    issueId: 'UNI-1',
    repositoryId: 'repo-a',
    provider: 'chatgpt',
    heavy: false,
    luna: false,
    startsNewIssue: false,
    ...over,
  };
}

describe('the approved concurrency envelope', () => {
  it('uses 4 issues / 3 workers-per-issue / 7 agents / 5 per repo', () => {
    expect(config.activeIssues).toBe(4);
    expect(config.workersPerIssue).toBe(3);
    expect(config.globalAgents).toBe(7);
    expect(config.agentsPerRepository).toBe(5);
  });

  it('caps active issues at 4', () => {
    const s = state([], ['A', 'B', 'C', 'D']);
    const decision = availableCapacity(s, config, request({ startsNewIssue: true }));
    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe('active_issues');
  });

  it('still admits work for an already-active issue when the issue slots are full', () => {
    const s = state([], ['A', 'B', 'C', 'D']);
    expect(availableCapacity(s, config, request({ startsNewIssue: false })).allowed).toBe(true);
  });

  it('caps global agents at 7', () => {
    const agents = Array.from({ length: 7 }, (_, i) =>
      agent({ issueId: `UNI-${i}`, repositoryId: `repo-${i}`, luna: false }),
    );
    const decision = availableCapacity(state(agents), config, request({ issueId: 'UNI-99' }));
    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe('global_agents');
  });

  it('caps workers per issue at 3', () => {
    const agents = Array.from({ length: 3 }, () => agent({ luna: false }));
    const decision = availableCapacity(state(agents), config, request());
    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe('workers_per_issue');
  });

  it('caps agents per repository at 5', () => {
    const agents = Array.from({ length: 5 }, (_, i) =>
      agent({ issueId: `UNI-${i}`, repositoryId: 'repo-a', luna: false }),
    );
    const decision = availableCapacity(state(agents), config, request({ issueId: 'UNI-99' }));
    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe('agents_per_repository');
  });

  it('honours a per-repository override from the registry', () => {
    const agents = [agent({ issueId: 'UNI-9', luna: false })];
    const decision = availableCapacity(
      state(agents),
      config,
      request({ issueId: 'UNI-99', repositoryMaxAgents: 1 }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe('agents_per_repository');
  });
});

describe('reserved sub-limits', () => {
  it('caps heavy GPT agents (Terra/Sol) at 2', () => {
    const agents = [
      agent({ issueId: 'UNI-1', repositoryId: 'r1', heavy: true, luna: false, aliasId: 'terra_high' }),
      agent({ issueId: 'UNI-2', repositoryId: 'r2', heavy: true, luna: false, aliasId: 'sol_xhigh' }),
    ];
    const decision = availableCapacity(state(agents), config, request({ issueId: 'UNI-3', heavy: true }));
    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe('gpt_heavy_agents');
  });

  it('caps Luna workers at 4', () => {
    const agents = Array.from({ length: 4 }, (_, i) =>
      agent({ issueId: `UNI-${i}`, repositoryId: `r${i}`, luna: true }),
    );
    const decision = availableCapacity(state(agents), config, request({ issueId: 'UNI-9', luna: true }));
    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe('gpt_luna_workers');
  });

  it('lets a heavy GPT agent through while Luna slots are full', () => {
    const agents = Array.from({ length: 4 }, (_, i) =>
      agent({ issueId: `UNI-${i}`, repositoryId: `r${i}`, luna: true }),
    );
    const decision = availableCapacity(state(agents), config, request({ issueId: 'UNI-9', heavy: true }));
    expect(decision.allowed).toBe(true);
  });
});

describe('shouldThrottleNewWork', () => {
  it('throttles when the remediation backlog reaches the threshold', () => {
    const result = shouldThrottleNewWork({
      remediationBacklog: 4,
      remediationBacklogThreshold: 4,
      providerPressures: ['NORMAL'],
    });
    expect(result.throttle).toBe(true);
  });

  it('throttles when every provider is exhausted', () => {
    const result = shouldThrottleNewWork({
      remediationBacklog: 0,
      remediationBacklogThreshold: 4,
      providerPressures: ['EXHAUSTED', 'EXHAUSTED'],
    });
    expect(result.throttle).toBe(true);
  });

  it('does not throttle while one provider still has room', () => {
    const result = shouldThrottleNewWork({
      remediationBacklog: 1,
      remediationBacklogThreshold: 4,
      providerPressures: ['EXHAUSTED', 'NORMAL'],
    });
    expect(result.throttle).toBe(false);
  });
});
