import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ValidationCommand } from '../validation/result.js';

/**
 * Derives validation commands from what a repository actually does.
 *
 * Read, never assume. The temptation is to emit `pytest` because a repo is
 * Python; a command that does not exist fails every run and looks like the
 * agent broke something.
 */
export interface DerivedProject {
  baseBranch: string;
  /**
   * How to prepare a fresh checkout before validating it.
   *
   * Orca worktrees have no `node_modules` and no virtualenv, so omitting this
   * makes every validation command fail for a reason that has nothing to do
   * with the change under test.
   */
  setup: ValidationCommand | null;
  commands: ValidationCommand[];
  riskPaths: string[];
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'pip' | 'unknown';
  notes: string[];
}

/** Script names worth running, most-specific first, mapped to a stable name. */
const SCRIPT_PREFERENCE: Array<{ name: string; candidates: string[]; required: boolean }> = [
  { name: 'lint', candidates: ['lint'], required: false },
  { name: 'typecheck', candidates: ['typecheck', 'check', 'tsc'], required: true },
  { name: 'test', candidates: ['test:unit', 'test'], required: true },
  { name: 'build', candidates: ['build'], required: true },
];

const RISK_PATTERNS = [
  'migrations/**',
  'auth/**',
  'billing/**',
  'infrastructure/**',
  'prisma/migrations/**',
  'drizzle/**',
  '.github/workflows/**',
];

export function deriveProject(repoPath: string, baseBranch: string): DerivedProject {
  const notes: string[] = [];
  const commands: ValidationCommand[] = [];
  let setup: ValidationCommand | null = null;
  let packageManager: DerivedProject['packageManager'] = 'unknown';

  const pkgPath = join(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    packageManager = detectNodePackageManager(repoPath);
    const scripts = readScripts(pkgPath);
    const runner = `${packageManager} run`;

    // A locked install, matching what CI does. `npm install` would silently
    // resolve a different tree than the one the checks run against.
    const locked: Record<string, string> = {
      npm: 'npm ci',
      pnpm: 'pnpm install --frozen-lockfile',
      yarn: 'yarn install --immutable',
    };
    const install = locked[packageManager];
    if (install) setup = { name: 'setup', command: install, required: true };

    for (const spec of SCRIPT_PREFERENCE) {
      const found = spec.candidates.find((c) => scripts.includes(c));
      if (found) {
        commands.push({ name: spec.name, command: `${runner} ${found}`, required: spec.required });
      } else {
        notes.push(`No \`${spec.name}\` script found (looked for: ${spec.candidates.join(', ')}).`);
      }
    }
  } else if (existsSync(join(repoPath, 'requirements.txt')) || existsSync(join(repoPath, 'pyproject.toml'))) {
    packageManager = 'pip';
    // Only claim a Python command when its config is actually present.
    if (existsSync(join(repoPath, 'ruff.toml')) || fileContains(join(repoPath, 'pyproject.toml'), 'ruff')) {
      commands.push({ name: 'lint', command: 'ruff check .', required: false });
    }
    if (existsSync(join(repoPath, 'pytest.ini')) || existsSync(join(repoPath, 'tests'))) {
      commands.push({ name: 'test', command: 'pytest', required: true });
    }
    if (commands.length === 0) {
      notes.push('Python repository, but no ruff/pytest configuration was found. Validation is undetermined.');
    }
  } else {
    notes.push('No package.json or Python project files found. Validation commands must be filled in by hand.');
  }

  const riskPaths = RISK_PATTERNS.filter((glob) => existsSync(join(repoPath, glob.replace(/\/\*\*$/, ''))));

  if (!setup) {
    notes.push('No dependency install command derived. A fresh worktree may not be able to run validation.');
  }

  return { baseBranch, setup, commands, riskPaths, packageManager, notes };
}

function readScripts(pkgPath: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
    return Object.keys(pkg.scripts ?? {});
  } catch {
    return [];
  }
}

