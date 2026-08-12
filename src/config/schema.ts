import { z } from 'zod';

/**
 * Config contract.
 *
 * YAML is snake_case because humans edit it; the runtime objects are camelCase
 * because TypeScript reads it. The translation happens here, once, so no other
 * module has to know both spellings.
 */

const concurrencySchema = z
  .object({
    active_issues: z.number().int().positive(),
    workers_per_issue: z.number().int().positive(),
    global_agents: z.number().int().positive(),
    gpt_heavy_agents: z.number().int().nonnegative(),
    gpt_luna_workers: z.number().int().nonnegative(),
    ollama_workers: z.number().int().nonnegative(),
    agents_per_repository: z.number().int().positive(),
  })
  .transform((c) => ({
    activeIssues: c.active_issues,
    workersPerIssue: c.workers_per_issue,
    globalAgents: c.global_agents,
    gptHeavyAgents: c.gpt_heavy_agents,
    gptLunaWorkers: c.gpt_luna_workers,
    ollamaWorkers: c.ollama_workers,
    agentsPerRepository: c.agents_per_repository,
  }));

const labelsSchema = z
  .object({
    curate: z.string(),
    ready: z.string(),
    running: z.string(),
    blocked: z.string(),
    reviewing: z.string(),
    pr_open: z.string(),
  })
  .transform((l) => ({
    curate: l.curate,
    ready: l.ready,
    running: l.running,
    blocked: l.blocked,
    reviewing: l.reviewing,
    prOpen: l.pr_open,
  }));

export const globalConfigSchema = z
  .object({
    poll_interval_seconds: z.number().int().positive().default(45),
    concurrency: concurrencySchema,
    linear: z
      .object({
        labels: labelsSchema,
        trust_inferred_dependencies: z.literal(false).default(false),
      })
      .transform((l) => ({
        labels: l.labels,
        trustInferredDependencies: l.trust_inferred_dependencies,
      })),
    git: z
      .object({
        branch_prefix: z.string().default('ai/'),
        bootstrap_branch: z.string().default('ai/bootstrap-project-knowledge'),
        always_fresh_base: z.boolean().default(true),
      })
      .transform((g) => ({
        branchPrefix: g.branch_prefix,
        bootstrapBranch: g.bootstrap_branch,
        alwaysFreshBase: g.always_fresh_base,
      })),
    github: z
      .object({
        draft_prs: z.boolean().default(true),
        // Not configurable to true. You are the merge authority.
        auto_merge: z.literal(false).default(false),
        ci_is_authoritative: z.boolean().default(true),
      })
      .transform((g) => ({
        draftPrs: g.draft_prs,
        autoMerge: g.auto_merge,
        ciIsAuthoritative: g.ci_is_authoritative,
      })),
    knowledge: z
      .object({
        allow_unverified_execution: z.boolean().default(true),
        max_file_bytes: z.number().int().positive().default(262144),
        scan_globs: z.array(z.string()),
        exclude_globs: z.array(z.string()),
      })
      .transform((k) => ({
        allowUnverifiedExecution: k.allow_unverified_execution,
        maxFileBytes: k.max_file_bytes,
        scanGlobs: k.scan_globs,
        excludeGlobs: k.exclude_globs,
      })),
    orca: z
      .object({
        bin: z.string().default('orca'),
        child_worktrees: z.boolean().default(true),
      })
      .transform((o) => ({ bin: o.bin, childWorktrees: o.child_worktrees })),
    safety: z
      .object({ forbidden_operations: z.array(z.string()).min(1) })
      .transform((s) => ({ forbiddenOperations: s.forbidden_operations })),
    paths: z.object({ database: z.string(), registry: z.string() }),
  })
  .transform((g) => ({
    pollIntervalSeconds: g.poll_interval_seconds,
    concurrency: g.concurrency,
    linear: g.linear,
    git: g.git,
    github: g.github,
    knowledge: g.knowledge,
    orca: g.orca,
    safety: g.safety,
    paths: g.paths,
  }));

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type ConcurrencyConfig = GlobalConfig['concurrency'];
