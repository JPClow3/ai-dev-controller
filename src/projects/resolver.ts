import type { ProjectRegistry } from '../config/registry-schema.js';

export type RepositoryResolution =
  | { ok: true; projectId: string; via: 'explicit_marker' | 'group_default' | 'sole_project' }
  | { ok: false; reason: ResolutionFailure; candidates: string[]; message: string };

export type ResolutionFailure =
  | 'ambiguous'
  | 'unknown_marker'
  | 'no_project_for_linear_project'
  | 'no_projects_registered'
  | 'project_disabled';

export interface ResolvableIssue {
  /** Linear project name, or null when the issue has none. */
  projectName: string | null;
  description: string;
  labels: string[];
}

// Underscore is included deliberately: a repository named `moto_track` would
// otherwise silently truncate to `moto` and resolve to nothing.
const MARKER = /(?:^|\s)repo:([A-Za-z0-9._-]+)/;

/** `repo:<id>` in the body or as a label. Labels win — they are structured. */
export function extractRepoMarker(issue: ResolvableIssue): string | null {
  for (const label of issue.labels) {
    const match = MARKER.exec(label);
    if (match?.[1]) return match[1];
  }
  const match = MARKER.exec(issue.description);
  return match?.[1] ?? null;
}

/**
 * Resolves an issue to exactly one repository, or refuses.
 *
 * Refusing is a first-class outcome. A wrong guess sends agents to modify the
 * wrong codebase, which is far more expensive than asking.
 */
export function resolveRepository(issue: ResolvableIssue, registry: ProjectRegistry): RepositoryResolution {
  const enabled = Object.entries(registry.projects).filter(([, p]) => p.enabled);

  if (enabled.length === 0) {
    return {
      ok: false,
      reason: 'no_projects_registered',
      candidates: [],
      message: 'No enabled repositories in projects/registry.yaml. Run `ai-dev onboard <path>` first.',
    };
  }

  // 1. Explicit marker beats everything.
  const marker = extractRepoMarker(issue);
  if (marker) {
    const entry = registry.projects[marker];
    if (!entry) {
      return {
        ok: false,
        reason: 'unknown_marker',
        candidates: Object.keys(registry.projects),
        message: `Issue names repo:${marker}, which is not in the registry.`,
      };
    }
    if (!entry.enabled) {
      return {
        ok: false,
        reason: 'project_disabled',
        candidates: [marker],
        message: `Repository "${marker}" is registered but disabled.`,
      };
    }
    return { ok: true, projectId: marker, via: 'explicit_marker' };
  }

  // 2. Group default for this Linear project.
  if (issue.projectName) {
    const group = Object.values(registry.groups).find((g) => g.linearProject === issue.projectName);
    if (group) {
      const active = group.repositories.filter((r) => registry.projects[r]?.enabled);
      if (active.includes(group.defaultRepository)) {
        return { ok: true, projectId: group.defaultRepository, via: 'group_default' };
      }
      return {
        ok: false,
        reason: 'ambiguous',
        candidates: active,
        message: `Linear project "${issue.projectName}" maps to ${active.length} repositories and its default is unavailable. Add a repo:<id> marker.`,
      };
    }

    const matching = enabled.filter(([, p]) => p.linear.project === issue.projectName);
    if (matching.length === 1) {
      return { ok: true, projectId: matching[0]![0], via: 'sole_project' };
    }
    if (matching.length > 1) {
      const preferred = matching.filter(([, p]) => p.linear.isDefault);
      if (preferred.length === 1) {
        return { ok: true, projectId: preferred[0]![0], via: 'group_default' };
      }
      return {
        ok: false,
        reason: 'ambiguous',
        candidates: matching.map(([id]) => id),
        message: `Linear project "${issue.projectName}" maps to ${matching.length} repositories with no default. Add a repo:<id> marker.`,
      };
    }
    return {
      ok: false,
      reason: 'no_project_for_linear_project',
      candidates: enabled.map(([id]) => id),
      message: `No registered repository is linked to Linear project "${issue.projectName}".`,
    };
  }

  // 3. Single registered repository is unambiguous even without a project.
  if (enabled.length === 1) {
    return { ok: true, projectId: enabled[0]![0], via: 'sole_project' };
  }

  return {
    ok: false,
    reason: 'ambiguous',
    candidates: enabled.map(([id]) => id),
    message: 'Issue has no Linear project and several repositories are registered. Add a repo:<id> marker.',
  };
}
