import type { ModelAlias } from '../config/routing-schema.js';

/**
 * Two distinct ways the controller uses a model, and they are not
 * interchangeable.
 *
 *   structured  A single request that must return JSON matching a schema.
 *               Curation, planning, failure classification and review are all
 *               this shape. No repository checkout is involved — curation
 *               happens before any worktree exists.
 *
 *   agentic     A coding session inside a worktree, with file access and a
 *               terminal. Only workers need this, and Orca owns it.
 *
 * The original plan only described the agentic path, which left the very first
 * pipeline step — curation — with no way to run.
 */
export type InvocationKind = 'structured' | 'agentic';

export interface StructuredRequest {
  /** Routing alias, e.g. `luna_medium`. Carries model + effort + harness. */
  alias: string;
  /** Prompt file under prompts/, e.g. `curator`. */
  prompt: string;
  /** Rendered into the user message. */
  input: string;
  /** Schema name under schemas/, validated before the result is returned. */
  schema: string;
  /** Hard cap. A structured call that runs long is a failure, not progress. */
  timeoutMs?: number;
  /** Attempts allowed when the model returns unparseable or invalid JSON. */
  maxAttempts?: number;
}

export interface StructuredResult<T = unknown> {
  data: T;
  alias: string;
  attempts: number;
  wallClockMs: number;
  raw: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export class StructuredInvocationError extends Error {
  constructor(
    readonly alias: string,
    readonly attempts: number,
    readonly issues: string[],
    readonly lastRaw: string,
  ) {
    super(
      `Structured call to ${alias} failed after ${attempts} attempt(s):\n  - ${issues.join('\n  - ')}`,
    );
    this.name = 'StructuredInvocationError';
  }
}

/**
 * A way of getting one structured response out of one provider.
 *
 * Kept deliberately narrow so transports can be swapped, mocked, and —
 * importantly — measured against each other, since routing statistics
 * compare aliases across transports.
 */
export interface StructuredTransport {
  readonly name: string;
  supports(alias: ModelAlias): boolean;
  complete(input: {
    alias: ModelAlias;
    system: string;
    user: string;
    timeoutMs: number;
    /**
     * The JSON Schema the reply must satisfy.
     *
     * Passed so a transport can enforce it natively where the provider
     * supports that — Codex via `--output-schema`. Schema-level enforcement is
     * far stronger than asking a model to please only print JSON, and it
     * removes a whole class of retry.
     */
    schema?: object;
  }): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number } }>;
}
