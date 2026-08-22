/**
 * Safety policy for repository-defined validation commands.
 *
 * Validation commands are intentionally declared by the repository, but they
 * still execute with the controller's credentials.  A repository contract is
 * therefore not a permission grant: commands are screened immediately before
 * they are executed. Commands have a deliberately small argv-only shape; the
 * controller never hands repository configuration to a shell. The operation
 * checks below remain defence in depth for commands whose intent is unsafe.
 */

export const DEFAULT_FORBIDDEN_OPERATIONS = [
  'production_database_mutation',
  'production_deployment',
  'remote_resource_deletion',
  'production_secret_rotation',
  'force_push_protected_branch',
  'pr_merge',
  'branch_protection_change',
  'destructive_cloud_operation',
] as const;

export type ForbiddenOperation = string;

export interface SafetyViolation {
  operation: ForbiddenOperation;
  reason: string;
}

export class ValidationSafetyError extends Error {
  constructor(readonly violation: SafetyViolation) {
    super(`Refused unsafe validation command (${violation.operation}): ${violation.reason}`);
    this.name = 'ValidationSafetyError';
  }
}

export interface SafeValidationCommand {
  file: string;
  args: string[];
}

const ALLOWED_VALIDATION_EXECUTABLES = new Set([
  'npm', 'npm.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd',
  'node', 'node.exe',
  'python', 'python.exe', 'python3', 'python3.exe', 'py', 'py.exe',
  'pytest', 'pytest.exe', 'ruff', 'ruff.exe',
  'tsc', 'tsc.cmd', 'vitest', 'vitest.cmd', 'eslint', 'eslint.cmd',
  'biome', 'biome.exe', 'oxlint', 'oxlint.exe',
  'cargo', 'cargo.exe', 'go', 'go.exe', 'dotnet', 'dotnet.exe',
  'mvn', 'mvn.cmd', 'gradle', 'gradle.bat', 'gradlew', 'gradlew.bat',
  'php', 'php.exe', 'composer', 'composer.bat', 'ruby', 'ruby.exe', 'bundle', 'bundle.bat',
]);

/**
 * Parses the narrow command language accepted from a repository contract.
 *
 * Quotes only group an argv value; they never gain shell semantics. Rejecting
 * shell control syntax makes `git" "push`, backticks, `$()` and appended
 * statements fail closed even if a future forbidden-operation matcher misses
 * one of them.
 */
