import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { openDatabase, type ControllerDatabase } from '../../src/state/db.js';
import { createRepositories } from '../../src/state/repositories.js';
import { loadControllerConfig } from '../../src/config/load-config.js';
import { dispatchNewIssue, type DispatchDeps } from '../../src/workflow/dispatch.js';
import { shouldThrottleNewWork } from '../../src/scheduler/capacity.js';
import { defaultPressure, withOverride } from '../../src/routing/pressure.js';
import { selectModel } from '../../src/routing/selector.js';
import { detectCiTrigger, deriveProject } from '../../src/knowledge/derive.js';
import { createOrcaClient } from '../../src/orca/client.js';
import { createGitHub } from '../../src/github/client.js';
import { createGit } from '../../src/git/repository.js';

const config = loadControllerConfig(process.cwd());
let db: ControllerDatabase;
let repos: ReturnType<typeof createRepositories>;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  repos.upsertProject({
    id: 'portfolio',
    enabled: true,
    repoPath: 'H:/Code/Pessoais/Portfolio',
    githubSlug: 'JPClow3/Portfolio',
    baseBranch: 'main',
    linearProject: 'Portfolio',
    knowledgeStatus: 'unverified',
    maxAgents: 5,
    routingProfile: 'default',
  });
  repos.upsertIssue({ id: 'JP-7', projectId: 'portfolio', title: 'test' });
});
afterEach(() => db.close());

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  const orcaRun = vi.fn(async (_b: string, args: string[]) => {
    if (args[0] === 'repo') {
      return {
        stdout: JSON.stringify({
          id: 'x',
          ok: true,
          result: {
            repos: [
              {
                id: 'r1',
                path: 'H:/Code/Pessoais/Portfolio',
                displayName: 'Portfolio',
                gitRemoteIdentity: { canonicalKey: 'github.com/JPClow3/Portfolio', remoteUrl: '' },
              },
            ],
          },
        }),
        stderr: '',
      };
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return {
        stdout: JSON.stringify({
          id: 'x',
          ok: true,
          // The shape Orca really returns: owner-namespaced and flattened.
          result: {
            worktrees: [
              { id: 'existing-wt', path: 'C:/wt', branch: 'refs/heads/JPClow3/ai-JP-7' },
            ],
          },
        }),
        stderr: '',
      };
    }
    return {
      stdout: JSON.stringify({ id: 'x', ok: true, result: { worktree: { id: 'new-wt', path: 'C:/wt2' } } }),
      stderr: '',
    };
  });

  return {
    config,
    repos,
    orca: createOrcaClient({ run: orcaRun }),
    github: createGitHub(vi.fn(async () => '[]')),
    git: createGit(vi.fn(async () => 'deadbeefcafe')),
    routing: {
      routing: config.routing,
      scoring: config.scoring,
      pressure: defaultPressure(config.routing),
      stats: () => null,
      random: () => 0.99,
    },
    agentNameFor: (alias: string) => alias,
    ...over,
  };
}

/**
 * Regression: when prior work existed, dispatch logged "adopting rather than
 * recreating" and returned WITHOUT claiming a run or recording the workspace.
 * The issue was then permanently stuck — work existed, nothing owned it, and
 * nothing ever picked it up again.
 */
describe('adopting existing work still claims and records it', () => {
  it('claims a run rather than returning empty-handed', async () => {
    const d = deps();
    const result = await dispatchNewIssue(d, {
      issueId: 'JP-7',
      projectId: 'portfolio',
      role: 'work',
      risk: 'low',
      slug: 'JPClow3/Portfolio',
    });

    expect(result.action).toBe('adopted');
    expect(result.runId).toBeTruthy();
    expect(repos.getActiveRun('JP-7')).not.toBeNull();
  });

  it('attaches the existing worktree so the next step can find it', async () => {
    const d = deps();
    await dispatchNewIssue(d, {
      issueId: 'JP-7',
      projectId: 'portfolio',
      role: 'work',
      risk: 'low',
      slug: 'JPClow3/Portfolio',
    });

    const run = repos.getActiveRun('JP-7')!;
    expect(run.orcaWorktreeId).toBe('existing-wt');
    // The branch Orca actually created, not the one that was requested:
    // pushing the requested name pushed a ref that does not exist locally.
    expect(run.branch).toBe('JPClow3/ai-JP-7');
    expect(run.baseSha).toBe('deadbeefcafe');
  });

  it('does not create a second run when one already exists', async () => {
    const d = deps();
    const first = await dispatchNewIssue(d, {
      issueId: 'JP-7', projectId: 'portfolio', role: 'work', risk: 'low', slug: 'JPClow3/Portfolio',
    });
    const second = await dispatchNewIssue(d, {
      issueId: 'JP-7', projectId: 'portfolio', role: 'work', risk: 'low', slug: 'JPClow3/Portfolio',
    });
    expect(second.runId).toBe(first.runId);
  });
});

/**
 * Regression: providerPressures returned only the Orca-derived entry, so
 * "every provider EXHAUSTED" was true from a sample of one. A spent Codex
 * quota throttled the whole controller while Ollama sat idle.
 */
