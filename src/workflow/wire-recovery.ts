import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ControllerConfig } from '../config/load-config.js';
import type { ControllerRepositories } from '../state/repositories.js';
import type { Git } from '../git/repository.js';
import type { GitHub } from '../github/client.js';
import type { OrcaClient } from '../orca/client.js';
import { getIssueContract } from '../linear/issues.js';
import { findPullRequestByBranch } from '../github/pull-requests.js';
import { readChecks } from '../github/checks.js';
import { readWorkerExit, WORKER_EXIT_FILE } from '../orca/terminals.js';
import {
  reconcileIncompleteRuns,
  type RuntimeRecoveryResult,
} from '../recovery/runtime.js';
import { listWorktrees, worktreePathFromId } from '../orca/worktrees.js';
import { matchesRequestedBranch } from './dispatch.js';
import { finalizeRunScores } from '../scoring/runtime.js';
import { projectToLinear, projectToOrcaBoard } from './states.js';
import { logger } from '../util/log.js';

const log = logger('wire-recovery');

export interface RecoveryWiring {
  config: ControllerConfig;
  repos: ControllerRepositories;
  orca: OrcaClient;
  git: Git;
  github: GitHub;
  syncLinear: (issueId: string, state: Parameters<typeof projectToLinear>[0]) => Promise<void>;
  /** Moves the run's worktree to its board column. Optional: presentation only. */
  syncBoard?: (
    issueId: string,
    worktreeId: string | null,
    state: Parameters<typeof projectToOrcaBoard>[0],
  ) => Promise<void>;
}