export function parseSafeValidationCommand(command: string): SafeValidationCommand | null {
  if (!command.trim() || /[\r\n;&|<>`$(){}]/.test(command)) return null;

  const args: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | null = null;
  let tokenStarted = false;

  for (const character of command) {
    if (quote === 'single') {
      if (character === "'") quote = null;
      else token += character;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = null;
      else token += character;
      continue;
    }
    if (character === "'") {
      quote = 'single';
      tokenStarted = true;
    } else if (character === '"') {
      quote = 'double';
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        args.push(token);
        token = '';
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }
  if (quote !== null || !tokenStarted) return null;
  args.push(token);

  const [file, ...argv] = args;
  if (!file || !ALLOWED_VALIDATION_EXECUTABLES.has(file.toLowerCase())) return null;
  return { file, args: argv };
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasToken(command: string, token: string): boolean {
  // A command is shell syntax, not a plain argv array.  Treat punctuation
  // commonly used as command separators as a token boundary so `foo;git
  // merge` and `foo&&git merge` are both inspected.
  return new RegExp(`(?:^|[\\s;&|()<>])${escaped(token)}(?=$|[\\s;&|()<>])`, 'i').test(command);
}

function normalizeShellSeparators(command: string): string {
  // `$IFS` is the shell's standard whitespace indirection and is a common
  // way to evade a token-boundary check (`git${IFS}push`). We do not attempt
  // to interpret arbitrary shell code here; normalising this separator keeps
  // the deny-list fail-closed without turning validation into a shell parser.
  return command.replace(/\$(?:\{)?IFS(?:\})?/gi, ' ');
}

function productionTarget(command: string): boolean {
  // Keep this deliberately narrow. `NODE_ENV=production npm test` is a
  // legitimate validation command; only a production-looking target paired
  // with a mutation is dangerous.
  return /(?:^|[\\s:=/_-])(?:production|prod)(?:$|[\\s./:_-])/i.test(command)
    || /(?:database|db|postgres|mysql|redis)[^\\n]{0,80}(?:production|prod)/i.test(command)
    || /(?:production|prod)[^\\n]{0,80}(?:database|db|postgres|mysql|redis)/i.test(command);
}

function mutatingDatabaseAction(command: string): boolean {
  return /(?:\b(?:migrate|migration|db\s+(?:push|reset|seed)|schema\s+(?:push|apply)|(?:drop|truncate|alter|create|insert|update|delete)\b|terraform\s+apply|pulumi\s+up)\b)/i.test(
    command,
  );
}

function matchesKnownOperation(operation: string, command: string): boolean {
  command = normalizeShellSeparators(command);
  // A repository may intentionally use the canonical policy name as a script
  // label (for example `production_deployment`). Treat that as an explicit
  // request for the forbidden operation; it is safer than trying to infer an
  // operator's intent from the remainder of the shell line.
  if (command.toLowerCase().includes(operation.toLowerCase())) return true;

  switch (operation) {
    case 'production_database_mutation':
      return productionTarget(command) && mutatingDatabaseAction(command);

    case 'production_deployment':
      return /(?:\b(?:wrangler|vercel|netlify|railway|fly|heroku|serverless)\s+(?:deploy|release|publish|up)\b|\b(?:npm|pnpm|yarn)\s+publish\b|(?:^|[\s;&|])(?:deploy|release)(?:[\s;&|]|$)|--prod(?:uction)?(?:[\s;&|]|$))/i.test(
        command,
      );

    case 'remote_resource_deletion':
      return /(?:\b(?:aws|az|gcloud|gsutil|kubectl|helm|wrangler|terraform|pulumi|fly|heroku|railway|vercel|netlify|rclone)(?:\.exe)?\s+[^\n;&|]*\b(?:delete|destroy|remove|terminate|rm|purge|prune)\b|\bterraform\s+destroy\b|\b(?:wrangler|kubectl)\s+delete\b|\bgh\b[^\n;&|]*\brepo\s+delete\b|\bgit(?:\s+[-a-z]+(?:\s+[^\s;&|]+)?)*\s+push\b[^\n;&|]*\s--delete(?:[=\s]|$))/i.test(
        command,
      );

    case 'production_secret_rotation':
      return /(?:\bproduction[_\s-]+(?:secret|credential)[_\s-]+(?:rotate|rotation)\b|\b(?:rotate|rotation)\b[^\n;&|]*\b(?:secret|credential|token|key)\b|\b(?:secret|credential|token|key)\b[^\n;&|]*\b(?:rotate|rotation)\b|\b(?:gh|wrangler)\b[^\n;&|]*\bsecret\b[^\n;&|]*\b(?:set|put|update|rotate)\b|\b(?:az\s+keyvault|aws\s+secretsmanager|gcloud\s+secrets)\b[^\n;&|]*\b(?:set|put|update|rotate)\b)/i.test(
        command,
      ) && (productionTarget(command) || /\b(?:gh|wrangler|az|aws|gcloud)\b/i.test(command));

    case 'force_push_protected_branch':
      return /(?:\bgit(?:\s+[-a-z]+(?:\s+[^\s;&|]+)?)*\s+push\b[^\n;&|]*(?:--force(?:-with-lease)?(?:[=\s]|$)|(?:^|[\s])-[a-z]*f[a-z]*(?:[\s]|$)))/i.test(
        command,
      );

    case 'pr_merge':
      return /(?:\b(?:gh|glab)\b[^\n;&|]*\b(?:pr|mr)\s+merge\b|\bhub\s+pull-request\s+merge\b|\bgit(?:\s+[-a-z]+(?:\s+[^\s;&|]+)?)*\s+(?:merge|rebase)\b|\b(?:merge|squash)\s+pull\s+request\b)/i.test(
        command,
      );

    case 'branch_protection_change':
      return /(?:\b(?:branch[-_ ]protection|protected[-_ ]branch|ruleset)\b|\bgh\b[^\n;&|]*(?:protection|rulesets|enforce_admins|delete_branch_on_merge)\b)/i.test(
        command,
      );

    case 'destructive_cloud_operation':
      return /(?:\b(?:aws|az|gcloud|gsutil|kubectl|helm|wrangler|terraform|pulumi|fly|heroku|railway|vercel|netlify|rclone)(?:\.exe)?\s+[^\n;&|]*\b(?:delete|destroy|remove|terminate|rm|purge|prune|scale\s+to\s+zero)\b|\bterraform\s+destroy\b|\bdocker\s+system\s+prune\b)/i.test(
        command,
      );

    default:
      // Config can contain an operator-specific forbidden operation.  Unknown
      // names are still enforced as literals instead of silently widening the
      // permission surface.  A future operation can therefore be introduced
      // before the central controller learns a richer matcher.
      return hasToken(command, operation) || command.toLowerCase().includes(operation.toLowerCase());
  }
}

/**
 * Builds a policy checker.  An omitted list means the controller's complete
 * built-in policy; an explicitly empty list is rejected by `assertSafe...`
 * rather than treated as permission to execute everything.
 */
export function createValidationSafetyPolicy(
  forbiddenOperations: readonly ForbiddenOperation[] = DEFAULT_FORBIDDEN_OPERATIONS,
): {
  forbiddenOperations: readonly ForbiddenOperation[];
  violation(command: string): SafetyViolation | null;
} {
  const operations = forbiddenOperations
    .map((operation) => operation.trim())
    .filter(Boolean);

  return {
    forbiddenOperations: operations,
    violation(command: string): SafetyViolation | null {
      if (operations.length === 0) {
        return {
          operation: 'safety_policy_missing',
          reason: 'no forbidden-operation policy was configured',
        };
      }

      const parsed = parseSafeValidationCommand(command);
      // Quoting can be meaningful for an argument (for example a test name),
      // but it must not be able to split a forbidden operation into pieces.
      // Check the original spelling and the argv-normalised spelling.
      const normalised = parsed ? [parsed.file, ...parsed.args].join(' ') : command;
      for (const operation of operations) {
        if (matchesKnownOperation(operation, command) || matchesKnownOperation(operation, normalised)) {
          return {
            operation,
            reason: `command matches the ${operation} safety boundary`,
          };
        }
      }
      if (!parsed) {
        return {
          operation: 'validation_command_not_allowed',
          reason: 'command must use an approved validation executable with argv-only arguments',
        };
      }
      return null;
    },
  };
}

/** Throws when a validation command would cross a configured safety boundary. */
export function assertSafeValidationCommand(
  command: string,
  forbiddenOperations: readonly ForbiddenOperation[] = DEFAULT_FORBIDDEN_OPERATIONS,
): void {
  const violation = createValidationSafetyPolicy(forbiddenOperations).violation(command);
  if (violation) throw new ValidationSafetyError(violation);
}
