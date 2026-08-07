/**
 * Dependency waves.
 *
 * THE RULE, and the reason this module exists: a dependency is satisfied only
 * when its prerequisite PR has been MERGED into the configured base branch.
 *
 * Not when the worker finished. Not when tests passed. Not when the PR opened.
 * Not when a reviewer approved. Merged.
 *
 * Anything looser lets wave 2 start against assumptions wave 1 has not yet
 * actually committed to the base branch.
 */

export interface SchedulableIssue {
  identifier: string;
  /** Explicit, human-approved Linear blockers only. */
  blockedBy: string[];
  /** True only once this issue's PR is merged into the base branch. */
  merged: boolean;
  ready: boolean;
}

export interface ReadyWave {
  wave: number;
  issues: string[];
  blocked: Array<{ identifier: string; waitingOn: string[] }>;
}

function indexBy(issues: SchedulableIssue[]): Map<string, SchedulableIssue> {
  return new Map(issues.map((i) => [i.identifier, i]));
}

/**
 * Blockers not yet merged.
 *
 * A blocker the controller has never heard of counts as unsatisfied. Silently
 * treating an unknown identifier as "fine" would let a typo unblock work.
 */
export function unsatisfiedBlockers(issue: SchedulableIssue, all: Map<string, SchedulableIssue>): string[] {
  return issue.blockedBy.filter((id) => {
    const blocker = all.get(id);
    if (!blocker) return true;
    return !blocker.merged;
  });
}

/** Issues eligible to start now: labelled ready, unmerged, all blockers merged. */
export function computeReadyWave(issues: SchedulableIssue[]): ReadyWave {
  const all = indexBy(issues);
  const ready: string[] = [];
  const blocked: Array<{ identifier: string; waitingOn: string[] }> = [];

  const cycles = detectDependencyCycles(issues);
  const inCycle = new Set(cycles.flat());

  for (const issue of issues) {
    if (issue.merged || !issue.ready) continue;
    if (inCycle.has(issue.identifier)) continue;
    const waiting = unsatisfiedBlockers(issue, all);
    if (waiting.length === 0) ready.push(issue.identifier);
    else blocked.push({ identifier: issue.identifier, waitingOn: waiting });
  }

  return { wave: 1, issues: ready.sort(), blocked };
}

/**
 * Projects the full wave sequence by assuming each wave merges.
 *
 * Planning aid only — the scheduler always re-derives wave 1 from real merge
 * state on the next tick.
 */
export function computeAllWaves(issues: SchedulableIssue[]): ReadyWave[] {
  const cycles = detectDependencyCycles(issues);
  const inCycle = new Set(cycles.flat());

  const merged = new Set(issues.filter((i) => i.merged).map((i) => i.identifier));
  const remaining = issues.filter((i) => !i.merged && i.ready && !inCycle.has(i.identifier));

  const waves: ReadyWave[] = [];
  let pending = [...remaining];
  let waveNumber = 1;

  while (pending.length > 0) {
    const eligible = pending.filter((i) => i.blockedBy.every((b) => merged.has(b)));
    if (eligible.length === 0) break; // unreachable work; blockers never merge
    waves.push({ wave: waveNumber, issues: eligible.map((i) => i.identifier).sort(), blocked: [] });
    for (const issue of eligible) merged.add(issue.identifier);
    pending = pending.filter((i) => !eligible.includes(i));
    waveNumber += 1;
  }
  return waves;
}

/**
 * Finds cycles. A cycle can never resolve on its own, so the issues involved
 * are surfaced for human attention rather than left to sit in the queue
 * looking like they are merely waiting.
 */
export function detectDependencyCycles(issues: SchedulableIssue[]): string[][] {
  const all = indexBy(issues);
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  function visit(id: string): void {
    if (stack.has(id)) {
      const start = path.indexOf(id);
      if (start !== -1) cycles.push([...path.slice(start)].sort());
      return;
    }
    if (seen.has(id)) return;

    seen.add(id);
    stack.add(id);
    path.push(id);

    for (const blocker of all.get(id)?.blockedBy ?? []) {
      if (all.has(blocker)) visit(blocker);
    }

    path.pop();
    stack.delete(id);
  }

  for (const issue of issues) visit(issue.identifier);

  // Deduplicate: the same cycle is discoverable from each of its members.
  const unique = new Map<string, string[]>();
  for (const cycle of cycles) unique.set(cycle.join('->'), cycle);
  return [...unique.values()];
}
