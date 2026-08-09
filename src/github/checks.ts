import type { GitHub } from './client.js';

export interface CheckRun {
  name: string;
  state: string;
  conclusion: string | null;
  required: boolean;
  detailsUrl?: string;
  githubRunId?: number;
}

export interface ChecksSummary {
  headSha: string;
  complete: boolean;
  allRequiredPassed: boolean;
  checks: CheckRun[];
  pending: string[];
  failed: string[];
}

/**
 * The two shapes `statusCheckRollup` returns.
 *
 * `CheckRun` (GitHub Actions and every modern app) reports `status` plus
 * `conclusion`. `StatusContext` (the legacy commit-status API) reports
 * `state`, and names itself `context` rather than `name`. Reading only
 * `state` — as this did — meant every Actions check evaluated to PENDING
 * forever, so `complete` was never true and the run sat in CI indefinitely
 * with all five checks long since finished.
 */
interface GhCheck {
  __typename?: 'CheckRun' | 'StatusContext';
  name?: string;
  context?: string;
  /** CheckRun: QUEUED | IN_PROGRESS | COMPLETED */
  status?: string;
  /** CheckRun, only once COMPLETED: SUCCESS | FAILURE | SKIPPED | ... */
  conclusion?: string;
  /** StatusContext: PENDING | SUCCESS | FAILURE | ERROR */
  state?: string;
  bucket?: string;
  detailsUrl?: string;
  workflow?: string;
}

const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED']);

/**
 * One check's outcome, whichever shape it arrived in.
 *
 * A completed check with no conclusion is treated as pending rather than as a
 * pass: an absent conclusion is missing information, and the one thing this
 * function must never do is invent a green.
 */
export function checkState(check: GhCheck): string {
  if (check.status !== undefined) {
    const status = check.status.toUpperCase();
    if (status !== 'COMPLETED') return status;
    return check.conclusion?.toUpperCase() ?? 'PENDING';
  }
  return (check.state ?? check.bucket ?? 'PENDING').toUpperCase();
}

/**
 * Reads check runs for a pull request.
 *
 * GitHub Actions is the final mechanical authority. The orchestrator may run
 * tests locally, but a PR is not completed until these say so.
 *
 * `requiredChecks` comes from the repository registry. When it is empty, every
 * check is treated as required — the safe default, since silently ignoring an
 * unlisted failing check is exactly the wrong way to be wrong.
 */
export async function readChecks(
  gh: GitHub,
  slug: string,
  prNumber: number,
  requiredChecks: string[] = [],
): Promise<ChecksSummary> {
  const raw = await gh.api<{ headSha?: string; statusCheckRollup?: GhCheck[] }>([
    'pr',
    'view',
    String(prNumber),
    '--repo',
    slug,
    '--json',
    'headRefOid,statusCheckRollup',
  ]);

  const headSha = (raw as unknown as { headRefOid?: string }).headRefOid ?? raw.headSha ?? '';
  const rollup = raw.statusCheckRollup ?? [];
  const requiredSet = new Set(requiredChecks);

  const checks: CheckRun[] = rollup.map((c) => {
    const state = checkState(c);
    const name = c.name ?? c.context ?? '(unnamed check)';
    const runId = c.detailsUrl?.match(/\/actions\/runs\/(\d+)/)?.[1];
    return {
      name,
      state,
      conclusion: PENDING.has(state) ? null : state,
      required: requiredSet.size === 0 ? true : requiredSet.has(name),
      ...(c.detailsUrl ? { detailsUrl: c.detailsUrl } : {}),
      ...(runId ? { githubRunId: Number(runId) } : {}),
    };
  });

  const required = checks.filter((c) => c.required);
  const observedNames = new Set(checks.map((check) => check.name));
  const missing = requiredChecks
    .filter((name) => !observedNames.has(name))
    .map((name) => `${name} (not reported)`);
  const pending = [...required.filter((c) => PENDING.has(c.state)).map((c) => c.name), ...missing];
  const failed = required.filter((c) => !PENDING.has(c.state) && !PASSING.has(c.state)).map((c) => c.name);

  // An empty rollup is "not started", not "finished with nothing". GitHub
  // reports no checks for the first seconds after a PR opens, and calling that
  // complete-and-not-passed sent the run straight to REMEDIATING with an empty
  // list of failures — remediating a CI result that did not exist yet.
  const notStarted = required.length === 0 && missing.length === 0;

  return {
    headSha,
    complete: !notStarted && pending.length === 0,
    // No checks at all is NOT a pass either: it can mean the workflow never
    // triggers on this branch, which is the failure mode PR_DRAFT_OPEN exists
    // for. Neither passed nor complete leaves the run waiting, visibly.
    allRequiredPassed: pending.length === 0 && failed.length === 0 && !notStarted,
    checks,
    pending: notStarted ? ['(no checks reported yet)'] : pending,
    failed,
  };
}

/** Names failing checks for the remediation packet. */
export async function failedCheckLogs(
  gh: GitHub,
  slug: string,
  prNumber: number,
  failedNames: string[],
): Promise<string> {
  if (failedNames.length === 0) return '';
  try {
    const out = await gh.api<unknown>(['pr', 'checks', String(prNumber), '--repo', slug, '--json', 'name,link,state']);
    return JSON.stringify(out, null, 2);
  } catch {
    return `Failed checks: ${failedNames.join(', ')}`;
  }
}
