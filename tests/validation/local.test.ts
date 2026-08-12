import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runRequiredValidation,
  readValidationCommands,
  readEffectiveSetupCommand,
  failureDigest,
} from '../../src/validation/local.js';
import { summarise } from '../../src/validation/result.js';
import { deriveProject, renderProjectYaml, detectCiTrigger } from '../../src/knowledge/derive.js';
import { overlappingOwnership, globsIntersect } from '../../src/git/integration.js';
import { assertNotBaseBranch, ForbiddenGitOperation } from '../../src/git/repository.js';

function scratchRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-dev-repo-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('validation is evidence, not opinion', () => {
  const commands = [
    { name: 'typecheck', command: 'tsc --noEmit', required: true },
    { name: 'test', command: 'vitest run', required: true },
    { name: 'lint', command: 'eslint .', required: false },
  ];

  it('derives pass/fail only from exit codes', async () => {
    const exec = vi.fn(async (command: string) => ({
      exitCode: command.includes('vitest') ? 1 : 0,
      stdout: 'output',
      stderr: command.includes('vitest') ? '2 tests failed' : '',
      timedOut: false,
    }));

    const summary = await runRequiredValidation('/repo', commands, { exec });
    expect(summary.passed).toBe(false);
    expect(summary.failedRequired).toEqual(['test']);
  });

  it('runs every command even after one fails, so all problems surface at once', async () => {
    const exec = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }));
    await runRequiredValidation('/repo', commands, { exec });
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('does not fail the run on an optional command', async () => {
    const exec = vi.fn(async (command: string) => ({
      exitCode: command.includes('eslint') ? 1 : 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    }));
    const summary = await runRequiredValidation('/repo', commands, { exec });
    expect(summary.passed).toBe(true);
  });

  it('treats a timeout as a failure, not a pass', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: true }));
    const summary = await runRequiredValidation('/repo', commands, { exec });
    expect(summary.passed).toBe(false);
  });

  it('an empty command list cannot vacuously pass a required gate', () => {
    // No commands means nothing was proven; callers must treat this as
    // unvalidated rather than green.
    const summary = summarise([]);
    expect(summary.results).toHaveLength(0);
    expect(summary.failedRequired).toHaveLength(0);
  });

  it('builds a digest naming the failing command and its output', async () => {
    const exec = vi.fn(async (command: string) => ({
      exitCode: command.includes('vitest') ? 1 : 0,
      stdout: '',
      stderr: 'expected 3 to be 4',
      timedOut: false,
    }));
    const summary = await runRequiredValidation('/repo', commands, { exec });
    const digest = failureDigest(summary);
    expect(digest).toContain('test');
    expect(digest).toContain('expected 3 to be 4');
  });
});

describe('readValidationCommands', () => {
  it('reads what the repository declares', () => {
    const repo = scratchRepo({
      '.ai-workflow/project.yaml': `version: 1
validation:
  commands:
    test:
      command: pnpm test
      required: true
    lint:
      command: pnpm lint
      required: false
`,
    });
    const commands = readValidationCommands(repo);
    expect(commands).toEqual([
      { name: 'test', command: 'pnpm test', required: true },
      { name: 'lint', command: 'pnpm lint', required: false },
    ]);
  });

  it('returns nothing when the repository has not been bootstrapped', () => {
    expect(readValidationCommands(scratchRepo({}))).toEqual([]);
  });
});

describe('readEffectiveSetupCommand', () => {
  it('uses a deterministic npm install when a package lock is present', () => {
    expect(readEffectiveSetupCommand(scratchRepo({ 'package-lock.json': '{}' }))).toEqual({
      name: 'setup',
      command: 'npm ci',
      required: true,
    });
  });

  it('prefers an explicit setup command over a lockfile inference', () => {
    expect(readEffectiveSetupCommand(scratchRepo({
      'package-lock.json': '{}',
      '.ai-workflow/project.yaml': `validation:
  setup:
    command: npm ci --ignore-scripts
`,
    }))).toEqual({
      name: 'setup',
      command: 'npm ci --ignore-scripts',
      required: true,
    });
  });

  it('uses no setup command without a supported lockfile or declaration', () => {
    expect(readEffectiveSetupCommand(scratchRepo({ 'requirements.txt': 'requests' }))).toBeNull();
  });

  it('does not guess a package manager when lockfiles conflict', () => {
    expect(readEffectiveSetupCommand(scratchRepo({
      'package-lock.json': '{}',
      'pnpm-lock.yaml': 'lockfileVersion: 9',
    }))).toBeNull();
  });
});