function detectNodePackageManager(repoPath: string): 'npm' | 'pnpm' | 'yarn' {
  if (existsSync(join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoPath, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function fileContains(path: string, needle: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

/** Detects how CI fires, so the registry's ci.trigger is measured not guessed. */
export function detectCiTrigger(
  repoPath: string,
  baseBranch = 'main',
): 'pull_request' | 'branch_push' | 'none' {
  const dir = join(repoPath, '.github/workflows');
  if (!existsSync(dir)) return 'none';
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f));
  if (files.length === 0) return 'none';

  let anyBranchPush = false;

  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const on = /^on:\s*([\s\S]*?)(?=^\S)/m.exec(text)?.[1] ?? '';

    // A `pull_request:` trigger filtered to branches that do not include this
    // repository's default fires for nothing. Portfolio's workflow targets
    // `master` while the repo is on `main`, so every check is dormant and the
    // controller would otherwise wait forever for CI that cannot start.
    if (on.includes('pull_request')) {
      const filter = branchFilterFor(on, 'pull_request');
      if (!filter || filter.includes(baseBranch)) return 'pull_request';
    }

    // A push trigger only helps if it is unfiltered: the controller pushes
    // `ai/*` branches, which a `branches:` list will not match.
    if (/^\s*push:/m.test(on) && branchFilterFor(on, 'push') === null) anyBranchPush = true;
  }

  return anyBranchPush ? 'branch_push' : 'none';
}

/**
 * Branch names a `pull_request:` trigger is restricted to, or null when
 * unrestricted.
 *
 * Line-based rather than one regex: the nesting is indentation-sensitive and a
 * lazy multiline match is easy to get subtly wrong.
 */
export function branchFilterFor(onBlock: string, trigger: 'pull_request' | 'push'): string[] | null {
  const lines = onBlock.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*${trigger}:`).test(l));
  if (start === -1) return null;

  const baseIndent = (/^(\s*)/.exec(lines[start]!)?.[1] ?? '').length;
  const branches: string[] = [];
  let seenBranchesKey = false;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const indent = (/^(\s*)/.exec(line)?.[1] ?? '').length;
    if (indent <= baseIndent) break; // left the pull_request block

    const inline = /branches:\s*\[([^\]]*)\]/.exec(line);
    if (inline) {
      branches.push(...inline[1]!.split(',').map((b) => b.trim().replace(/['"]/g, '')).filter(Boolean));
      seenBranchesKey = true;
      continue;
    }
    if (/^\s*branches:\s*$/.test(line)) {
      seenBranchesKey = true;
      continue;
    }
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (seenBranchesKey && item) branches.push(item[1]!.replace(/['"]/g, ''));
  }

  return seenBranchesKey ? branches : null;
}

export function renderProjectYaml(id: string, derived: DerivedProject): string {
  const lines = [
    'version: 1',
    '',
    'project:',
    `  id: ${id}`,
    '',
    `base_branch: ${derived.baseBranch}`,
    '',
    'validation:',
    ...(derived.setup
      ? [
          '  # A fresh Orca worktree is a new checkout. Without this, every',
          '  # command below fails for reasons unrelated to the change.',
          '  setup:',
          `    command: ${derived.setup.command}`,
          '    required: true',
        ]
      : []),
    '  commands:',
  ];

  if (derived.commands.length === 0) {
    lines.push('    # NONE DERIVED - fill these in. The controller cannot validate without them.');
  }
  for (const cmd of derived.commands) {
    lines.push(`    ${cmd.name}:`, `      command: ${cmd.command}`, `      required: ${cmd.required}`);
  }

  lines.push('', 'risk:', '  high:', '    paths:');
  if (derived.riskPaths.length === 0) lines.push('      []');
  for (const path of derived.riskPaths) lines.push(`      - ${path}`);

  lines.push('', 'knowledge:', '  map: .ai-workflow/knowledge-map.yaml');

  if (derived.notes.length > 0) {
    lines.push('', '# Unresolved during bootstrap:');
    for (const note of derived.notes) lines.push(`#   - ${note}`);
  }

  return `${lines.join('\n')}\n`;
}
