import type { ProjectEntry } from '../types/index.js';
import { NotImplementedError } from '../util/errors.js';

/**
 * Repository resolution.
 *
 * A Linear project may map to several repositories. An issue containing
 * `repo:hefesto-web` overrides the group default. If exactly one repository
 * cannot be resolved, the issue gets `ai-needs-context`. No guessing.
 */

export function listProjects(): ProjectEntry[] {
  throw new NotImplementedError('registry.listProjects');
}

export function getProject(_id: string): ProjectEntry | null {
  throw new NotImplementedError('registry.getProject');
}

export type Resolution =
  | { ok: true; projectId: string; via: 'explicit_marker' | 'group_default' | 'sole_project' }
  | { ok: false; candidates: string[]; reason: 'ambiguous' | 'unknown_project' };

export function resolveRepository(_opts: {
  linearProject: string | null;
  issueBody: string;
}): Resolution {
  throw new NotImplementedError('registry.resolveRepository');
}

/** Appends to projects/registry.yaml. Called by `ai-dev onboard`. */
export function register(_entry: ProjectEntry): void {
  throw new NotImplementedError('registry.register');
}