describe('deriveProject reads rather than assumes', () => {
  it('uses the real package manager and only scripts that exist', () => {
    const repo = scratchRepo({
      'package.json': JSON.stringify({ scripts: { build: 'x', test: 'y', typecheck: 'z' } }),
      'pnpm-lock.yaml': '',
    });
    const derived = deriveProject(repo, 'main');
    expect(derived.packageManager).toBe('pnpm');
    expect(derived.commands.map((c) => c.command)).toEqual([
      'pnpm run typecheck',
      'pnpm run test',
      'pnpm run build',
    ]);
    expect(derived.notes.some((n) => n.includes('lint'))).toBe(true);
  });

  it('does not invent pytest for a Python repo with no test setup', () => {
    const repo = scratchRepo({ 'requirements.txt': 'numpy' });
    const derived = deriveProject(repo, 'master');
    expect(derived.commands).toHaveLength(0);
    expect(derived.notes.join(' ')).toMatch(/Validation is undetermined/);
  });

  it('records honestly when nothing can be determined', () => {
    const derived = deriveProject(scratchRepo({}), 'main');
    const yaml = renderProjectYaml('x', derived);
    expect(yaml).toContain('NONE DERIVED');
  });

  it('detects the CI trigger from workflow on: blocks', () => {
    const prRepo = scratchRepo({ '.github/workflows/ci.yml': 'name: CI\non:\n  pull_request:\n\njobs: {}\n' });
    expect(detectCiTrigger(prRepo)).toBe('pull_request');

    const pushRepo = scratchRepo({ '.github/workflows/ci.yml': 'name: CI\non:\n  push:\n\njobs: {}\n' });
    expect(detectCiTrigger(pushRepo)).toBe('branch_push');

    expect(detectCiTrigger(scratchRepo({}))).toBe('none');
  });
});

describe('ownership overlap is prevented, not reconciled', () => {
  it('flags two parallel tasks writing the same area', () => {
    const clashes = overlappingOwnership([
      { id: 'api', owns: ['backend/export/**'], blockedBy: [] },
      { id: 'other', owns: ['backend/export/service.ts'], blockedBy: [] },
    ]);
    expect(clashes).toHaveLength(1);
  });

  it('allows overlap when the tasks are sequential', () => {
    const clashes = overlappingOwnership([
      { id: 'api', owns: ['backend/export/**'], blockedBy: [] },
      { id: 'tests', owns: ['backend/export/**'], blockedBy: ['api'] },
    ]);
    expect(clashes).toHaveLength(0);
  });

  it('allows genuinely disjoint tasks to run in parallel', () => {
    const clashes = overlappingOwnership([
      { id: 'api', owns: ['backend/export/**'], blockedBy: [] },
      { id: 'web', owns: ['web/src/features/export/**'], blockedBy: [] },
      { id: 'tests', owns: ['tests/export/**'], blockedBy: [] },
    ]);
    expect(clashes).toHaveLength(0);
  });

  it('errs toward caution on ambiguous globs', () => {
    expect(globsIntersect('src/**', 'src/a/b.ts')).toBe(true);
    expect(globsIntersect('**/*.ts', 'src/a.ts')).toBe(true);
    expect(globsIntersect('a/**', 'b/**')).toBe(false);
  });
});

describe('git safety boundaries', () => {
  it('refuses to push the base branch', () => {
    expect(() => assertNotBaseBranch('master', 'master')).toThrow(ForbiddenGitOperation);
    expect(() => assertNotBaseBranch('main', 'master')).toThrow(ForbiddenGitOperation);
  });

  it('allows an ai/ branch', () => {
    expect(() => assertNotBaseBranch('ai/UNI-142-thing', 'main')).not.toThrow();
  });
});
