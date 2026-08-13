import type { ControllerDatabase } from './db.js';
import { createIssueRepositories } from './repositories/issues.js';
import { createReviewRepositories } from './repositories/reviews.js';
import { createRunRepositories } from './repositories/runs.js';
import { createScoringRepositories } from './repositories/scoring.js';
import { createSystemRepositories } from './repositories/system.js';
import { createTaskRepositories } from './repositories/tasks.js';

/**
 * Compose the state repositories behind the stable controller-facing API.
 *
 * Each factory owns one cohesive persistence boundary, while callers continue
 * to receive the same single repository object and method names as before.
 */
export function createRepositories(db: ControllerDatabase) {
  return {
    ...createRunRepositories(db),
    ...createIssueRepositories(db),
    ...createTaskRepositories(db),
    ...createScoringRepositories(db),
    ...createReviewRepositories(db),
    ...createSystemRepositories(db),
  };
}

export type ControllerRepositories = ReturnType<typeof createRepositories>;