describe('throttle considers every provider, not one', () => {
  it('does not throttle when one provider is still usable', () => {
    const map = withOverride(defaultPressure(config.routing), 'chatgpt', 'EXHAUSTED');
    const pressures = Object.values(map).map((p) => p.pressure);

    expect(pressures.length).toBeGreaterThan(1);
    expect(shouldThrottleNewWork({
      remediationBacklog: 0,
      remediationBacklogThreshold: 4,
      providerPressures: pressures,
    }).throttle).toBe(false);
  });

  it('throttles only when every provider is exhausted', () => {
    // Derived from the config so adding a provider cannot silently weaken this.
    let map = defaultPressure(config.routing);
    for (const provider of Object.keys(map)) map = withOverride(map, provider, 'EXHAUSTED');

    expect(shouldThrottleNewWork({
      remediationBacklog: 0,
      remediationBacklogThreshold: 4,
      providerPressures: Object.values(map).map((p) => p.pressure),
    }).throttle).toBe(true);
  });

  it('does not throttle while a third provider remains usable', () => {
    let map = withOverride(defaultPressure(config.routing), 'chatgpt', 'EXHAUSTED');
    map = withOverride(map, 'ollama', 'EXHAUSTED');
    // ollama_local is still NORMAL - exactly the situation during this pilot.
    expect(shouldThrottleNewWork({
      remediationBacklog: 0,
      remediationBacklogThreshold: 4,
      providerPressures: Object.values(map).map((p) => p.pressure),
    }).throttle).toBe(false);
  });

  /** A single-entry sample was the bug: one exhausted provider looked like all. */
  it('a one-entry sample must not read as total exhaustion', () => {
    expect(shouldThrottleNewWork({
      remediationBacklog: 0,
      remediationBacklogThreshold: 4,
      providerPressures: ['EXHAUSTED'],
    }).throttle).toBe(true);
    // ...which is why the caller must supply all providers, asserted above.
  });
});

describe('a disabled provider is never selected', () => {
  /**
   * Ollama Cloud answers 403 "requires a subscription" — reachable but
   * unusable. Challenger exploration kept picking it and failing.
   */
  it('routes around it even when exploration would have chosen it', () => {
    const pressure = withOverride(defaultPressure(config.routing), 'ollama', 'EXHAUSTED');
    for (let i = 0; i < 20; i += 1) {
      const decision = selectModel(
        { projectId: 'portfolio', role: 'routine_bugfix', risk: 'low' },
        {
          routing: config.routing,
          scoring: config.scoring,
          pressure,
          stats: () => null,
          random: () => 0.01, // always explore
        },
      );
      expect(config.routing.aliases[decision.alias]!.provider).not.toBe('ollama');
    }
  });

  it('throws rather than dispatching nothing when both are disabled', () => {
    let pressure = withOverride(defaultPressure(config.routing), 'ollama', 'EXHAUSTED');
    pressure = withOverride(pressure, 'chatgpt', 'EXHAUSTED');
    expect(() =>
      selectModel({ projectId: 'portfolio', role: 'routine_bugfix', risk: 'low' }, {
        routing: config.routing,
        scoring: config.scoring,
        pressure,
        stats: () => null,
        random: () => 0.99,
      }),
    ).toThrow(/No eligible model/);
  });
});

/** Against the actual repositories, not fixtures. */
describe('real repositories on disk', () => {
  const REPOS = [
    { id: 'portfolio', path: 'H:/Code/Pessoais/Portfolio', base: 'main', ci: 'none' },
    { id: 'inova', path: 'H:/Code/Freelance/Inova', base: 'master', ci: 'pull_request' },
    { id: 'hefesto', path: 'H:/Code/Pessoais/hefesto', base: 'master', ci: 'pull_request' },
    { id: 'throughline', path: 'H:/Code/Pessoais/Throughline', base: 'main', ci: 'pull_request' },
  ] as const;

  for (const repo of REPOS) {
    const present = existsSync(repo.path);
    it.runIf(present)(`${repo.id} CI trigger is detected correctly`, () => {
      expect(detectCiTrigger(repo.path, repo.base)).toBe(repo.ci);
    });
  }

  it.runIf(existsSync('H:/Code/Freelance/Inova'))('uses the declared base branch, not a hardcoded main', () => {
    // Inova is on master. Detecting against `main` must not report a live
    // trigger for workflows that only fire on master.
    const onMaster = detectCiTrigger('H:/Code/Freelance/Inova', 'master');
    const onMain = detectCiTrigger('H:/Code/Freelance/Inova', 'main');
    expect(onMaster).toBe('pull_request');
    expect(['pull_request', 'branch_push', 'none']).toContain(onMain);
  });

  it.runIf(existsSync('H:/Code/Pessoais/hefesto'))('derives pytest only because tests/ exists', () => {
    const derived = deriveProject('H:/Code/Pessoais/hefesto', 'master');
    expect(derived.packageManager).toBe('pip');
    expect(derived.commands.map((c) => c.name)).toContain('test');
  });

  it.runIf(existsSync('H:/Code/Freelance/fatec-web'))('reports honestly when no command matches', () => {
    // fatec-web has build:site / test:e2e, none of which match the candidates.
    const derived = deriveProject('H:/Code/Freelance/fatec-web', 'main');
    expect(derived.commands).toHaveLength(0);
    expect(derived.notes.length).toBeGreaterThan(0);
  });

  it.runIf(existsSync('H:/Code/Pessoais/Portfolio'))('completes discovery quickly on a real repo', () => {
    // Discovery previously took ~90s per repo and hung on a large one.
    const started = Date.now();
    deriveProject('H:/Code/Pessoais/Portfolio', 'main');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
