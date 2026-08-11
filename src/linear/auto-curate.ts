import type { RepositoryResolution } from '../curation/curate.js';
import { AI_LIFECYCLE_LABELS, type AiLifecycleLabel } from '../workflow/states.js';
import type { NewlyCreatedLinearIssue } from './issues.js';

export const AUTO_CURATE_CURSOR_KEY = 'linear.auto_curate_after';
export const AUTO_CURATE_FLOOR_KEY = 'linear.auto_curate_floor';
const CURSOR_OVERLAP_MS = 10 * 60 * 1_000;

export interface AutoCurateDeps {
  getCursor: () => string | null;
  setCursor: (value: string) => void;
  /** The first-run boundary, kept so overlap never adopts historical work. */
  getFloor?: () => string | null;
  setFloor?: (value: string) => void;
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
 * only after the whole closed window succeeds. Each subsequent query overlaps
 * the previous cursor by ten minutes, which absorbs Linear's transient index
 * visibility lag; the first-run floor prevents that overlap from importing the
 * historical backlog. Lifecycle labels make overlap retries idempotent.
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
    deps.setFloor?.(throughInclusive);
    return report;
  }

  const cursorTime = Date.parse(afterExclusive);
  if (!Number.isFinite(cursorTime)) throw new Error(`Invalid auto-curate cursor: ${afterExclusive}`);
  const persistedFloor = deps.getFloor?.();
  const storedFloor = persistedFloor ?? afterExclusive;
  const floorTime = Date.parse(storedFloor);
  if (!Number.isFinite(floorTime)) throw new Error(`Invalid auto-curate floor: ${storedFloor}`);
  if (!persistedFloor) deps.setFloor?.(storedFloor);
  const queryAfter = new Date(Math.max(floorTime, cursorTime - CURSOR_OVERLAP_MS)).toISOString();

  const lifecycle = new Set<string>(AI_LIFECYCLE_LABELS);
  for (const issue of await deps.fetchIssues(queryAfter, throughInclusive)) {
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
