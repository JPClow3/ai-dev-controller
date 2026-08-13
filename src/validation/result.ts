export interface ValidationCommand {
  name: string;
  command: string;
  required: boolean;
}

export interface CommandOutcome {
  name: string;
  command: string;
  exitCode: number;
  passed: boolean;
  required: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
  /** Set when the controller refused to execute the repository command. */
  safetyViolation?: string;
}

export interface ValidationSummary {
  passed: boolean;
  results: CommandOutcome[];
  failedRequired: string[];
}

/**
 * Evidence, not opinion.
 *
 * `passed` is derived only from process exit codes. A worker reporting "all
 * tests pass" contributes nothing here — the controller never accepts an LLM
 * claim as validation.
 */
export function summarise(results: CommandOutcome[]): ValidationSummary {
  // A safety refusal is a failed gate even when the repository marked the
  // command optional.  Otherwise a contract could hide a forbidden command
  // behind `required: false`, the controller would skip execution, and the
  // run could still proceed as green.
  const failedRequired = results
    .filter((r) => (r.required || r.safetyViolation !== undefined) && !r.passed)
    .map((r) => r.name);
  return { passed: failedRequired.length === 0, results, failedRequired };
}

export function tail(text: string, lines = 40): string {
  const split = text.split('\n');
  return split.length <= lines ? text : split.slice(-lines).join('\n');
}
