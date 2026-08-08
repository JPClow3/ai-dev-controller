import type { Invoker } from './invoke.js';
import type { RoutingConfig } from '../config/routing-schema.js';
import type { AuthorshipSummary } from '../routing/types.js';
import { selectReviewer } from '../routing/selector.js';

/**
 * Binds each agent role to its prompt, its schema, and the routing role that
 * chooses its model.
 *
 * Without this table the prompts and schemas exist but are unreachable: the
 * invoker takes a prompt name and a schema name, and nothing was supplying
 * them. This is the missing glue between "we wrote a curator prompt" and
 * "something curates".
 */
export const AGENT_ROLES = {
  curator: { prompt: 'curator', schema: 'curated-issue', routingRole: 'issue_cleanup' },
  planner: { prompt: 'planner', schema: 'implementation-plan', routingRole: 'orchestrator' },
  classifier: { prompt: 'failure-classifier', schema: 'failure', routingRole: 'issue_cleanup' },
  integrationReviewer: {
    prompt: 'integration-reviewer',
    schema: 'review',
    routingRole: 'orchestrator',
  },
  finalReviewer: { prompt: 'final-reviewer', schema: 'review', routingRole: 'orchestrator' },
  // `knowledge-bootstrap` is deliberately absent: bootstrap currently derives
  // project.yaml deterministically from package scripts and CI, with no model
  // call and therefore no response schema. Adding it here would imply a
  // capability that does not exist.
} as const;

export type AgentRole = keyof typeof AGENT_ROLES;

export interface RoleCallOptions {
  alias: string;
  input: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

export function createAgents(invoker: Invoker, routing: RoutingConfig) {
  async function call<T>(role: AgentRole, options: RoleCallOptions): Promise<T> {
    const spec = AGENT_ROLES[role];
    const result = await invoker.structured<T>({
      alias: options.alias,
      prompt: spec.prompt,
      schema: spec.schema,
      input: options.input,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    });
    return result.data;
  }

  return {
    call,

    /** Turns a rough issue into a structured engineering contract. */
    curate: <T>(alias: string, rawIssue: string) => call<T>('curator', { alias, input: rawIssue }),

    /** Decomposes a curated issue into internal tasks with disjoint ownership. */
    plan: <T>(alias: string, contract: string) =>
      call<T>('planner', { alias, input: contract, timeoutMs: 300_000 }),

    /** Diagnoses a failure. The controller decides what is legal afterwards. */
    classifyFailure: <T>(alias: string, evidence: string) =>
      call<T>('classifier', { alias, input: evidence }),

    /** Reviews the integrated diff for seams between workers. */
    reviewIntegration: <T>(alias: string, packet: string) =>
      call<T>('integrationReviewer', { alias, input: packet, timeoutMs: 300_000 }),

    /**
     * Independent final review.
     *
     * The alias is chosen from the family least involved in authoring the
     * change, so a family never grades its own homework.
     */
    reviewFinal: <T>(authorship: AuthorshipSummary, candidates: string[], packet: string) => {
      const alias = selectReviewer(authorship, candidates, routing, 'least_involved_family');
      return call<T>('finalReviewer', { alias, input: packet, timeoutMs: 300_000 }).then((data) => ({
        alias,
        data,
      }));
    },
  };
}

export type Agents = ReturnType<typeof createAgents>;

/**
 * Aliases eligible to review, i.e. every alias a role could route to.
 *
 * Reviewer choice is deliberately drawn from the full routable set rather than
 * a fixed list, so retiring a model from `routing.yaml` also removes it as a
 * reviewer.
 */
export function reviewerCandidates(routing: RoutingConfig): string[] {
  const routable = new Set<string>();
  for (const role of Object.values(routing.roles)) {
    routable.add(role.champion);
    for (const challenger of role.challengers) routable.add(challenger);
  }
  return [...routable];
}
