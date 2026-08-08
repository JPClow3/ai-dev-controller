import type { OrcaClient } from './client.js';

export interface OrcaWorktree {
  id: string;
  path: string;
  branch?: string;
  displayName?: string;
  repoId?: string;
  parentWorktreeId?: string | null;
}

export interface OrcaRepo {
  id: string;
  path: string;
  displayName: string;
  gitRemoteIdentity?: { canonicalKey: string; remoteUrl: string } | null;
}

export async function listRepos(client: OrcaClient): Promise<OrcaRepo[]> {
  const result = await client.json<{ repos: OrcaRepo[] }>(['repo', 'list']);
  return result.repos;
}

export async function listWorktrees(client: OrcaClient, repoSelector?: string): Promise<OrcaWorktree[]> {
  const args = ['worktree', 'list'];
  if (repoSelector) args.push('--repo', repoSelector);
  const result = await client.json<{ worktrees: OrcaWorktree[] }>(args);
  return result.worktrees ?? [];
}

export interface ParentWorktreeInput {
  repoSelector: string;
  name: string;
  baseBranch: string;
  /** Linear identifier, so Orca links the worktree to the ticket. */
  linearIssue?: string;
  agent?: string;
  prompt?: string;
}

/**
 * Creates the issue's parent worktree from a freshly fetched base ref.
 *
 * `--base-branch` is always passed explicitly. Letting Orca fall back to the
 * repo default would quietly branch `inova` from `main`, which does not exist
 * there — its default is `master`.
 */
export async function createParentWorktree(
  client: OrcaClient,
  input: ParentWorktreeInput,
): Promise<OrcaWorktree> {
  const args = [
    'worktree',
    'create',
    '--repo',
    input.repoSelector,
    '--name',
    input.name,
    '--base-branch',
    input.baseBranch,
    '--no-parent',
  ];
  if (input.linearIssue) args.push('--linear-issue', input.linearIssue);
  if (input.agent) args.push('--agent', input.agent);
  if (input.prompt) args.push('--prompt', input.prompt);

  return unwrapWorktree(await client.json(args));
}

/**
 * Orca wraps a single object under a named key: `result.worktree`, not the
 * worktree itself. Reading `.id` off the wrapper yields undefined, which then
 * gets stored as a null worktree id and surfaces much later as "run has no
 * parent worktree".
 */
export function unwrapWorktree(result: unknown): OrcaWorktree {
  const wrapped = (result as { worktree?: OrcaWorktree })?.worktree;
  const worktree = wrapped ?? (result as OrcaWorktree);
  if (!worktree?.id) {
    throw new Error(`Orca returned no worktree id: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return worktree;
}

export interface WorkerWorktreeInput {
  parentSelector: string;
  name: string;
  /**
   * Required even with `--parent-worktree`. Orca answers
   * "Missing repo selector. Pass --repo or run from inside an Orca-managed
   * worktree." otherwise — the parent link alone is not enough.
   */
  repoSelector: string;
  agent?: string;
  prompt?: string;
}

/**
 * Child worktree per worker.
 *
 * Filesystem isolation is the point: workers commit to their own branch and
 * never see or modify each other's trees. Integration happens once, in the
 * parent, where conflicts can be reasoned about centrally.
 */
export async function createWorkerWorktree(
  client: OrcaClient,
  input: WorkerWorktreeInput,
): Promise<OrcaWorktree> {
  const args = [
    'worktree',
    'create',
    '--name',
    input.name,
    '--repo',
    input.repoSelector,
    '--parent-worktree',
    input.parentSelector,
  ];
  if (input.agent) args.push('--agent', input.agent);
  if (input.prompt) args.push('--prompt', input.prompt);
  return unwrapWorktree(await client.json(args));
}

export async function removeWorktree(client: OrcaClient, selector: string, force = false): Promise<void> {
  const args = ['worktree', 'rm', '--worktree', selector];
  if (force) args.push('--force');
  await client.json(args);
}

/**
 * Everywhere a worktree could already exist.
 *
 * Checked before creating anything, because restarting the controller or Orca
 * must never produce LIN-123, LIN-123-2, LIN-123-copy. The controller DB is
 * only one of four places the truth can live.
 */
export interface ExistingWorkspace {
  controllerWorktreeId: string | null;
  orcaWorktree: OrcaWorktree | null;
  gitBranchExists: boolean;
  openPullRequest: number | null;
}

export function hasExistingWork(found: ExistingWorkspace): boolean {
  return (
    found.controllerWorktreeId !== null ||
    found.orcaWorktree !== null ||
    found.gitBranchExists ||
    found.openPullRequest !== null
  );
}

/** Resolves an Orca repo id from a `owner/repo` GitHub slug. */
export function findRepoBySlug(repos: OrcaRepo[], slug: string): OrcaRepo | null {
  const wanted = `github.com/${slug}`.toLowerCase();
  return (
    repos.find((r) => r.gitRemoteIdentity?.canonicalKey?.toLowerCase() === wanted) ?? null
  );
}

/**
 * The filesystem path an Orca worktree id points at.
 *
 * Orca ids are `<repoId>::<absolute path>`, and the path half is the only
 * place the controller can do git work. Using the registry's repository path
 * instead is a correctness bug, not a shortcut: that clone has the BASE branch
 * checked out, so cherry-picking into it lands worker commits on `main`, and
 * validating it validates code the run never produced.
 */
export function worktreePathFromId(worktreeId: string): string {
  const separator = worktreeId.indexOf('::');
  const path = separator === -1 ? '' : worktreeId.slice(separator + 2);
  if (!path) throw new Error(`Orca worktree id "${worktreeId}" carries no path`);
  return path;
}

/** `ai/UNI-142-add-filtering` — the branch naming the design fixes. */
export function branchNameFor(prefix: string, issueId: string, slug: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${prefix}${issueId}${clean ? `-${clean}` : ''}`;
}
