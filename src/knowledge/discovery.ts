import { readdirSync, statSync, readFileSync, type Dirent } from 'node:fs';
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

/**
 * Directories never worth descending into.
 *
 * Checked by name before any filesystem call. Glob-matching every path was
 * measured at ~90s for one repository and hung on a larger one: on Windows a
 * per-entry `statSync` is expensive, and by the time a glob rejects
 * `node_modules/.../deep/file` the walk has already paid for the whole
 * subtree.
 */
const ALWAYS_PRUNE = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.pnpm-store',
  'target',
]);

function walk(root: string, dir: string, acc: string[], excluded: RegExp[], depth = 0): void {
  // Documentation does not live 12 levels down; this bounds pathological trees.
  if (depth > 10) return;

  let entries: Dirent[];
  try {
    // withFileTypes avoids a separate statSync per entry, which is the bulk of
    // the cost on Windows.
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;

    const name = entry.name;
    if (entry.isDirectory() && ALWAYS_PRUNE.has(name)) continue;

    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join('/');

    if (entry.isDirectory()) {
      if (excluded.some((re) => re.test(`${rel}/`))) continue;
      walk(root, full, acc, excluded, depth + 1);
    } else if (entry.isFile()) {
      // Only Markdown is ever a knowledge candidate; rejecting by extension
      // first avoids running every glob over every source file.
      if (!name.toLowerCase().endsWith('.md')) continue;
      if (excluded.some((re) => re.test(rel))) continue;
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
