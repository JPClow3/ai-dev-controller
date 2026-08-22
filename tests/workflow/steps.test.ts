import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { realGit } from '../../src/git/repository.js';
import { createGit } from '../../src/git/repository.js';
import { createGitHub } from '../../src/github/client.js';
import { createOrcaClient } from '../../src/orca/client.js';
import { loadControllerConfig } from '../../src/config/load-config.js';
import { defaultPressure } from '../../src/routing/pressure.js';
import { openDatabase } from '../../src/state/db.js';
import { createRepositories } from '../../src/state/repositories.js';
import {
  cleanFailedAttempt,
  createSteps,
  effectiveTaskRisk,
  formatWorkerCommitMessage,
  alignRemediationWorktree,
  remediationPlanTasks,
  shouldWaitForExistingWorkerLaunch,
  workerTerminalTitle,
  workerWorktreeName,
} from '../../src/workflow/steps.js';
import { assertSafeWorkerSetup } from '../../src/workflow/step-workers.js';

describe('worker dispatch recovery boundaries', () => {
  it('formats concise factual controller commit messages', () => {
    const message = formatWorkerCommitMessage({
      issueId: 'JP-6',
      projectId: 'portfolio',
      taskId: 'github-fallback-tests',
      taskCategory: 'test',
      taskSummary: 'Create a Vitest suite covering the GitHub activity fallback behavior for an empty username.',
      ownedPaths: ['tests/unit/github.test.ts'],
      workerSummary: 'Tests could not run because dependencies are not installed.',
    });

    expect(message.split('\n')[0]).toBe('test(portfolio): create a Vitest suite covering the GitHub… (JP-6)');
    expect(message.split('\n')[0]!.length).toBeLessThanOrEqual(72);
    expect(message).toContain('Task: github-fallback-tests');
    expect(message).toContain('Verification: Tests could not run because dependencies are not installed.');
  });

  it('never lowers an issue risk when a task omits or lowers its own risk', () => {
    expect(effectiveTaskRisk('high', undefined)).toBe('high');
    expect(effectiveTaskRisk('high', 'low')).toBe('high');
    expect(effectiveTaskRisk('medium', 'high')).toBe('high');
  });

  it('reuses the same deterministic worktree for every bounded attempt', () => {
    expect(workerWorktreeName('JPClow3/ai-JP-8', 'shared')).toBe('JPClow3-ai-JP-8-shared');
  });

  it('gives each attempt a distinct terminal identity inside that worktree', () => {
    expect(workerTerminalTitle('shared', 1)).toBe('worker:shared:attempt:1');
    expect(workerTerminalTitle('shared', 2)).not.toBe(workerTerminalTitle('shared', 1));
  });

  it('waits only when the worker process left evidence that launch began', () => {
    expect(shouldWaitForExistingWorkerLaunch({
      resumingDispatch: true,
      recentHeartbeat: false,
      terminalExists: false,
      processAlive: false,
    })).toBe(false);
    expect(shouldWaitForExistingWorkerLaunch({
      resumingDispatch: true,
      recentHeartbeat: true,
      terminalExists: false,
      processAlive: false,
    })).toBe(true);
    expect(shouldWaitForExistingWorkerLaunch({
      resumingDispatch: true,
      recentHeartbeat: false,
      terminalExists: true,
      processAlive: false,
    })).toBe(true);
    expect(shouldWaitForExistingWorkerLaunch({
      resumingDispatch: true,
      recentHeartbeat: false,
      terminalExists: false,
      processAlive: true,
    })).toBe(true);
  });

  it('turns findings into a disjoint, different-author remediation wave', () => {
    const tasks = remediationPlanTasks([
      {
        findingIndex: 0,
        file: 'src/a.test.ts',
        acceptanceCriterion: 'AC-1',
        instruction: 'Assert the exact object.',
        suggestedValidation: 'npm test',
        excludeAliases: ['luna_high'],
      },
      {
        findingIndex: 1,
        file: 'src/a.test.ts',
        acceptanceCriterion: 'AC-2',
        instruction: 'Cover the boundary.',
        suggestedValidation: 'npm test',
        excludeAliases: ['luna_high'],
      },
    ], 1);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'remediation-1-0',
      task_category: 'orchestrator',
      owns: ['src/a.test.ts'],
      acceptance_criteria: ['AC-1', 'AC-2'],
      exclude_aliases: ['luna_high'],
    });
    expect(tasks[0]?.summary).toContain('Assert the exact object.');
    expect(tasks[0]?.summary).toContain('npm test');
  });

  it('starts a remediation child from the integrated parent head', async () => {
    const git = {
      headSha: vi.fn(async () => 'integrated-parent'),
      fastForwardTo: vi.fn(async () => undefined),
    };

    await alignRemediationWorktree(git as never, 'C:/worker', 'C:/parent');

    expect(git.headSha).toHaveBeenCalledWith('C:/parent');
    expect(git.fastForwardTo).toHaveBeenCalledWith('C:/worker', 'integrated-parent');
  });

  it('removes real tracked and untracked carryover before a retry and preserves evidence', { timeout: 20_000 }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ai-dev-retry-'));
    const evidence = join(repo, '..', `${repo.split(/[\\/]/).pop()}.failed.patch`);
    try {
      await realGit(repo, ['init']);
      await realGit(repo, ['config', 'user.email', 'controller@example.invalid']);
      await realGit(repo, ['config', 'user.name', 'Controller Test']);
      mkdirSync(join(repo, 'src'));
      writeFileSync(join(repo, 'src', 'tracked.ts'), 'clean\n');
      await realGit(repo, ['add', '.']);
      await realGit(repo, ['commit', '-m', 'base']);
      writeFileSync(join(repo, 'src', 'tracked.ts'), 'failed alias edit\n');
      writeFileSync(join(repo, 'src', 'new.ts'), 'failed alias file\n');

      expect(await cleanFailedAttempt(realGit, repo, ['src/**'], evidence)).toBe(true);
      expect(await realGit(repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
      expect(readFileSync(join(repo, 'src', 'tracked.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('clean\n');
      expect(existsSync(join(repo, 'src', 'new.ts'))).toBe(false);
      expect(readFileSync(evidence, 'utf8')).toContain('failed alias edit');
      expect(readFileSync(evidence, 'utf8')).toContain('src/new.ts');
      expect(readFileSync(join(`${evidence}.files`, 'src', 'new.ts'), 'utf8')).toBe('failed alias file\n');
    } finally {
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(evidence, { force: true });
      rmSync(`${evidence}.files`, { recursive: true, force: true });
    }
  });

  it('refuses a retry when Git cannot collect complete failed-attempt evidence', async () => {
    await expect(cleanFailedAttempt(
      async () => { throw new Error('git unavailable'); },
      'C:/worker',
      ['src/**'],
      'C:/evidence.patch',
    )).rejects.toThrow(/git unavailable/);
  });
});

describe('pull request durability', () => {
  it('screens an unsafe immutable setup command before validation reaches the shell', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ai-dev-validation-safety-'));
    const db = openDatabase(':memory:');
    try {
      await realGit(repo, ['init']);
      await realGit(repo, ['config', 'user.email', 'controller@example.invalid']);
      await realGit(repo, ['config', 'user.name', 'Controller Test']);
      mkdirSync(join(repo, '.ai-workflow'));
      writeFileSync(
        join(repo, '.ai-workflow', 'project.yaml'),
        [
          'validation:',
          '  setup:',
          '    command: git push --force origin HEAD',
          '  commands:',
          '    smoke:',
          '      command: echo smoke',
        ].join('\n'),
      );
      await realGit(repo, ['add', '.']);
      await realGit(repo, ['commit', '-m', 'validation contract']);
      const baseSha = (await realGit(repo, ['rev-parse', 'HEAD'])).trim();

      const repos = createRepositories(db);
      const config = loadControllerConfig(process.cwd());
      const project = config.registry.projects.portfolio!;
      repos.upsertProject({
        id: 'portfolio', enabled: true,
        repoPath: repo,
        githubSlug: project.repository.github,
        baseBranch: project.repository.baseBranch,
        linearProject: project.linear.project ?? null,
        knowledgeStatus: 'unverified', maxAgents: 2, routingProfile: 'default',
      });
      repos.upsertIssue({ id: 'JP-78', projectId: 'portfolio', title: 'Safety setup' });
      const run = repos.claimIssueRun('JP-78', 'portfolio')!;
      repos.attachRunWorkspace(run.id, { branch: 'ai/JP-78', baseSha, orcaWorktreeId: `repo::${repo}` });
      const steps = createSteps({
        config,
        repos,
        agents: {} as never,
        orca: createOrcaClient({ run: async () => ({ stdout: '{}', stderr: '' }) }),
        github: createGitHub(async () => '[]'),
        git: createGit(async () => ''),
        gitRunner: async () => '',
        routing: {
          routing: config.routing,
          scoring: config.scoring,
          pressure: defaultPressure(config.routing),
          stats: () => null,
          random: () => 0.5,
        },
        agentNameFor: (alias) => alias,
        writeToLinear: false,
      });

      const summary = await steps.runValidation({
        run: repos.getRun(run.id)!,
        projectId: 'portfolio',
        ciTrigger: 'pull_request',
        risk: 'low',
        baseBranch: project.repository.baseBranch,
        branch: 'ai/JP-78',
        worktreePath: repo,
      });

      expect(summary.passed).toBe(false);
      expect(summary.results.find((result) => result.name === 'setup')).toMatchObject({
        passed: false,
        safetyViolation: 'force_push_protected_branch',
      });
    } finally {
      db.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses an unsafe setup before worker launch', () => {
    expect(() => assertSafeWorkerSetup(
      'wrangler deploy --env production',
      ['production_deployment'],
    )).toThrow(/Refused unsafe validation command/);
    expect(() => assertSafeWorkerSetup('npm ci', ['production_deployment'])).not.toThrow();
  });

  it('records an existing draft PR adopted from GitHub', async () => {
    const db = openDatabase(':memory:');
    try {
      const repos = createRepositories(db);
      const config = loadControllerConfig(process.cwd());
      const project = config.registry.projects.portfolio!;
      repos.upsertProject({
        id: 'portfolio', enabled: true,
        repoPath: project.repository.path,
        githubSlug: project.repository.github,
        baseBranch: project.repository.baseBranch,
        linearProject: project.linear.project ?? null,
        knowledgeStatus: 'unverified', maxAgents: 2, routingProfile: 'default',
      });
      repos.upsertIssue({ id: 'JP-77', projectId: 'portfolio', title: 'Persist PR' });
      const run = repos.claimIssueRun('JP-77', 'portfolio')!;
      const github = createGitHub(async () => JSON.stringify([{
        number: 77,
        url: 'https://github.com/JPClow3/Portfolio/pull/77',
        isDraft: true,
        headRefName: 'JPClow3/ai-JP-77',
        baseRefName: project.repository.baseBranch,
        headRefOid: 'abc123',
        mergedAt: null,
        state: 'OPEN',
      }]));
      const steps = createSteps({
        config,
        repos,
        agents: {} as never,
        orca: createOrcaClient({ run: async () => ({ stdout: '{}', stderr: '' }) }),
        github,
        git: createGit(async () => ''),
        gitRunner: async () => '',
        routing: {
          routing: config.routing,
          scoring: config.scoring,
          pressure: defaultPressure(config.routing),
          stats: () => null,
          random: () => 0.5,
        },
        agentNameFor: (alias) => alias,
        writeToLinear: false,
      });

      await steps.ensureDraftPr({
        run,
        projectId: 'portfolio',
        ciTrigger: 'pull_request',
        risk: 'low',
        baseBranch: project.repository.baseBranch,
        branch: 'JPClow3/ai-JP-77',
        worktreePath: 'C:/wt',
      });

      const validation = await steps.runValidation({
        run,
        projectId: 'portfolio',
        ciTrigger: 'pull_request',
        risk: 'low',
        baseBranch: project.repository.baseBranch,
        branch: 'JPClow3/ai-JP-77',
        worktreePath: 'C:/wt',
      });
      expect(validation.passed).toBe(false);
      expect(validation.results[0]).toMatchObject({
        name: 'setup',
        required: true,
        passed: false,
      });
      expect(validation.results[0]?.command).toContain('requires a recorded base SHA');

      expect(db.raw.prepare('SELECT number, url, draft, head_branch, base_branch FROM pull_requests WHERE run_id = ?')
        .get(run.id)).toEqual({
          number: 77,
          url: 'https://github.com/JPClow3/Portfolio/pull/77',
          draft: 1,
          head_branch: 'JPClow3/ai-JP-77',
          base_branch: project.repository.baseBranch,
        });
    } finally {
      db.close();
    }
  });
});
