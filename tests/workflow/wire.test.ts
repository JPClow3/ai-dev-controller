import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitHub } from '../../src/github/client.js';
import { createOrcaClient } from '../../src/orca/client.js';
import { loadControllerConfig } from '../../src/config/load-config.js';
import { openDatabase, type ControllerDatabase } from '../../src/state/db.js';
import { createRepositories } from '../../src/state/repositories.js';
import { buildController } from '../../src/workflow/wire.js';

const config = loadControllerConfig(process.cwd());
let db: ControllerDatabase;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => db.close());

describe('controller composition recovery', () => {
  it('does not start an Orca snapshot when every run is waiting on a human', async () => {
    const repos = createRepositories(db);
    const project = config.registry.projects['portfolio']!;
    repos.upsertProject({
      id: 'portfolio',
      enabled: true,
      repoPath: project.repository.path,
      githubSlug: project.repository.github,
      baseBranch: project.repository.baseBranch,
      linearProject: project.linear.project ?? null,
      knowledgeStatus: project.knowledgeStatus,
      maxAgents: project.maxAgents ?? config.global.concurrency.agentsPerRepository,
      routingProfile: project.routingProfile,
    });
    repos.upsertIssue({ id: 'JP-1', projectId: 'portfolio', title: 'Blocked' });
    const run = repos.claimIssueRun('JP-1', 'portfolio')!;
    db.raw.prepare("UPDATE runs SET state = 'BLOCKED_HUMAN', branch = 'ai/JP-1' WHERE id = ?").run(run.id);

    const orcaRun = vi.fn(async () => {
      throw new Error('Orca should not be called');
    });
    const controller = buildController({
      config,
      repos,
      orca: createOrcaClient({ run: orcaRun }),
      github: createGitHub(vi.fn(async () => '[]')),
      writeToLinear: false,
    });

    const result = await controller.recoverReality(false);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.derivedState).toBe('BLOCKED_HUMAN');
    expect(orcaRun).not.toHaveBeenCalled();
  });
});
