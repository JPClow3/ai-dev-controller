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
  let packageManager: DerivedProject['packageManager'] = 'unknown';

  const pkgPath = join(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    packageManager = detectNodePackageManager(repoPath);
    const scripts = readScripts(pkgPath);
    const runner = `${packageManager} run`;

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

  return { baseBranch, commands, riskPaths, packageManager, notes };
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
export function detectCiTrigger(repoPath: string): 'pull_request' | 'branch_push' | 'none' {
  const dir = join(repoPath, '.github/workflows');
  if (!existsSync(dir)) return 'none';
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f));
  if (files.length === 0) return 'none';

  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const on = /^on:\s*([\s\S]*?)(?=^\S)/m.exec(text)?.[1] ?? '';
    if (on.includes('pull_request')) return 'pull_request';
  }
  return 'branch_push';
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
