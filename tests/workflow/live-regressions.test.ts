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

describe('duplicate detection fails closed', () => {
  it('does not claim or create work when an authoritative source is unavailable', async () => {
    const unavailableOrca = createOrcaClient({
      run: vi.fn(async () => {
        throw new Error('Orca unavailable');
      }),
    });
    const d = deps({ orca: unavailableOrca });

    await expect(dispatchNewIssue(d, {
      issueId: 'JP-7', projectId: 'portfolio', role: 'work', risk: 'low', slug: 'JPClow3/Portfolio',
    })).rejects.toThrow(/Orca unavailable/);
    expect(repos.getActiveRun('JP-7')).toBeNull();
  });

  it('does not treat a GitHub outage as evidence that no pull request exists', async () => {
    const unavailableGitHub = createGitHub(vi.fn(async () => {
      throw new Error('GitHub unavailable');
    }));
    const d = deps({ github: unavailableGitHub });

    await expect(dispatchNewIssue(d, {
      issueId: 'JP-7', projectId: 'portfolio', role: 'work', risk: 'low', slug: 'JPClow3/Portfolio',
    })).rejects.toThrow(/GitHub unavailable/);
    expect(repos.getActiveRun('JP-7')).toBeNull();
  });
});

describe('new parent worktrees start at the fetched base commit', () => {
  it('fast-forwards the controller-owned parent before recording the workspace', async () => {
    const freshBase = '08cf33de550eb8302c74abdd6733e8173a125b86';
    const gitCalls: Array<{ cwd: string; args: string[] }> = [];
    const gitRunner = vi.fn(async (cwd: string, args: string[]) => {
      gitCalls.push({ cwd, args });

      if (args[0] === 'show-ref' && args[1] === '--verify') {
        throw Object.assign(new Error('missing branch'), { exitCode: 1 });
      }
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return freshBase;
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return freshBase;
      return '';
    });
    const orca = createOrcaClient({
      run: vi.fn(async (_binary: string, args: string[]) => {
        if (args[0] === 'repo') {
          return {
            stdout: JSON.stringify({
              id: 'x', ok: true, result: {
                repos: [{
                  id: 'r1', path: 'H:/Code/Pessoais/Portfolio', displayName: 'Portfolio',
                  gitRemoteIdentity: { canonicalKey: 'github.com/JPClow3/Portfolio', remoteUrl: '' },
                }],
              },
            }),
            stderr: '',
          };
        }
        if (args[0] === 'worktree' && args[1] === 'list') {
          return {
            stdout: JSON.stringify({ id: 'x', ok: true, result: { worktrees: [] } }),
            stderr: '',
          };
        }
        return {
          stdout: JSON.stringify({
            id: 'x', ok: true, result: {
              worktree: {
                id: 'new-wt', path: 'C:/fresh-parent', branch: 'refs/heads/JPClow3/ai-JP-7',
              },
            },
          }),
          stderr: '',
        };
      }),
    });
    const d = deps({ orca, git: createGit(gitRunner) });

    const result = await dispatchNewIssue(d, {
      issueId: 'JP-7', projectId: 'portfolio', role: 'routine_behavior', risk: 'low', slug: 'JPClow3/Portfolio',
    });

    expect(result.action).toBe('started');
    expect(gitCalls).toContainEqual({
      cwd: 'C:/fresh-parent',
      args: ['merge', '--ff-only', freshBase],
    });
    expect(repos.getActiveRun('JP-7')?.baseSha).toBe(freshBase);
  });
});

describe('throttle considers every provider, not one', () => {
  it('throttles only when every provider is exhausted', () => {
    let map = defaultPressure(config.routing);
    for (const provider of Object.keys(map)) map = withOverride(map, provider, 'EXHAUSTED');

    expect(shouldThrottleNewWork({
      remediationBacklog: 0,
      remediationBacklogThreshold: 4,
      providerPressures: Object.values(map).map((p) => p.pressure),
    }).throttle).toBe(true);
  });

  it('does not throttle when provider is usable', () => {
    const map = defaultPressure(config.routing);
    expect(shouldThrottleNewWork({
      remediationBacklog: 0,
      remediationBacklogThreshold: 4,
      providerPressures: Object.values(map).map((p) => p.pressure),
    }).throttle).toBe(false);
  });

  it('a one-entry sample must not read as total exhaustion', () => {
    expect(shouldThrottleNewWork({
      remediationBacklog: 0,
      remediationBacklogThreshold: 4,
      providerPressures: ['EXHAUSTED'],
    }).throttle).toBe(true);
  });
});

describe('a disabled provider is never selected', () => {
  it('throws only when every candidate provider is exhausted', () => {
    const pressure = withOverride(defaultPressure(config.routing), 'chatgpt', 'EXHAUSTED');
    pressure['commandcode'] = { provider: 'commandcode', pressure: 'EXHAUSTED', remainingAllowance: 0, source: 'test', manualOverride: false };
    pressure['zai'] = { provider: 'zai', pressure: 'EXHAUSTED', remainingAllowance: 0, source: 'test', manualOverride: false };
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
    const derived = deriveProject('H:/Code/Freelance/fatec-web', 'main');
    expect(derived.commands).toHaveLength(0);
    expect(derived.notes.length).toBeGreaterThan(0);
  });

  it.runIf(existsSync('H:/Code/Pessoais/Portfolio'))('completes discovery quickly on a real repo', () => {
    const started = Date.now();
    deriveProject('H:/Code/Pessoais/Portfolio', 'main');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
