import { z } from 'zod';
import { CI_TRIGGERS } from '../workflow/states.js';

const projectEntrySchema = z
  .object({
    enabled: z.boolean().default(true),
    repository: z.object({
      path: z.string(),
      github: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"'),
      base_branch: z.string().default('main'),
    }),
    linear: z
      .object({
        project: z.string().optional(),
        default: z.boolean().default(false),
      })
      .default({ default: false }),
    knowledge: z
      .object({ status: z.enum(['unverified', 'verified']).default('unverified') })
      .default({ status: 'unverified' }),
    concurrency: z.object({ max_agents: z.number().int().positive() }).optional(),
    routing_profile: z.string().default('default'),
    validation: z.object({ source: z.literal('repository') }).default({ source: 'repository' }),
    // How this repository's CI is actually triggered. Defaults to
    // `pull_request` because that is the common GitHub Actions shape: a
    // workflow with `on: pull_request` does not fire for a pushed ai/* branch.
    ci: z
      .object({
        trigger: z.enum(CI_TRIGGERS).default('pull_request'),
        required_checks: z.array(z.string()).default([]),
      })
      .default({ trigger: 'pull_request', required_checks: [] }),
  })
  .transform((p) => ({
    enabled: p.enabled,
    repository: {
      path: p.repository.path,
      github: p.repository.github,
      baseBranch: p.repository.base_branch,
    },
    linear: { project: p.linear.project, isDefault: p.linear.default },
    knowledgeStatus: p.knowledge.status,
    maxAgents: p.concurrency?.max_agents,
    routingProfile: p.routing_profile,
    validationSource: p.validation.source,
    ci: { trigger: p.ci.trigger, requiredChecks: p.ci.required_checks },
  }));

const groupSchema = z
  .object({
    linear_project: z.string(),
    default_repository: z.string(),
    repositories: z.array(z.string()).min(1),
  })
  .transform((g) => ({
    linearProject: g.linear_project,
    defaultRepository: g.default_repository,
    repositories: g.repositories,
  }));

export const projectRegistrySchema = z
  .object({
    projects: z.record(z.string(), projectEntrySchema).default({}),
    groups: z.record(z.string(), groupSchema).default({}),
  })
  // A group that names an unregistered repository would resolve to a project
  // the scheduler cannot dispatch to.
  .superRefine((cfg, ctx) => {
    const known = new Set(Object.keys(cfg.projects));
    for (const [name, group] of Object.entries(cfg.groups)) {
      for (const repo of group.repositories) {
        if (!known.has(repo)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['groups', name, 'repositories'],
            message: `unregistered project "${repo}"`,
          });
        }
      }
      if (!group.repositories.includes(group.defaultRepository)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groups', name, 'default_repository'],
          message: `default_repository "${group.defaultRepository}" is not in this group's repositories`,
        });
      }
    }

    const defaultsByLinearProject = new Map<string, string[]>();
    for (const [projectId, project] of Object.entries(cfg.projects)) {
      if (!project.linear.project || !project.linear.isDefault) continue;
      const defaults = defaultsByLinearProject.get(project.linear.project) ?? [];
      defaults.push(projectId);
      defaultsByLinearProject.set(project.linear.project, defaults);
    }
    for (const [linearProject, defaults] of defaultsByLinearProject) {
      if (defaults.length <= 1) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projects'],
        message: `Linear project "${linearProject}" has multiple default repositories: ${defaults.join(', ')}`,
      });
    }
  });

export type ProjectRegistry = z.infer<typeof projectRegistrySchema>;
export type ProjectEntry = ProjectRegistry['projects'][string];
export type ProjectGroup = ProjectRegistry['groups'][string];