/** Reconciles durable state with Orca, Git, GitHub and Linear observations. */
export function createRecovery(wiring: RecoveryWiring): (apply?: boolean) => Promise<RuntimeRecoveryResult> {
  const { config, repos, orca, git, github, syncLinear } = wiring;

  return async function recoverReality(apply = true): Promise<RuntimeRecoveryResult> {
    // At most one Orca list per recovery pass, shared by every active run.
    // Create it lazily: a pass containing only human-blocked runs needs no
    // Orca observation and must not fail because the desktop app is closed.
    let worktrees: ReturnType<typeof listWorktrees> | undefined;
    const observedWorktrees = () => {
      worktrees ??= listWorktrees(orca);
      return worktrees;
    };

    const result = await reconcileIncompleteRuns({
      repos,
      apply,
      ciTriggerFor(run) {
        return config.registry.projects[run.repositoryId]?.ci.trigger ?? 'pull_request';
      },

      async observeOrca(run) {
        const all = await observedWorktrees();
        const parent = all.find(
          (w) => w.id === run.orcaWorktreeId || (run.branch ? matchesRequestedBranch(w, run.branch) : false),
        );
        const tasks = repos.runTasks(run.id);
        const firstWave = tasks.filter((task) => task.blocked_by.length === 0);
        const planningComplete = tasks.length > 0
          && firstWave.length > 0
          && firstWave.every((task) => Boolean(task.orcaWorktreeId));
        const dispatched = tasks.filter((task) => task.state === 'DISPATCHED');
        const exits = dispatched.map((task) => {
          const path = join(config.rootDir, 'data', 'workers', run.id, task.id, WORKER_EXIT_FILE);
          return readWorkerExit(existsSync(path) ? readFileSync(path, 'utf8') : null);
        });
        const agentRunning = exits.some((exit) => exit === null);
        const implementationPending = tasks.some((task) => task.state !== 'DONE');
        const agentSettled = tasks.length > 0 && !agentRunning && tasks.every((task) =>
          task.state === 'DONE' || task.state === 'FAILED' || task.state === 'PENDING' || task.state === 'DISPATCHED',
        );
        return {
          worktreeExists: Boolean(parent),
          planningComplete,
          implementationPending,
          agentRunning,
          agentSettled,
        };
      },

      async observeGit(run) {
        const project = config.registry.projects[run.repositoryId];
        if (!project || !run.branch) {
          return { branchExists: false, hasCommitsBeyondBase: false, branchPushed: false };
        }
        const worktreePath = run.orcaWorktreeId ? worktreePathFromId(run.orcaWorktreeId) : '';
        const repositoryPath = worktreePath && existsSync(worktreePath) ? worktreePath : project.repository.path;
        const branchExists = await git.branchExists(repositoryPath, run.branch);
        const branchPushed = await git.remoteBranchExists(repositoryPath, run.branch);
        const hasCommitsBeyondBase = Boolean(
          run.baseSha &&
            worktreePath &&
            existsSync(worktreePath) &&
            (await git.commitsSince(worktreePath, run.baseSha)).length > 0,
        );
        const workerShas = run.state === 'INTEGRATING'
          ? repos.workerCommits(run.id).flatMap((worker) => worker.commits)
          : [];
        const integrationPending = workerShas.length > 0 && (
          !worktreePath ||
          !existsSync(worktreePath) ||
          (await Promise.all(workerShas.map((sha) => git.patchPresent(worktreePath, sha))))
            .some((present) => !present)
        );
        return { branchExists, hasCommitsBeyondBase, branchPushed, integrationPending };
      },

      async observeGitHub(run) {
        const project = config.registry.projects[run.repositoryId];
        if (!project || !run.branch) {
          return {
            pullRequestNumber: null,
            isDraft: false,
            merged: false,
            checksComplete: false,
            requiredChecksPassed: false,
          };
        }
        const pr = await findPullRequestByBranch(github, project.repository.github, run.branch);
        if (!pr) {
          return {
            pullRequestNumber: null,
            isDraft: false,
            merged: false,
            checksComplete: false,
            requiredChecksPassed: false,
          };
        }
        if (pr.merged) {
          // Merge truth is already authoritative. CI is valuable scoring
          // evidence, but an optional checks outage must not hide the merge
          // and keep downstream dependencies blocked.
          try {
            const checks = await readChecks(github, project.repository.github, pr.number, project.ci.requiredChecks);
            repos.recordCiObservation(run.id, checks);
          } catch (error) {
            log.warn(`${run.issueId}: merged PR checks unavailable during recovery - ${(error as Error).message}`);
          }
          return {
            pullRequestNumber: pr.number,
            url: pr.url,
            isDraft: pr.isDraft,
            headBranch: pr.headRefName,
            baseBranch: pr.baseRefName,
            merged: true,
            checksComplete: true,
            requiredChecksPassed: true,
          };
        }
        const checks = await readChecks(github, project.repository.github, pr.number, project.ci.requiredChecks);
        // Recovery evidence must be usable by routing too. Otherwise a crash
        // that authoritatively fast-forwards CI silently degrades its score to
        // the neutral missing-telemetry value.
        repos.recordCiObservation(run.id, checks);
        return {
          pullRequestNumber: pr.number,
          url: pr.url,
          isDraft: pr.isDraft,
          headBranch: pr.headRefName,
          baseBranch: pr.baseRefName,
          merged: false,
          checksComplete: checks.complete,
          requiredChecksPassed: checks.allRequiredPassed,
        };
      },

      async observeLinear(run) {
        const issue = await getIssueContract(run.issueId);
        const lifecycle = issue.labels.find((label) => label.startsWith('ai-')) ?? null;
        return { label: lifecycle };
      },

      async onApplied(run, report) {
        if (!apply) return;
        await syncLinear(run.issueId, report.derivedState);
        await wiring.syncBoard?.(run.issueId, run.orcaWorktreeId, report.derivedState);
        if (report.derivedState === 'MERGED') {
          await finalizeRunScores({ run, repos, git, scoring: config.scoring }).catch((error: unknown) => {
            log.warn(`${run.issueId}: merge-recovery scoring deferred - ${(error as Error).message}`);
          });
        }
      },
    });

    for (const failure of result.observationErrors) {
      log.warn(`${failure.runId}: ${failure.system} recovery probe failed`, failure.message);
    }
    return result;
  };
}
