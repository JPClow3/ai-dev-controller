import { describe, expect, it, vi } from 'vitest';
import {
  curateIssues,
  normalizeCuratedBody,
  type CuratorIssue,
  type CuratedIssueResult,
} from '../../src/curation/curate.js';

const rough = (id: string): CuratorIssue => ({
  identifier: id,
  title: 'make ink quote better',
  description: 'show if I can afford it',
  labels: ['ai-curate'],
  projectName: 'Lorebound',
  url: `https://linear.example/${id}`,
});

const curated = (id: string): CuratedIssueResult => ({
  verdict: 'curated',
  issue_id: id,
  repository: 'lorebound',
  title: 'Report affordability in Ink quotes',
  body: '# Goal\nReport affordability.\n\n# Acceptance criteria\nAC-1: Preserve one-argument behavior.',
  task_category: 'routine_behavior',
  risk: 'low',
  acceptance_criteria: [{ id: 'AC-1', statement: 'Preserve one-argument behavior.' }],
});

describe('rough Linear issue curation', () => {
  it('renders stable AC identifiers into the Linear body', () => {
    const body = [
      '# Goal',
      'Report affordability.',
      '# Acceptance criteria',
      '- Preserve existing behavior.',
      '# Open questions',
      'None.',
    ].join('\n');

    expect(
      normalizeCuratedBody(body, [
        { id: 'AC-1', statement: 'Return Enough Ink for zero.', kind: 'behaviour' },
        { id: 'AC-2', statement: 'Preserve existing behavior.', kind: 'regression' },
      ]),
    ).toContain('- [ ] AC-1: Return Enough Ink for zero.');
  });

  it('writes the curated contract and promotes it directly to ai-ready', async () => {
    const persistCurated = vi.fn(async () => undefined);
    const setLifecycle = vi.fn(async () => undefined);
    const report = await curateIssues({
      fetchIssues: async () => [rough('JP-10')],
      resolveRepository: () => ({ ok: true, projectId: 'lorebound', context: 'shared TypeScript package' }),
      invokeCurator: async () => curated('JP-10'),
      persistCurated,
      requestContext: vi.fn(async () => undefined),
      setLifecycle,
    });

    expect(report.curated).toEqual(['JP-10']);
    expect(persistCurated).toHaveBeenCalledWith(rough('JP-10'), curated('JP-10'));
    expect(setLifecycle).toHaveBeenCalledWith('JP-10', 'ai-ready');
    expect(setLifecycle).not.toHaveBeenCalledWith('JP-10', 'ai-curated');
  });

  it('asks specific questions instead of inventing missing product behavior', async () => {
    const requestContext = vi.fn(async () => undefined);
    const persistCurated = vi.fn(async () => undefined);
    const result: CuratedIssueResult = {
      verdict: 'needs_context',
      issue_id: 'JP-11',
      repository: 'lorebound',
      needs_context: {
        reason: 'undocumented_product_decision',
        questions: ['Should the quote include reserved promotional Ink?'],
      },
    };

    const report = await curateIssues({
      fetchIssues: async () => [rough('JP-11')],
      resolveRepository: () => ({ ok: true, projectId: 'lorebound', context: '' }),
      invokeCurator: async () => result,
      persistCurated,
      requestContext,
      setLifecycle: vi.fn(async () => undefined),
    });

    expect(report.needsContext).toEqual(['JP-11']);
    expect(requestContext).toHaveBeenCalledWith('JP-11', result.needs_context);
    expect(persistCurated).not.toHaveBeenCalled();
  });

  it('isolates a failed issue so another rough issue is still curated', async () => {
    const persistCurated = vi.fn(async () => undefined);
    const onFailure = vi.fn(() => 'continue' as const);
    const report = await curateIssues({
      fetchIssues: async () => [rough('JP-12'), rough('JP-13')],
      resolveRepository: () => ({ ok: true, projectId: 'lorebound', context: '' }),
      invokeCurator: async (issue) => {
        if (issue.identifier === 'JP-12') throw new Error('provider reset');
        return curated('JP-13');
      },
      persistCurated,
      requestContext: vi.fn(async () => undefined),
      setLifecycle: vi.fn(async () => undefined),
      onFailure,
    });

    expect(report.failed).toEqual([{ identifier: 'JP-12', error: 'provider reset' }]);
    expect(report.curated).toEqual(['JP-13']);
    expect(persistCurated).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(rough('JP-12'), expect.any(Error));
  });

  it('stops the batch when a shared provider cooldown makes later attempts wasteful', async () => {
    const invokeCurator = vi.fn(async () => {
      throw new Error('shared quota exhausted');
    });
    const report = await curateIssues({
      fetchIssues: async () => [rough('JP-14'), rough('JP-15')],
      resolveRepository: () => ({ ok: true, projectId: 'lorebound', context: '' }),
      invokeCurator,
      persistCurated: vi.fn(async () => undefined),
      requestContext: vi.fn(async () => undefined),
      setLifecycle: vi.fn(async () => undefined),
      onFailure: vi.fn(() => 'stop' as const),
    });

    expect(report.failed).toEqual([{ identifier: 'JP-14', error: 'shared quota exhausted' }]);
    expect(invokeCurator).toHaveBeenCalledOnce();
  });
});
