/**
 * Scheduling priority. Seven agent slots are not a FIFO queue.
 *
 * The whole ordering encodes one preference: finish things. Work that is
 * nearly done outranks work that has not started, so PRs do not pile up at
 * 95% while new implementations consume every slot.
 */
export const PRIORITY = {
  HUMAN_UNBLOCKED: 0,
  FINAL_REVIEW_PR: 1,
  CI_REMEDIATION: 2,
  INTEGRATION: 3,
  ACTIVE_ISSUE_WORKER: 4,
  NEW_READY_ISSUE: 5,
  CHALLENGER_EXPERIMENT: 6,
  KNOWLEDGE_MAINTENANCE: 7,
} as const;

export type WorkKind = keyof typeof PRIORITY;

export interface WorkItem {
  kind: WorkKind;
  issueId: string;
  taskKey?: string;
  /** ISO timestamp used to break ties in favour of older work. */
  enqueuedAt: string;
}

export function priorityOf(item: WorkItem): number {
  return PRIORITY[item.kind];
}

/** Stable ordering: priority band, then age, then identifier. */
export function rankWork(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => {
    const byPriority = priorityOf(a) - priorityOf(b);
    if (byPriority !== 0) return byPriority;
    const byAge = a.enqueuedAt.localeCompare(b.enqueuedAt);
    if (byAge !== 0) return byAge;
    return `${a.issueId}${a.taskKey ?? ''}`.localeCompare(`${b.issueId}${b.taskKey ?? ''}`);
  });
}

/** Kinds that finish existing work rather than starting more of it. */
export const COMPLETION_KINDS: readonly WorkKind[] = [
  'HUMAN_UNBLOCKED',
  'FINAL_REVIEW_PR',
  'CI_REMEDIATION',
  'INTEGRATION',
  'ACTIVE_ISSUE_WORKER',
];

export function isCompletionWork(item: WorkItem): boolean {
  return COMPLETION_KINDS.includes(item.kind);
}

/** Under throttle, only completion work is dispatched. */
export function filterUnderThrottle(items: WorkItem[], throttled: boolean): WorkItem[] {
  return throttled ? items.filter(isCompletionWork) : items;
}
