import { NotImplementedError } from '../util/errors.js';

/**
 * First-time repository onboarding.
 *
 *   REGISTER -> scan -> classify -> detect conflicts -> knowledge map
 *            -> bootstrap branch -> PR
 *
 * Soft gate: the project may execute issues at knowledge_status: unverified
 * while the bootstrap PR is still open.
 *
 * Existing documentation is MAPPED, never moved and never destroyed.
 */

export interface KnowledgeMap {
  sources: {
    architecture: string[];
    domain: string[];
    coding_conventions: string[];
    testing: string[];
    operational: string[];
    historical: string[];
  };
  exclude: string[];
}

export interface BootstrapResult {
  projectId: string;
  branch: string;
  prNumber: number | null;
  filesCreated: string[];
  conflictsFound: number;
}

export async function scanCandidates(_repoPath: string): Promise<string[]> {
  throw new NotImplementedError('bootstrap.scanCandidates');
}

/** Not every Markdown file becomes agent context. Aggressive exclusion is correct. */
export async function classify(_repoPath: string, _files: string[]): Promise<KnowledgeMap> {
  throw new NotImplementedError('bootstrap.classify');
}

/**
 * Derive validation commands from what the repo actually does - package
 * scripts, Makefile, tox, CI workflow. Never invent `pytest` because it is
 * Python.
 */
export async function deriveProjectYaml(_repoPath: string): Promise<string> {
  throw new NotImplementedError('bootstrap.deriveProjectYaml');
}

export async function onboard(_repoPath: string): Promise<BootstrapResult> {
  throw new NotImplementedError('bootstrap.onboard');
}
