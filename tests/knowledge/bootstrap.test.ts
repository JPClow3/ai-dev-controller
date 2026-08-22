import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyBootstrap, planBootstrap } from '../../src/knowledge/bootstrap.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe('knowledge bootstrap', () => {
  it('plans controller files without overwriting an authored AGENTS.md, then writes only the plan', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ai-dev-bootstrap-'));
    directories.push(repo);
    writeFileSync(join(repo, 'AGENTS.md'), 'human rules\n');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const plan = planBootstrap({ projectId: 'sample', repoPath: repo, baseBranch: 'main', discovery: { scanGlobs: ['**/*.md'], excludeGlobs: [], maxFileBytes: 10000 } });
    expect(plan.preserved).toContain('AGENTS.md');
    expect(plan.files.map((file) => file.path)).toContain('.ai-workflow/generated/agents-addendum.md');
    expect(applyBootstrap(plan)).toEqual(plan.files.map((file) => file.path));
    expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toBe('human rules\n');
    expect(existsSync(join(repo, '.ai-workflow', 'project.yaml'))).toBe(true);
  });
});
