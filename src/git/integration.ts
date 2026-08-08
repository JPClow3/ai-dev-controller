import type { GitRunner } from './repository.js';
import { realGit } from './repository.js';

export interface WorkerCommits {
  taskKey: string;
  branch: string;
  /** Plan dependency order; integration follows it. */
  order: number;
  commits: string[];
}

export interface IntegrationResult {
  integrated: string[];
  conflicts: Array<{ taskKey: string; sha: string; files: string[] }>;
  headSha: string | null;
}

/**
 * Integrates worker commits into the issue's parent branch.
 *
 * Workers own disjoint path sets and commit on their own branches, so this is
 * usually mechanical. When it is not, the conflict is resolved in the parent by
 * the orchestrator — never by letting workers edit each other's trees, which is
 * how agent swarms corrupt each other's work.
 */
export function createIntegrator(git: GitRunner = realGit) {
  return {
    async integrate(parentPath: string, workers: WorkerCommits[]): Promise<IntegrationResult> {
      const ordered = [...workers].sort((a, b) => a.order - b.order);
      const integrated: string[] = [];
      const conflicts: IntegrationResult['conflicts'] = [];

      for (const worker of ordered) {
        for (const sha of worker.commits) {
          try {
            await git(parentPath, ['cherry-pick', '-x', sha]);
            integrated.push(sha);
          } catch {
            const files = await conflictedFiles(git, parentPath);
            // Leave the tree clean so the next attempt starts from a known
            // state rather than a half-applied cherry-pick.
            await git(parentPath, ['cherry-pick', '--abort']).catch(() => undefined);
            conflicts.push({ taskKey: worker.taskKey, sha, files });
            break;
          }
        }
      }

      const headSha = integrated.length > 0 ? await git(parentPath, ['rev-parse', 'HEAD']) : null;
      return { integrated, conflicts, headSha };
    },
  };
}

async function conflictedFiles(git: GitRunner, cwd: string): Promise<string[]> {
  try {
    const out = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Ownership overlap check, run before dispatch rather than after conflict.
 *
 * The design's single most cost-effective rule: if two tasks' declared paths
 * overlap, serialise them. Prevention is far cheaper than reconciliation.
 */
export function overlappingOwnership(
  tasks: Array<{ id: string; owns: string[]; blockedBy: string[] }>,
): Array<{ a: string; b: string; globs: string[] }> {
  const clashes: Array<{ a: string; b: string; globs: string[] }> = [];

  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      // Sequential tasks cannot race, so overlap between them is fine.
      if (a.blockedBy.includes(b.id) || b.blockedBy.includes(a.id)) continue;

      const shared = a.owns.filter((glob) => b.owns.some((other) => globsIntersect(glob, other)));
      if (shared.length > 0) clashes.push({ a: a.id, b: b.id, globs: shared });
    }
  }
  return clashes;
}

/**
 * Conservative overlap test: identical globs, or one prefix containing the
 * other. Being over-cautious here costs a little parallelism; being
 * under-cautious costs a corrupted integration.
 */
export function globsIntersect(a: string, b: string): boolean {
  if (a === b) return true;
  const prefix = (g: string) => g.replace(/\*\*.*$/, '').replace(/\*.*$/, '');
  const pa = prefix(a);
  const pb = prefix(b);
  if (!pa || !pb) return true;
  return pa.startsWith(pb) || pb.startsWith(pa);
}
