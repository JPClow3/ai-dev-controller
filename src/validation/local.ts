import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { summarise, tail, type CommandOutcome, type ValidationCommand, type ValidationSummary } from './result.js';
import {
  createValidationSafetyPolicy,
  DEFAULT_FORBIDDEN_OPERATIONS,
  type ForbiddenOperation,
} from './safety.js';

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

export type ReadAtBaseSha = (
  repoPath: string,
  baseSha: string,
  relativePath: string,
) => Promise<string | null> | string | null;

export interface BaseShaReadOptions {
  /** Optional testable reader; production defaults to `git show <sha>:<path>`. */
  readAtBaseSha?: ReadAtBaseSha;
}

export interface ValidationContract {
  /** A contract read from a commit is immutable for the duration of a run. */
  source: 'base-sha' | 'working-tree' | 'none';
  setup: ValidationCommand | null;
  commands: ValidationCommand[];
}

function readProjectYaml(repoPath: string): ProjectYaml | null {
  const path = join(repoPath, '.ai-workflow/project.yaml');
  if (!existsSync(path)) return null;
  return parseProjectYaml(readFileSync(path, 'utf8'));
}

function parseProjectYaml(raw: string): ProjectYaml | null {
  try {
    return parse(raw) as ProjectYaml | null;
  } catch {
    // A malformed contract is not a reason to execute a guessed command. The
    // caller sees no commands and the workflow's existing no-validation gate
    // blocks the run.
    return null;
  }
}

function commandsFromProjectYaml(project: ProjectYaml | null): ValidationCommand[] {
  const commands = project?.validation?.commands ?? {};
  return Object.entries(commands)
    .filter(([, spec]) => typeof spec?.command === 'string' && spec.command.length > 0)
    .map(([name, spec]) => ({
      name,
      command: spec.command as string,
      required: spec.required !== false,
    }));
}

function setupFromProjectYaml(project: ProjectYaml | null): ValidationCommand | null {
  const setup = project?.validation?.setup;
  if (!setup?.command) return null;
  return { name: 'setup', command: setup.command, required: setup.required !== false };
}

function validBaseSha(baseSha: string): boolean {
  // A base SHA must be an object name, never a shell fragment or an arbitrary
  // branch supplied by repository configuration.  Git accepts abbreviated SHAs
  // and the controller records full ones; accepting 7..64 hex characters
  // keeps both forms useful without allowing ref traversal.
  return /^[0-9a-f]{7,64}$/i.test(baseSha);
}

async function defaultReadAtBaseSha(repoPath: string, baseSha: string, relativePath: string): Promise<string | null> {
  if (!validBaseSha(baseSha)) return null;
  try {
    const result = await execa('git', ['show', `${baseSha}:${relativePath}`], {
      cwd: repoPath,
      reject: false,
    });
    if ((result.exitCode ?? 1) !== 0) return null;
    return result.stdout ?? '';
  } catch {
    return null;
  }
}

export function readValidationCommands(repoPath: string): ValidationCommand[] {
  return commandsFromProjectYaml(readProjectYaml(repoPath));
}

/**
 * Reads the validation contract from the immutable base commit.
 *
 * The working tree is intentionally not a fallback when a base SHA was
 * supplied. A missing or malformed base contract returns `source: 'none'` so
 * the workflow's existing no-validation gate blocks rather than executing a
 * command that appeared only after a worker started.
 */
export async function readValidationContractAtBaseSha(
  repoPath: string,
  baseSha: string,
  options: BaseShaReadOptions = {},
): Promise<ValidationContract> {
  if (!validBaseSha(baseSha)) {
    return { source: 'none', setup: null, commands: [] };
  }
  const readAtBaseSha = options.readAtBaseSha ?? defaultReadAtBaseSha;
  let raw: string | null;
  try {
    raw = await readAtBaseSha(repoPath, baseSha, '.ai-workflow/project.yaml');
  } catch {
    return { source: 'none', setup: null, commands: [] };
  }
  if (typeof raw !== 'string') return { source: 'none', setup: null, commands: [] };
  const project = parseProjectYaml(raw);
  if (!project) return { source: 'none', setup: null, commands: [] };
  return {
    source: 'base-sha',
    setup: setupFromProjectYaml(project),
    commands: commandsFromProjectYaml(project),
  };
}

export async function readValidationCommandsAtBaseSha(
  repoPath: string,
  baseSha: string,
  options: BaseShaReadOptions = {},
): Promise<ValidationCommand[]> {
  return (await readValidationContractAtBaseSha(repoPath, baseSha, options)).commands;
}

export async function readEffectiveSetupCommandAtBaseSha(
  repoPath: string,
  baseSha: string,
  options: BaseShaReadOptions = {},
): Promise<ValidationCommand | null> {
  const contract = await readValidationContractAtBaseSha(repoPath, baseSha, options);
  if (contract.source !== 'base-sha') return null;
  if (contract.setup) return contract.setup;

  const readAtBaseSha = options.readAtBaseSha ?? defaultReadAtBaseSha;
  const inferred = [
    ['package-lock.json', 'npm ci'],
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn install --immutable'],
  ] as const;
  const present: string[] = [];
  for (const [path, command] of inferred) {
    try {
      if (typeof (await readAtBaseSha(repoPath, baseSha, path)) === 'string') present.push(command);
    } catch {
      // Unknown base contents are not inferred as a setup command.
      return null;
    }
  }
  if (present.length !== 1) return null;
  return { name: 'setup', command: present[0]!, required: true };
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
  options: {
    timeoutMs?: number;
    safety?: readonly ForbiddenOperation[];
    /** Carries provenance into logs/call sites; command screening is local. */
    baseSha?: string;
  } & RunnerDeps = {},
): Promise<ValidationSummary> {
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const safety = createValidationSafetyPolicy(options.safety ?? DEFAULT_FORBIDDEN_OPERATIONS);
  const results: CommandOutcome[] = [];

  for (const spec of commands) {
    const started = Date.now();
    const violation = spec.command.trim().length === 0
      ? { operation: 'validation_command_empty', reason: 'validation command is empty' }
      : safety.violation(spec.command);
    if (violation) {
      // Safety refusals are represented as evidence rather than thrown out of
      // the workflow. This lets the orchestrator persist the reason and move
      // the run to its normal remediation/blocker path while guaranteeing the
      // shell is never reached.
      results.push({
        name: spec.name,
        command: spec.command,
        exitCode: 126,
        passed: false,
        required: spec.required,
        durationMs: Date.now() - started,
        stdoutTail: '',
        stderrTail: `Refused unsafe validation command (${violation.operation}): ${violation.reason}`,
        timedOut: false,
        safetyViolation: violation.operation,
      });
      continue;
    }
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
        r.safetyViolation
          ? `Safety policy: ${r.safetyViolation}\n${r.stderrTail}`
          : r.stderrTail || r.stdoutTail,
      ].join('\n'),
    )
    .join('\n\n');
}
