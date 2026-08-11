import { describe, expect, it, vi } from 'vitest';
import { autoCurateNewIssues } from '../../src/linear/auto-curate.js';
import type { NewlyCreatedLinearIssue } from '../../src/linear/issues.js';

const issue = (identifier: string, labels: string[] = []): NewlyCreatedLinearIssue => ({
  id: identifier,
  identifier,
  title: `Issue ${identifier}`,
  description: 'Repository: Lorebound',
  labels,
  projectName: 'Lorebound',
  url: `https://linear.example/${identifier}`,
  createdAt: '2026-08-11T12:00:00.000Z',
  updatedAt: '2026-08-11T12:00:00.000Z',
});

describe('automatic issue adoption', () => {
  it('establishes the first watermark without sweeping historical backlog', async () => {
    const setCursor = vi.fn();
    const setFloor = vi.fn();
    const fetchIssues = vi.fn(async () => [issue('OLD-1')]);
    const report = await autoCurateNewIssues(
      {
        getCursor: () => null,
        setCursor,
        setFloor,
        fetchIssues,
        resolveRepository: () => ({ ok: true, projectId: 'lorebound', context: '' }),
        setLifecycle: vi.fn(async () => undefined),
        requestContext: vi.fn(async () => undefined),
      },
      new Date('2026-08-11T13:00:00.000Z'),
    );

    expect(report.adopted).toEqual([]);
    expect(fetchIssues).not.toHaveBeenCalled();
    expect(setCursor).toHaveBeenCalledWith('2026-08-11T13:00:00.000Z');
    expect(setFloor).toHaveBeenCalledWith('2026-08-11T13:00:00.000Z');
  });

  it('labels resolvable new issues ai-curate and skips lifecycle-owned issues', async () => {
    const setLifecycle = vi.fn(async () => undefined);
    const setCursor = vi.fn();
    const report = await autoCurateNewIssues(
      {
        getCursor: () => '2026-08-11T12:00:00.000Z',
        setCursor,
        fetchIssues: async () => [issue('NEW-1'), issue('NEW-2', ['ai-ready'])],
        resolveRepository: () => ({ ok: true, projectId: 'lorebound', context: '' }),
        setLifecycle,
        requestContext: vi.fn(async () => undefined),
      },
      new Date('2026-08-11T13:00:00.000Z'),
    );

    expect(report).toEqual({ adopted: ['NEW-1'], needsContext: [], skipped: ['NEW-2'] });
    expect(setLifecycle).toHaveBeenCalledWith('NEW-1', 'ai-curate');
    expect(setCursor).toHaveBeenCalledWith('2026-08-11T13:00:00.000Z');
  });

  it('requests repository context and advances only after the window succeeds', async () => {
    const setLifecycle = vi.fn(async () => undefined);
    const requestContext = vi.fn(async () => undefined);
    const setCursor = vi.fn();
    const report = await autoCurateNewIssues({
      getCursor: () => '2026-08-11T12:00:00.000Z',
      setCursor,
      fetchIssues: async () => [issue('NEW-3')],
      resolveRepository: () => ({ ok: false, message: 'No repository mapping', candidates: ['lorebound'] }),
      setLifecycle,
      requestContext,
    });

    expect(report.needsContext).toEqual(['NEW-3']);
    expect(requestContext).toHaveBeenCalledWith('NEW-3', 'No repository mapping', ['lorebound']);
    expect(setLifecycle).toHaveBeenCalledWith('NEW-3', 'ai-needs-context');
    expect(setCursor).toHaveBeenCalledOnce();
  });

  it('does not advance the watermark when a label write fails', async () => {
    const setCursor = vi.fn();
    await expect(
      autoCurateNewIssues({
        getCursor: () => '2026-08-11T12:00:00.000Z',
        setCursor,
        fetchIssues: async () => [issue('NEW-4')],
        resolveRepository: () => ({ ok: true, projectId: 'lorebound', context: '' }),
        setLifecycle: async () => {
          throw new Error('Linear unavailable');
        },
        requestContext: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow('Linear unavailable');
    expect(setCursor).not.toHaveBeenCalled();
  });

  it('re-reads a bounded overlap while never crossing the first-run floor', async () => {
    const fetchIssues = vi.fn(async () => [issue('DELAYED-1', ['ai-curate'])]);
    await autoCurateNewIssues(
      {
        getCursor: () => '2026-08-11T12:15:00.000Z',
        setCursor: vi.fn(),
        getFloor: () => '2026-08-11T12:10:00.000Z',
        setFloor: vi.fn(),
        fetchIssues,
        resolveRepository: () => ({ ok: true, projectId: 'lorebound', context: '' }),
        setLifecycle: vi.fn(async () => undefined),
        requestContext: vi.fn(async () => undefined),
      },
      new Date('2026-08-11T12:16:00.000Z'),
    );

    expect(fetchIssues).toHaveBeenCalledWith(
      '2026-08-11T12:10:00.000Z',
      '2026-08-11T12:16:00.000Z',
    );
  });

  it('fails closed when persisted cursor metadata is malformed', async () => {
    await expect(
      autoCurateNewIssues({
        getCursor: () => 'not-a-timestamp',
        setCursor: vi.fn(),
        fetchIssues: vi.fn(),
        resolveRepository: () => ({ ok: true, projectId: 'lorebound', context: '' }),
        setLifecycle: vi.fn(async () => undefined),
        requestContext: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(/Invalid auto-curate cursor/);
  });
});
