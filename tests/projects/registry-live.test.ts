import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadControllerConfig } from '../../src/config/load-config.js';
import { resolveRepository } from '../../src/projects/resolver.js';

/**
 * Guards the real registry against the real machine.
 *
 * A wrong path or base_branch here would not surface until the first worktree
 * creation, mid-issue, as a confusing git error. Better to fail here.
 */
const { registry } = loadControllerConfig(process.cwd());
const entries = Object.entries(registry.projects);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('registry integrity', () => {
  it('registers at least one repository', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('gives every repository a distinct Linear project', () => {
    const projects = entries.map(([, p]) => p.linear.project).filter(Boolean);
    expect(new Set(projects).size).toBe(projects.length);
  });

  it('gives every repository a distinct GitHub slug', () => {
    const slugs = entries.map(([, p]) => p.repository.github);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('resolves each Linear project to exactly one repository', () => {
    for (const [id, project] of entries) {
      const result = resolveRepository(
        { projectName: project.linear.project ?? null, description: '', labels: [] },
        registry,
      );
      expect(result.ok, `${project.linear.project} should resolve`).toBe(true);
      if (result.ok) expect(result.projectId).toBe(id);
    }
  });

  it('lets a repo: marker override the Linear project', () => {
    const [firstId] = entries[0]!;
    const [, secondProject] = entries[1]!;
    const result = resolveRepository(
      { projectName: secondProject.linear.project ?? null, description: `repo:${firstId}`, labels: [] },
      registry,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.projectId).toBe(firstId);
      expect(result.via).toBe('explicit_marker');
    }
  });
});

describe.runIf(process.env['AI_DEV_LIVE_REGISTRY'] === '1')('registry matches the filesystem', () => {
  for (const [id, project] of entries) {
    describe(id, () => {
      const path = project.repository.path;

      it('points at a directory that exists', () => {
        expect(existsSync(path), `${path} does not exist`).toBe(true);
      });

      it('points at a git repository', () => {
        expect(existsSync(`${path}/.git`), `${path} is not a git repository`).toBe(true);
      });

      it('declares the branch the repository actually defaults to', () => {
        const actual = git(path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(
          /^origin\//,
          '',
        );
        expect(project.repository.baseBranch).toBe(actual);
      });

      it('declares the GitHub slug the origin remote actually points at', () => {
        const remote = git(path, ['remote', 'get-url', 'origin']);
        const slug = remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
        expect(project.repository.github.toLowerCase()).toBe(slug.toLowerCase());
      });
    });
  }
});
