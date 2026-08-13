import { describe, expect, it } from 'vitest';
import { resolveRepository, extractRepoMarker } from '../../src/projects/resolver.js';
import { projectRegistrySchema, type ProjectRegistry } from '../../src/config/registry-schema.js';

function registry(raw: unknown): ProjectRegistry {
  return projectRegistrySchema.parse(raw);
}

const multi = registry({
  projects: {
    'hefesto-backend': {
      repository: { path: 'H:/x/backend', github: 'JPClow3/hefesto-backend', base_branch: 'main' },
      linear: { project: 'Hefesto', default: true },
    },
    'hefesto-web': {
      repository: { path: 'H:/x/web', github: 'JPClow3/hefesto-web', base_branch: 'main' },
      linear: { project: 'Hefesto' },
    },
  },
  groups: {
    hefesto: {
      linear_project: 'Hefesto',
      default_repository: 'hefesto-backend',
      repositories: ['hefesto-backend', 'hefesto-web'],
    },
  },
});

const single = registry({
  projects: {
    'climagro-django': {
      repository: { path: 'H:/x/c', github: 'AgroHub-Uni-RV/climagro-django', base_branch: 'main' },
      linear: { project: 'Unirv', default: true },
    },
  },
});

const issue = (over: Partial<Parameters<typeof resolveRepository>[0]> = {}) => ({
  projectName: 'Hefesto',
  description: '',
  labels: [] as string[],
  ...over,
});

describe('extractRepoMarker', () => {
  it('reads a marker from the body', () => {
    expect(extractRepoMarker(issue({ description: 'Fix things\n\nrepo:hefesto-web' }))).toBe('hefesto-web');
  });

  it('prefers a label over the body, since labels are structured', () => {
    expect(
      extractRepoMarker(issue({ description: 'repo:hefesto-backend', labels: ['repo:hefesto-web'] })),
    ).toBe('hefesto-web');
  });

  it('returns null when absent', () => {
    expect(extractRepoMarker(issue({ description: 'no marker here' }))).toBeNull();
  });

  it('does not match a bare word containing "repo"', () => {
    expect(extractRepoMarker(issue({ description: 'the reporepo:thing' }))).toBeNull();
  });
});

describe('resolveRepository', () => {
  it('uses the group default when no marker is present', () => {
    const result = resolveRepository(issue(), multi);
    expect(result).toEqual({ ok: true, projectId: 'hefesto-backend', via: 'group_default' });
  });

  it('lets an explicit marker override the default', () => {
    const result = resolveRepository(issue({ labels: ['repo:hefesto-web'] }), multi);
    expect(result).toEqual({ ok: true, projectId: 'hefesto-web', via: 'explicit_marker' });
  });

  it('refuses an unknown marker rather than falling back to the default', () => {
    const result = resolveRepository(issue({ labels: ['repo:not-registered'] }), multi);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown_marker');
      expect(result.candidates).toContain('hefesto-backend');
    }
  });

  it('refuses a disabled repository', () => {
    const disabled = registry({
      projects: {
        'hefesto-web': {
          enabled: false,
          repository: { path: 'H:/x/web', github: 'JPClow3/hefesto-web' },
          linear: { project: 'Hefesto' },
        },
        'hefesto-backend': {
          repository: { path: 'H:/x/backend', github: 'JPClow3/hefesto-backend' },
          linear: { project: 'Hefesto', default: true },
        },
      },
    });
    const result = resolveRepository(issue({ labels: ['repo:hefesto-web'] }), disabled);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('project_disabled');
  });

  it('needs context when several repositories match and none is default', () => {
    const ambiguous = registry({
      projects: {
        a: { repository: { path: 'H:/a', github: 'o/a' }, linear: { project: 'Hefesto' } },
        b: { repository: { path: 'H:/b', github: 'o/b' }, linear: { project: 'Hefesto' } },
      },
    });
    const result = resolveRepository(issue(), ambiguous);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ambiguous');
      expect(result.candidates.sort()).toEqual(['a', 'b']);
      expect(result.message).toMatch(/repo:<id>/);
    }
  });

  it('resolves the sole registered repository even without a Linear project', () => {
    const result = resolveRepository(issue({ projectName: null }), single);
    expect(result).toEqual({ ok: true, projectId: 'climagro-django', via: 'sole_project' });
  });

  it('needs context when there is no project and several repositories', () => {
    const result = resolveRepository(issue({ projectName: null }), multi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ambiguous');
  });

  it('reports when nothing is registered at all', () => {
    const result = resolveRepository(issue(), registry({ projects: {}, groups: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_projects_registered');
  });

  it('reports when the Linear project maps to no repository', () => {
    const result = resolveRepository(issue({ projectName: 'Unknown Project' }), multi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_project_for_linear_project');
  });
});

describe('registry validation', () => {
  it('rejects a group naming an unregistered repository', () => {
    expect(() =>
      registry({
        projects: { a: { repository: { path: 'H:/a', github: 'o/a' } } },
        groups: { g: { linear_project: 'P', default_repository: 'a', repositories: ['a', 'ghost'] } },
      }),
      // Zod serialises its issue list, so quotes arrive escaped.
    ).toThrow(/unregistered project/);
  });

  it('rejects a default_repository outside its own group', () => {
    expect(() =>
      registry({
        projects: {
          a: { repository: { path: 'H:/a', github: 'o/a' } },
          b: { repository: { path: 'H:/b', github: 'o/b' } },
        },
        groups: { g: { linear_project: 'P', default_repository: 'b', repositories: ['a'] } },
      }),
    ).toThrow(/not in this group/);
  });

  it('rejects a malformed github slug', () => {
    expect(() =>
      registry({ projects: { a: { repository: { path: 'H:/a', github: 'not-a-slug' } } } }),
    ).toThrow(/owner\/repo/);
  });

  it('rejects multiple default repositories for one Linear project', () => {
    expect(() =>
      registry({
        projects: {
          a: { repository: { path: 'H:/a', github: 'o/a' }, linear: { project: 'Shared', default: true } },
          b: { repository: { path: 'H:/b', github: 'o/b' }, linear: { project: 'Shared', default: true } },
        },
      }),
    ).toThrow(/multiple default repositories/);
  });
});
