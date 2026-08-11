import type { RepositoryResolution } from '../curation/curate.js';
import { AI_LIFECYCLE_LABELS, type AiLifecycleLabel } from '../workflow/states.js';
import type { NewlyCreatedLinearIssue } from './issues.js';

export const AUTO_CURATE_CURSOR_KEY = 'linear.auto_curate_after';

export interface AutoCurateDeps {
  getCursor: () => string | null;
  setCursor: (value: string) => void;
  fetchIssues: (afterExclusive: string, throughInclusive: string) => Promise<NewlyCreatedLinearIssue[]>;
  resolveRepository: (issue: NewlyCreatedLinearIssue) => RepositoryResolution;
  setLifecycle: (identifier: string, label: AiLifecycleLabel) => Promise<void>;
  requestContext: (identifier: string, message: string, candidates?: string[]) => Promise<void>;
}

export interface AutoCurateReport {
  adopted: string[];
  needsContext: string[];
  skipped: string[];
}

/**
 * Adopts newly-created Linear issues into the autonomous lifecycle.
 *
 * The first call only establishes a durable watermark, deliberately avoiding
 * a surprise sweep of the existing backlog. Later calls advance the cursor
 * only after the whole closed window succeeds; lifecycle labels make retries
 * idempotent if the process exits before the cursor write.
 */
export async function autoCurateNewIssues(
  deps: AutoCurateDeps,
  now = new Date(),
): Promise<AutoCurateReport> {
  const throughInclusive = now.toISOString();
  const afterExclusive = deps.getCursor();
  const report: AutoCurateReport = { adopted: [], needsContext: [], skipped: [] };

  if (!afterExclusive) {
    deps.setCursor(throughInclusive);
    return report;
  }

  const lifecycle = new Set<string>(AI_LIFECYCLE_LABELS);
  for (const issue of await deps.fetchIssues(afterExclusive, throughInclusive)) {
    if (issue.labels.some((label) => lifecycle.has(label))) {
      report.skipped.push(issue.identifier);
      continue;
    }

    const resolution = deps.resolveRepository(issue);
    if (!resolution.ok) {
      await deps.requestContext(issue.identifier, resolution.message, resolution.candidates);
      await deps.setLifecycle(issue.identifier, 'ai-needs-context');
      report.needsContext.push(issue.identifier);
      continue;
    }

    await deps.setLifecycle(issue.identifier, 'ai-curate');
    report.adopted.push(issue.identifier);
  }

  deps.setCursor(throughInclusive);
  return report;
}
