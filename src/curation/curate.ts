export interface CuratorIssue {
  identifier: string;
  title: string;
  description: string;
  labels: string[];
  projectName: string | null;
  url: string;
}

export interface CuratedCriterion {
  id: string;
  statement: string;
  kind?: 'behaviour' | 'regression' | 'coverage' | 'performance' | 'security';
  verification_hint?: string;
}

export interface NeedsContext {
  reason:
    | 'undocumented_product_decision'
    | 'contradictory_authoritative_docs'
    | 'repository_unresolvable'
    | 'issue_covers_multiple_changes';
  questions: string[];
  candidate_repositories?: string[];
}

export interface CuratedIssueResult {
  verdict: 'curated' | 'needs_context';
  issue_id: string;
  repository?: string | null;
  title?: string;
  body?: string;
  task_category?: string;
  risk?: 'low' | 'medium' | 'high';
  acceptance_criteria?: CuratedCriterion[];
  relevant_paths?: string[];
  open_questions?: string[];
  needs_context?: NeedsContext;
  dependency_proposals?: Array<{
    blocked_issue: string;
    blocking_issue: string;
    acceptance_criterion: string;
    reason: string;
  }>;
}

export type RepositoryResolution =
  | { ok: true; projectId: string; context: string }
  | { ok: false; message: string; candidates?: string[] };

export interface CurateIssuesDeps {
  fetchIssues: () => Promise<CuratorIssue[]>;
  resolveRepository: (issue: CuratorIssue) => RepositoryResolution;
  invokeCurator: (
    issue: CuratorIssue,
    repository: { projectId: string; context: string },
  ) => Promise<CuratedIssueResult>;
  persistCurated: (issue: CuratorIssue, result: CuratedIssueResult) => Promise<void>;
  requestContext: (identifier: string, context: NeedsContext) => Promise<void>;
  /** A complete contract is promoted directly into the implementation queue. */
  setLifecycle: (identifier: string, label: 'ai-ready' | 'ai-needs-context') => Promise<void>;
  /** Lets the composition root persist provider cooldowns; `stop` ends this batch. */
  onFailure?: (issue: CuratorIssue, error: unknown) => Promise<'continue' | 'stop' | void> | 'continue' | 'stop' | void;
}

export interface CurationReport {
  curated: string[];
  needsContext: string[];
  failed: Array<{ identifier: string; error: string }>;
}

/**
 * Makes the schema-owned acceptance criteria durable in Linear's Markdown.
 * The model may phrase the section as bullets, but downstream reconstruction
 * relies on stable AC identifiers rather than trying to infer them again.
 */
export function normalizeCuratedBody(body: string, criteria: CuratedCriterion[]): string {
  const lines = body.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^# Acceptance criteria\s*$/i.test(line.trim()));
  const rendered = criteria.map((criterion) => `- [ ] ${criterion.id}: ${criterion.statement}`);

  if (heading < 0) {
    return `${body.trimEnd()}\n\n# Acceptance criteria\n\n${rendered.join('\n')}`;
  }

  let nextHeading = lines.findIndex((line, index) => index > heading && /^#\s+/.test(line.trim()));
  if (nextHeading < 0) nextHeading = lines.length;
  return [...lines.slice(0, heading + 1), '', ...rendered, '', ...lines.slice(nextHeading)].join('\n').trimEnd();
}

/**
 * Processes rough Linear issues and promotes a complete contract to
 * `ai-ready`. One provider failure is isolated so polling continues.
 */
export async function curateIssues(deps: CurateIssuesDeps): Promise<CurationReport> {
  const report: CurationReport = { curated: [], needsContext: [], failed: [] };

  for (const issue of await deps.fetchIssues()) {
    try {
      const resolution = deps.resolveRepository(issue);
      if (!resolution.ok) {
        const context: NeedsContext = {
          reason: 'repository_unresolvable',
          questions: [resolution.message],
          ...(resolution.candidates ? { candidate_repositories: resolution.candidates } : {}),
        };
        await deps.requestContext(issue.identifier, context);
        await deps.setLifecycle(issue.identifier, 'ai-needs-context');
        report.needsContext.push(issue.identifier);
        continue;
      }

      const result = await deps.invokeCurator(issue, resolution);
      if (result.issue_id !== issue.identifier) {
        throw new Error(`curator returned issue_id ${result.issue_id} for ${issue.identifier}`);
      }

      if (result.verdict === 'needs_context') {
        if (!result.needs_context) throw new Error('needs_context verdict omitted its questions');
        await deps.requestContext(issue.identifier, result.needs_context);
        await deps.setLifecycle(issue.identifier, 'ai-needs-context');
        report.needsContext.push(issue.identifier);
        continue;
      }

      if (
        !result.body ||
        !result.title ||
        !result.repository ||
        !result.task_category ||
        !result.risk ||
        !result.acceptance_criteria?.length
      ) {
        throw new Error('curated verdict omitted its engineering contract');
      }
      if (result.repository !== resolution.projectId) {
        throw new Error(`curator selected ${result.repository}; resolver selected ${resolution.projectId}`);
      }

      await deps.persistCurated(issue, result);
      await deps.setLifecycle(issue.identifier, 'ai-ready');
      report.curated.push(issue.identifier);
    } catch (error) {
      report.failed.push({
        identifier: issue.identifier,
        error: error instanceof Error ? error.message : String(error),
      });
      if ((await deps.onFailure?.(issue, error)) === 'stop') break;
    }
  }

  return report;
}
