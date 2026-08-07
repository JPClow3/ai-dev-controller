import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface KnowledgeCandidate {
  /** Repository-relative, forward-slashed. */
  path: string;
  bytes: number;
  truncated: boolean;
  content: string;
}

export interface DiscoveryOptions {
  scanGlobs: string[];
  excludeGlobs: string[];
  maxFileBytes: number;
}

/**
 * Minimal glob matcher covering the subset the config actually uses:
 * `**` (any depth), `*` (within a segment), and literals.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slashSuffix = glob[i + 2] === '/';
        out += slashSuffix ? '(?:.*/)?' : '.*';
        i += slashSuffix ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if ('.+^${}()|[]\\/?'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

function walk(root: string, dir: string, acc: string[], excluded: RegExp[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = relative(root, full).split(sep).join('/');
    if (excluded.some((re) => re.test(rel) || re.test(`${rel}/`))) continue;

    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      // Cheap prune so we never descend into node_modules or .git.
      if (excluded.some((re) => re.test(`${rel}/x`))) continue;
      walk(root, full, acc, excluded);
    } else if (stats.isFile()) {
      acc.push(rel);
    }
  }
}

/**
 * Finds candidate knowledge files.
 *
 * Discovery only reads. Existing documentation is mapped, never moved and
 * never deleted — a repository may be messy and that is allowed.
 */
export function discoverKnowledgeFiles(repoPath: string, options: DiscoveryOptions): KnowledgeCandidate[] {
  const excluded = options.excludeGlobs.map(globToRegExp);
  const all: string[] = [];
  walk(repoPath, repoPath, all, excluded);

  const matched = all.filter(
    (rel) => matchesAny(rel, options.scanGlobs) && !matchesAny(rel, options.excludeGlobs),
  );

  return matched.sort().map((rel) => {
    const full = join(repoPath, rel);
    const bytes = statSync(full).size;
    const raw = readFileSync(full, 'utf8');
    const truncated = bytes > options.maxFileBytes;
    return {
      path: rel,
      bytes,
      truncated,
      content: truncated ? raw.slice(0, options.maxFileBytes) : raw,
    };
  });
}
