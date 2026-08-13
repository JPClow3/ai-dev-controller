import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { realGit } from '../../src/git/repository.js';
import { createGitHub } from '../../src/github/client.js';
import type { GitHub } from '../../src/github/client.js';
import { openBootstrapPullRequest } from '../../src/knowledge/bootstrap-pr.js';
import type { BootstrapPlan } from '../../src/knowledge/bootstrap.js';

const plan = {
  projectId: 'sample',
  repoPath: 'H:/Code/sample',
  baseBranch: 'main',
  ciTrigger: 'none',
  derived: {
    baseBranch: 'main',
    setup: null,
    commands: [],
    riskPaths: [],
    packageManager: 'unknown',
    notes: [],
  },
  map: {},
  files: [],
  preserved: [],
} as unknown as BootstrapPlan;

describe('knowledge bootstrap pull request', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('fails before touching Git when the duplicate-PR preflight is unavailable', async () => {
    const git = vi.fn(async () => '');
    const github = createGitHub(vi.fn(async () => {
      throw new Error('GitHub unavailable');
    }));

    await expect(openBootstrapPullRequest(plan, {
      git,
      github,
      slug: 'owner/sample',
      branch: 'ai/bootstrap-project-knowledge',
      baseBranch: 'main',
      branchPrefix: 'ai/',
    })).rejects.toThrow(/GitHub unavailable/);
    expect(git).not.toHaveBeenCalled();
  });

  it('completes the local bootstrap on a real repository and restores the original branch', { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-dev-bootstrap-'));
    temporaryDirectories.push(root);
    const remote = join(root, 'remote.git');
    const repository = join(root, 'repository');

    await execa('git', ['init', '--bare', remote]);
    await execa('git', ['init', '--initial-branch=main', repository]);
    await execa('git', ['config', 'user.email', 'controller@example.test'], { cwd: repository });
    await execa('git', ['config', 'user.name', 'AI Dev Controller Test'], { cwd: repository });
    writeFileSync(join(repository, 'README.md'), '# Fixture\n');
    await execa('git', ['add', 'README.md'], { cwd: repository });
    await execa('git', ['commit', '-m', 'initial'], { cwd: repository });
    await execa('git', ['remote', 'add', 'origin', remote], { cwd: repository });
    await execa('git', ['push', '--set-upstream', 'origin', 'main'], { cwd: repository });

    const localPlan: BootstrapPlan = {
      ...plan,
      repoPath: repository,
      files: [{ path: '.ai-workflow/project.yaml', content: 'project: sample\n' }],
    };
    const result = await openBootstrapPullRequest(localPlan, {
      git: realGit,
      github: {} as GitHub,
      slug: 'owner/sample',
      branch: 'ai/bootstrap-project-knowledge',
      baseBranch: 'main',
      branchPrefix: 'ai/',
      pushAndOpenPr: false,
    });

    expect(result).toMatchObject({ action: 'created', pullRequest: null });
    expect(await realGit(repository, ['branch', '--show-current'])).toBe('main');
    expect(
      await realGit(repository, ['show', 'ai/bootstrap-project-knowledge:.ai-workflow/project.yaml']),
    ).toBe('project: sample');
    expect(await realGit(repository, ['log', '-1', '--format=%s', 'ai/bootstrap-project-knowledge'])).toBe(
      'chore(ai): bootstrap repository knowledge for sample',
    );
  });
});
