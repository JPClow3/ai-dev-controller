import type { ControllerRepositories } from '../state/repositories.js';
import type { RunRecord } from '../state/types.js';
import type { CiTrigger } from '../workflow/states.js';
import { canRecoverAuthoritatively } from '../workflow/transitions.js';
import {
  applicable,
  reconcileRun,
  type ObservedRun,
  type ReconciliationReport,
} from './reconcile.js';

type MaybePromise<T> = T | Promise<T>;

export interface RuntimeRecoveryDeps {
  repos: ControllerRepositories;
  /** Report-only mode for the operational CLI. Defaults to true. */
  apply?: boolean;
  ciTriggerFor: (run: RunRecord) => CiTrigger;
  observeOrca: (run: RunRecord) => MaybePromise<ObservedRun['orca']>;
  observeGit: (run: RunRecord) => MaybePromise<ObservedRun['git']>;
  observeGitHub: (run: RunRecord) => MaybePromise<ObservedRun['github']>;
  observeLinear: (run: RunRecord) => MaybePromise<ObservedRun['linear']>;
  onApplied?: (run: RunRecord, report: ReconciliationReport) => MaybePromise<void>;
}

export interface RuntimeRecoveryResult {
  reports: ReconciliationReport[];
  appliedRunIds: string[];
  observationErrors: Array<{ runId: string; system: 'orca' | 'git' | 'github' | 'linear'; message: string }>;
}

/**
 * Reconciles every incomplete run against observed external reality.
 *
 * Active-work probes intentionally run in the order in the design: Orca,
 * Git, GitHub, then Linear. Human-blocked runs need only GitHub so an explicit
 * human merge is still discovered without repeatedly polling dormant systems.
 * Each failure becomes an unknown (`null`) observation,
 * never evidence that the external object does not exist. This distinction is
 * what keeps a temporary provider outage from turning a healthy run into a
 * human blocker during startup.
 */
export async function reconcileIncompleteRuns(deps: RuntimeRecoveryDeps): Promise<RuntimeRecoveryResult> {
  const reports: ReconciliationReport[] = [];
  const appliedRunIds: string[] = [];
  const observationErrors: RuntimeRecoveryResult['observationErrors'] = [];

  for (const run of deps.repos.activeRuns()) {
    const probe = async <K extends 'orca' | 'git' | 'github' | 'linear'>(
      system: K,
      read: () => MaybePromise<ObservedRun[K]>,
    ): Promise<ObservedRun[K]> => {
      try {
        return await read();
      } catch (error) {
        observationErrors.push({
          runId: run.id,
          system,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };

    const humanBlocked = run.state === 'BLOCKED_HUMAN';
    const orca = humanBlocked ? null : await probe('orca', () => deps.observeOrca(run));
    const git = humanBlocked ? null : await probe('git', () => deps.observeGit(run));
    const github = await probe('github', () => deps.observeGitHub(run));
    const linear = humanBlocked ? null : await probe('linear', () => deps.observeLinear(run));
    const ciTrigger = deps.ciTriggerFor(run);

    const report = reconcileRun({
      runId: run.id,
      issueId: run.issueId,
      dbState: run.state,
      ciTrigger,
      localValidationPassed: deps.repos.lastValidation(run.id)?.passed === true,
      orca,
      git,
      github,
      linear,
    });
    reports.push(report);

    if (deps.apply === false) continue;
    if (
      github?.pullRequestNumber !== null &&
      github?.url &&
      github.headBranch &&
      github.baseBranch
    ) {
      // The external side effect can succeed immediately before the process
      // dies. Persist every complete GitHub observation, including a noop
      // reconciliation, so restart recovery also repairs that crash window.
      deps.repos.recordPullRequest(run.id, {
        number: github.pullRequestNumber,
        url: github.url,
        draft: github.isDraft,
        headBranch: github.headBranch,
        baseBranch: github.baseBranch,
      });
    }
    const evidence = {
      reason: `recovery: ${report.reason}`,
      mechanicalFacts: report.facts,
      ciTrigger,
    };
    if (applicable(report)) {
      deps.repos.transitionRun(run.id, report.derivedState, evidence);
    } else if (canRecoverAuthoritatively(run.state, report.derivedState, report.facts)) {
      deps.repos.recoverRunState(run.id, report.derivedState, evidence);
    } else {
      continue;
    }
    appliedRunIds.push(run.id);
    await deps.onApplied?.(run, report);
  }

  return { reports, appliedRunIds, observationErrors };
}
