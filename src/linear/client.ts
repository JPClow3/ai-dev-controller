import { LinearClient } from '@linear/sdk';

let cached: LinearClient | null = null;

export class LinearConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearConfigError';
  }
}

/**
 * Linear expresses intent and dependency state. The controller decides what is
 * mechanically runnable.
 */
export function getLinearClient(): LinearClient {
  if (cached) return cached;
  const apiKey = process.env['LINEAR_API_KEY'];
  if (!apiKey) {
    throw new LinearConfigError('LINEAR_API_KEY is not set. Copy .env.example to .env and fill it in.');
  }
  cached = new LinearClient({ apiKey });
  return cached;
}

/** Test seam. */
export function setLinearClient(client: LinearClient | null): void {
  cached = client;
}

/**
 * GraphQL can return data alongside errors. A partially-successful response is
 * treated as a failure: acting on a truncated issue list would look like
 * "these issues no longer need work", which is the wrong direction to be
 * wrong in.
 */
export function assertNoPartialErrors(response: { errors?: unknown[] } | undefined, operation: string): void {
  if (response?.errors && response.errors.length > 0) {
    throw new Error(`Linear ${operation} returned partial errors: ${JSON.stringify(response.errors)}`);
  }
}
