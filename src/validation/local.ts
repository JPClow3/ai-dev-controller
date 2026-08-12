import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { summarise, tail, type CommandOutcome, type ValidationCommand, type ValidationSummary } from './result.js';

/**
 * The repository declares what validation means. The central controller must
 * never contain "run pytest for Python" — it asks the repository.
 */
interface ProjectYaml {
  validation?: {
    setup?: { command?: string; required?: boolean } | null;
    commands?: Record<string, { command?: string; required?: boolean }>;
  };
}

function readProjectYaml(repoPath: string): ProjectYaml | null {
  const path = join(repoPath, '.ai-workflow/project.yaml');
  if (!existsSync(path)) return null;
  return parse(readFileSync(path, 'utf8')) as ProjectYaml | null;
}

export function readValidationCommands(repoPath: string): ValidationCommand[] {
  const commands = readProjectYaml(repoPath)?.validation?.commands ?? {};
  return Object.entries(commands)
    .filter(([, spec]) => typeof spec?.command === 'string' && spec.command.length > 0)
    .map(([name, spec]) => ({
      name,
      command: spec.command as string,
      required: spec.required !== false,
    }));
}

/**
 * How the repository prepares a fresh worktree before validation.
 *
 * Orca worktrees are new checkouts with no `node_modules`, no virtualenv and
 * no build cache, so `npm run typecheck` in one fails for a reason that has
 * nothing to do with the change under test. The repository declares its own
 * preparation for the same reason it declares its own validation: the central
 * controller must not know that this project happens to use npm.
 */
export function readSetupCommand(repoPath: string): ValidationCommand | null {
  const setup = readProjectYaml(repoPath)?.validation?.setup;
  if (!setup?.command) return null;
  return { name: 'setup', command: setup.command, required: setup.required !== false };
}

/**
 * A fresh linked worktree has no dependencies. Repository configuration wins,
 * but a lockfile makes one package-manager setup command deterministic enough
 * to infer safely when the bootstrap contract omitted it.
 */
export function readEffectiveSetupCommand(repoPath: string): ValidationCommand | null {
  const declared = readSetupCommand(repoPath);
  if (declared) return declared;

  const inferred = [
    existsSync(join(repoPath, 'package-lock.json')) && 'npm ci',
    existsSync(join(repoPath, 'pnpm-lock.yaml')) && 'pnpm install --frozen-lockfile',
    existsSync(join(repoPath, 'yarn.lock')) && 'yarn install --immutable',
  ].filter((command): command is string => Boolean(command));
  if (inferred.length !== 1) return null;
  return { name: 'setup', command: inferred[0]!, required: true };
}

export interface RunnerDeps {
  exec?: (
    command: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
}

const defaultExec: NonNullable<RunnerDeps['exec']> = async (command, cwd, timeoutMs) => {
  try {
    const result = await execa(command, { cwd, shell: true, timeout: timeoutMs, reject: false });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: result.timedOut === true,
    };
  } catch (err) {
    const e = err as { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean };
    return {
      exitCode: e.exitCode ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(err),
      timedOut: e.timedOut === true,
    };
  }
};

/**
 * Runs the repository's declared validation in the parent worktree.
 *
 * Every command runs even after one fails: a worker fixing three problems at
 * once needs to see all three, and stopping early would hide two of them until
 * the next remediation cycle.
 */
export async function runRequiredValidation(
  repoPath: string,
  commands: ValidationCommand[],
  options: { timeoutMs?: number } & RunnerDeps = {},
): Promise<ValidationSummary> {
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const results: CommandOutcome[] = [];

  for (const spec of commands) {
    const started = Date.now();
    const outcome = await exec(spec.command, repoPath, timeoutMs);
    results.push({
      name: spec.name,
      command: spec.command,
      exitCode: outcome.exitCode,
      passed: outcome.exitCode === 0 && !outcome.timedOut,
      required: spec.required,
      durationMs: Date.now() - started,
      stdoutTail: tail(outcome.stdout),
      stderrTail: tail(outcome.stderr),
      timedOut: outcome.timedOut,
    });
  }

  return summarise(results);
}

/** Formats failures into the smallest useful remediation packet. */
export function failureDigest(summary: ValidationSummary): string {
  return summary.results
    .filter((r) => !r.passed)
    .map((r) =>
      [
        `### ${r.name} (exit ${r.exitCode}${r.timedOut ? ', TIMED OUT' : ''})`,
        `\`${r.command}\``,
        '',
        r.stderrTail || r.stdoutTail,
      ].join('\n'),
    )
    .join('\n\n');
}
