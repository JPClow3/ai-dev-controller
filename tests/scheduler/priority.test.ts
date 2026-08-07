import { describe, expect, it } from 'vitest';
import { rankWork, filterUnderThrottle, PRIORITY, type WorkItem } from '../../src/scheduler/priority.js';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

describe('rankWork', () => {
  it('finishes existing work before starting new work', () => {
    const items: WorkItem[] = [
      { kind: 'NEW_READY_ISSUE', issueId: 'UNI-9', enqueuedAt: at(0) },
      { kind: 'FINAL_REVIEW_PR', issueId: 'UNI-1', enqueuedAt: at(9) },
      { kind: 'CHALLENGER_EXPERIMENT', issueId: 'UNI-8', enqueuedAt: at(1) },
      { kind: 'CI_REMEDIATION', issueId: 'UNI-2', enqueuedAt: at(8) },
    ];
    expect(rankWork(items).map((i) => i.issueId)).toEqual(['UNI-1', 'UNI-2', 'UNI-9', 'UNI-8']);
  });

  it('puts human-unblocked work first, ahead of everything', () => {
    const items: WorkItem[] = [
      { kind: 'FINAL_REVIEW_PR', issueId: 'UNI-1', enqueuedAt: at(0) },
      { kind: 'HUMAN_UNBLOCKED', issueId: 'UNI-7', enqueuedAt: at(99) },
    ];
    expect(rankWork(items)[0]!.issueId).toBe('UNI-7');
  });

  it('breaks ties in favour of older work', () => {
    const items: WorkItem[] = [
      { kind: 'ACTIVE_ISSUE_WORKER', issueId: 'UNI-B', enqueuedAt: at(5) },
      { kind: 'ACTIVE_ISSUE_WORKER', issueId: 'UNI-A', enqueuedAt: at(1) },
    ];
    expect(rankWork(items).map((i) => i.issueId)).toEqual(['UNI-A', 'UNI-B']);
  });

  it('is stable for identical priority and timestamp', () => {
    const items: WorkItem[] = [
      { kind: 'ACTIVE_ISSUE_WORKER', issueId: 'UNI-1', taskKey: 'b', enqueuedAt: at(1) },
      { kind: 'ACTIVE_ISSUE_WORKER', issueId: 'UNI-1', taskKey: 'a', enqueuedAt: at(1) },
    ];
    expect(rankWork(items).map((i) => i.taskKey)).toEqual(['a', 'b']);
  });

  it('orders the bands exactly as the design specifies', () => {
    expect(Object.values(PRIORITY)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(PRIORITY.NEW_READY_ISSUE).toBeGreaterThan(PRIORITY.ACTIVE_ISSUE_WORKER);
    expect(PRIORITY.CHALLENGER_EXPERIMENT).toBeGreaterThan(PRIORITY.NEW_READY_ISSUE);
  });
});

describe('filterUnderThrottle', () => {
  it('drops new starts and experiments while throttled', () => {
    const items: WorkItem[] = [
      { kind: 'FINAL_REVIEW_PR', issueId: 'UNI-1', enqueuedAt: at(0) },
      { kind: 'NEW_READY_ISSUE', issueId: 'UNI-2', enqueuedAt: at(0) },
      { kind: 'CHALLENGER_EXPERIMENT', issueId: 'UNI-3', enqueuedAt: at(0) },
      { kind: 'KNOWLEDGE_MAINTENANCE', issueId: 'UNI-4', enqueuedAt: at(0) },
    ];
    expect(filterUnderThrottle(items, true).map((i) => i.issueId)).toEqual(['UNI-1']);
    expect(filterUnderThrottle(items, false)).toHaveLength(4);
  });
});
