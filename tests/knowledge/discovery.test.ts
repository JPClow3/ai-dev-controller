import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { discoverKnowledgeFiles, globToRegExp, matchesAny } from '../../src/knowledge/discovery.js';
import { buildKnowledgeMap, activeSources } from '../../src/knowledge/manifest.js';
import { loadControllerConfig } from '../../src/config/load-config.js';

const FIXTURE = join(process.cwd(), 'tests/fixtures/sample-repo');
const knowledge = loadControllerConfig(process.cwd()).global.knowledge;

const options = {
  scanGlobs: knowledge.scanGlobs,
  excludeGlobs: knowledge.excludeGlobs,
  maxFileBytes: knowledge.maxFileBytes,
};

function paths(): string[] {
  return discoverKnowledgeFiles(FIXTURE, options).map((c) => c.path);
}

describe('globToRegExp', () => {
  it('matches ** across directory depth', () => {
    expect(globToRegExp('**/README*.md').test('docs/deep/README.md')).toBe(true);
    expect(globToRegExp('**/README*.md').test('README.md')).toBe(true);
  });

  it('keeps * inside a single segment', () => {
    expect(globToRegExp('docs/*.md').test('docs/a.md')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docs/nested/a.md')).toBe(false);
  });

  it('matches a directory subtree', () => {
    expect(globToRegExp('node_modules/**').test('node_modules/pkg/README.md')).toBe(true);
  });
});

describe('discoverKnowledgeFiles', () => {
  it('finds the real documentation', () => {
    const found = paths();
    expect(found).toContain('README.md');
    expect(found).toContain('CLAUDE.md');
    expect(found).toContain('docs/architecture.md');
  });

  it('excludes vendored and generated content', () => {
    const found = paths();
    expect(found).not.toContain('node_modules/pkg/README.md');
    expect(found).not.toContain('vendor/NOTES.md');
    expect(found).not.toContain('generated/schema.md');
    expect(found).not.toContain('docs/archive/old.md');
  });

  it('ignores non-markdown source files', () => {
    expect(paths()).not.toContain('src/app.ts');
  });

  it('returns file contents so the classifier can read rather than guess', () => {
    const readme = discoverKnowledgeFiles(FIXTURE, options).find((c) => c.path === 'README.md');
    expect(readme?.content).toContain('Project overview');
    expect(readme?.truncated).toBe(false);
  });

  it('caps oversized files instead of loading them whole', () => {
    const capped = discoverKnowledgeFiles(FIXTURE, { ...options, maxFileBytes: 8 });
    const readme = capped.find((c) => c.path === 'README.md');
    expect(readme?.truncated).toBe(true);
    expect(readme?.content.length).toBe(8);
  });

  it('does not modify the repository it scans', () => {
    const before = readdirSync(FIXTURE).sort();
    discoverKnowledgeFiles(FIXTURE, options);
    expect(readdirSync(FIXTURE).sort()).toEqual(before);
  });

  it('returns a stable, sorted order', () => {
    expect(paths()).toEqual([...paths()].sort());
  });
});

describe('matchesAny', () => {
  it('honours the configured exclude list', () => {
    expect(matchesAny('node_modules/x/README.md', knowledge.excludeGlobs)).toBe(true);
    expect(matchesAny('docs/architecture.md', knowledge.excludeGlobs)).toBe(false);
  });
});

describe('buildKnowledgeMap', () => {
  it('groups documents by category', () => {
    const map = buildKnowledgeMap([
      { path: 'docs/architecture.md', category: 'architecture', confidence: 0.9, summary: 'modules' },
      { path: 'CLAUDE.md', category: 'coding_conventions', confidence: 0.8, summary: 'style' },
    ]);
    expect(map.sources.architecture).toEqual(['docs/architecture.md']);
    expect(map.sources.coding_conventions).toEqual(['CLAUDE.md']);
    expect(map.sources.domain).toEqual([]);
  });

  it('keeps historical notes mapped but out of agent context', () => {
    const map = buildKnowledgeMap([
      { path: 'docs/architecture.md', category: 'architecture', confidence: 0.9, summary: 'current' },
      { path: 'docs/old-api.md', category: 'historical_notes', confidence: 0.9, summary: 'superseded' },
    ]);
    expect(map.sources.historical_notes).toContain('docs/old-api.md');
    expect(activeSources(map)).toContain('docs/architecture.md');
    expect(activeSources(map)).not.toContain('docs/old-api.md');
  });

  it('records conflicts without resolving them', () => {
    const map = buildKnowledgeMap([], [], [
      {
        topic: 'test runner',
        sources: ['README.md', 'docs/testing.md'],
        description: 'README says jest, docs/testing.md says pytest',
      },
    ]);
    expect(map.conflicts).toHaveLength(1);
    expect(map.conflicts[0]!.sources).toHaveLength(2);
  });

  it('does not duplicate a path listed twice', () => {
    const map = buildKnowledgeMap([
      { path: 'a.md', category: 'domain', confidence: 1, summary: '' },
      { path: 'a.md', category: 'domain', confidence: 1, summary: '' },
    ]);
    expect(map.sources.domain).toEqual(['a.md']);
  });
});
