import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runRequiredValidation,
  readValidationCommands,
  readValidationCommandsAtBaseSha,
  readValidationContractAtBaseSha,
  readEffectiveSetupCommand,
  readEffectiveSetupCommandAtBaseSha,
  failureDigest,
} from '../../src/validation/local.js';
import { summarise } from '../../src/validation/result.js';
import {
  assertSafeValidationCommand,
  createValidationSafetyPolicy,
  parseSafeValidationCommand,
  ValidationSafetyError,
} from '../../src/validation/safety.js';
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

  it('refuses forbidden commands before invoking the shell', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    const summary = await runRequiredValidation(
      '/repo',
      [{ name: 'deploy', command: 'npm run deploy', required: true }],
      { exec, safety: ['production_deployment'] },
    );

    expect(exec).not.toHaveBeenCalled();
    expect(summary.passed).toBe(false);
    expect(summary.failedRequired).toEqual(['deploy']);
    expect(summary.results[0]?.safetyViolation).toBe('production_deployment');
    expect(failureDigest(summary)).toMatch(/Safety policy: production_deployment/);
  });

  it('cannot hide a safety refusal behind an optional command', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    const summary = await runRequiredValidation(
      '/repo',
      [{ name: 'merge', command: 'git merge origin/main', required: false }],
      { exec },
    );

    expect(exec).not.toHaveBeenCalled();
    expect(summary.passed).toBe(false);
    expect(summary.failedRequired).toEqual(['merge']);
  });

  it('keeps ordinary local validation commands executable', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }));
    const summary = await runRequiredValidation(
      '/repo',
      [
        { name: 'test', command: 'pnpm test', required: true },
        { name: 'typecheck', command: 'npm run typecheck', required: true },
        { name: 'python', command: 'python -m pytest', required: true },
      ],
      { exec },
    );

    expect(exec).toHaveBeenCalledTimes(3);
    expect(summary.passed).toBe(true);
  });

  it('does not confuse a local test-secret fixture with production rotation', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    const summary = await runRequiredValidation(
      '/repo',
      [{ name: 'fixtures', command: 'npm run rotate:test-secrets', required: true }],
      { exec },
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(summary.passed).toBe(true);
  });

  it('does not classify an AWS SDK test as a cloud deletion', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    const summary = await runRequiredValidation(
      '/repo',
      [{ name: 'aws-sdk', command: 'node aws-sdk-delete-mock.test.js', required: true }],
      { exec },
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(summary.passed).toBe(true);
  });

  it.each([
    ['production DB migration', 'DATABASE_URL=postgres://prod.example/db pnpm prisma migrate deploy', 'production_database_mutation'],
    ['remote deletion', 'aws s3 rm s3://bucket --recursive', 'remote_resource_deletion'],
    ['remote repository deletion', 'gh repo delete acme/app --yes', 'remote_resource_deletion'],
    ['remote branch deletion', 'git push origin --delete feature/old', 'remote_resource_deletion'],
    ['secret rotation', 'production_secret rotate --name API_TOKEN', 'production_secret_rotation'],
    ['force push', 'git push --force origin main', 'force_push_protected_branch'],
    ['force push with git options', 'git -C repo push -f origin main', 'force_push_protected_branch'],
    ['force push with shell whitespace indirection', 'git${IFS}push --force origin main', 'force_push_protected_branch'],
    ['PR merge', 'gh pr merge 42 --squash', 'pr_merge'],
    ['PR merge with gh options', 'gh --repo acme/app pr merge 42', 'pr_merge'],
    ['branch protection', 'gh api repos/acme/app/branches/main/protection --method PUT', 'branch_protection_change'],
    ['cloud destroy', 'terraform destroy -auto-approve', 'destructive_cloud_operation'],
  ])('blocks %s', (_label, command, operation) => {
    const policy = createValidationSafetyPolicy([operation]);
    expect(policy.violation(command)?.operation).toBe(operation);
    expect(() => assertSafeValidationCommand(command, [operation])).toThrow(ValidationSafetyError);
  });

  it('fails closed when the configured safety list is empty', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    const summary = await runRequiredValidation(
      '/repo',
      [{ name: 'test', command: 'pnpm test', required: true }],
      { exec, safety: [] },
    );
    expect(exec).not.toHaveBeenCalled();
    expect(summary.results[0]?.safetyViolation).toBe('safety_policy_missing');
    expect(summary.passed).toBe(false);
  });

  it('does not hand an empty command to the shell', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    const summary = await runRequiredValidation(
      '/repo',
      [{ name: 'empty', command: '   ', required: false }],
      { exec },
    );
    expect(exec).not.toHaveBeenCalled();
    expect(summary.results[0]?.safetyViolation).toBe('validation_command_empty');
    expect(summary.passed).toBe(false);
  });

  it.each([
    'git" "push --force origin main',
    'pnpm test; git push origin main',
    'pnpm test `git push origin main`',
    'pnpm test $(git push origin main)',
  ])('rejects shell evasions before execution: %s', async (command) => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    const summary = await runRequiredValidation('/repo', [{ name: 'unsafe', command, required: true }], { exec });
    expect(exec).not.toHaveBeenCalled();
    expect(summary.results[0]?.safetyViolation).toBe('validation_command_not_allowed');
  });

  it('parses quoted arguments as argv, without retaining shell syntax', () => {
    expect(parseSafeValidationCommand("pnpm test -- --grep 'critical path'")).toEqual({
      file: 'pnpm',
      args: ['test', '--', '--grep', 'critical path'],
    });
  });

  it('applies operation checks to the dequoted argv form', () => {
    const policy = createValidationSafetyPolicy(['production_deployment']);
    expect(policy.violation('npm run de"pl"oy')?.operation).toBe('production_deployment');
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

  it('can read an immutable contract from the recorded base SHA', async () => {
    const repo = scratchRepo({
      '.ai-workflow/project.yaml': `validation:\n  commands:\n    test:\n      command: npm run attacker-controlled-script\n`,
    });
    const readAtBaseSha = vi.fn(async (_repo: string, _sha: string, path: string) => {
      expect(path).toBe('.ai-workflow/project.yaml');
      return `validation:\n  commands:\n    test:\n      command: pnpm test\n`;
    });

    await expect(readValidationCommandsAtBaseSha(repo, '0123456789abcdef0123456789abcdef01234567', { readAtBaseSha })).resolves.toEqual([
      { name: 'test', command: 'pnpm test', required: true },
    ]);
    expect(readAtBaseSha).toHaveBeenCalledTimes(1);
    expect(readValidationCommands(repo)).toEqual([
      { name: 'test', command: 'npm run attacker-controlled-script', required: true },
    ]);
  });

  it('does not fall back to mutable working-tree commands when the base contract is unavailable', async () => {
    const repo = scratchRepo({
      '.ai-workflow/project.yaml': `validation:\n  commands:\n    test:\n      command: npm run attacker-controlled-script\n`,
    });
    await expect(readValidationContractAtBaseSha(
      repo,
      '0123456789abcdef0123456789abcdef01234567',
      { readAtBaseSha: async () => null },
    )).resolves.toEqual({ source: 'none', setup: null, commands: [] });
  });

  it('rejects a non-SHA base reference rather than reading mutable content', async () => {
    const readAtBaseSha = vi.fn(async () => 'validation: {}');
    await expect(readValidationContractAtBaseSha('/repo', 'origin/main', { readAtBaseSha })).resolves.toEqual({
      source: 'none',
      setup: null,
      commands: [],
    });
    expect(readAtBaseSha).not.toHaveBeenCalled();
  });

  it('infers setup from exactly one lockfile in the immutable base', async () => {
    const readAtBaseSha = vi.fn(async (_repo: string, _sha: string, path: string) => {
      if (path === '.ai-workflow/project.yaml') return 'validation:\n  commands:\n    test: { command: pnpm test }\n';
      if (path === 'pnpm-lock.yaml') return 'lockfileVersion: 9';
      return null;
    });
    await expect(readEffectiveSetupCommandAtBaseSha(
      '/repo',
      '0123456789abcdef0123456789abcdef01234567',
      { readAtBaseSha },
    )).resolves.toEqual({ name: 'setup', command: 'pnpm install --frozen-lockfile', required: true });
  });

  it('does not infer setup when base lockfiles conflict', async () => {
    const readAtBaseSha = vi.fn(async (_repo: string, _sha: string, path: string) => {
      if (path === '.ai-workflow/project.yaml') return 'validation: {}';
      if (path === 'package-lock.json' || path === 'pnpm-lock.yaml') return '{}';
      return null;
    });
    await expect(readEffectiveSetupCommandAtBaseSha(
      '/repo',
      '0123456789abcdef0123456789abcdef01234567',
      { readAtBaseSha },
    )).resolves.toBeNull();
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
