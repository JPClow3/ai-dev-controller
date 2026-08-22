import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createIntegrator } from '../git/integration.js';
import { reviewerCandidates } from '../agents/roles.js';
import { ensureDraftPullRequest, updatePullRequestBody, findPullRequestByBranch } from '../github/pull-requests.js';
import { readChecks } from '../github/checks.js';
import { renderPrBody, renderStubPrBody } from '../github/pr-body.js';
import {
  readEffectiveSetupCommandAtBaseSha,
  readValidationContractAtBaseSha,
  runRequiredValidation,
} from '../validation/local.js';
import { buildFinalReviewPacket, renderPacket } from '../reviews/packet.js';
import { toPrComments, type ReviewResult } from '../reviews/review.js';
import { authorshipByFamily } from '../routing/selector.js';
import { isUsable } from '../routing/pressure.js';
import { postBlockerQuestion } from '../linear/dependencies.js';
import { setAiLifecycleLabel } from '../linear/labels.js';
import type { OrchestratorDeps, StepContext } from './orchestrator.js';
import { logger } from '../util/log.js';
import { finalizeRunScores } from '../scoring/runtime.js';
import type { StepsWiring } from './step-types.js';
import { createWorkerStepHandlers } from './step-workers.js';

export type { StepsWiring } from './step-types.js';
export {
  alignRemediationWorktree,
  cleanFailedAttempt,
  effectiveTaskRisk,
  formatWorkerCommitMessage,
  remediationPlanTasks,
  shouldWaitForExistingWorkerLaunch,
  workerTerminalTitle,
  workerWorktreeName,
} from './step-helpers.js';
export type { WorkerCommitMessageInput } from './step-helpers.js';

const log = logger('steps');

/**
 * Concrete implementations of every orchestrator seam.
 *
 * The orchestrator was written against injected dependencies so it could be
 * tested without Orca, GitHub or a model. This is the other half: the real
 * bindings, assembled in one place so the composition is visible rather than
 * scattered through the state machine.
 */
export function createSteps(wiring: StepsWiring): OrchestratorDeps {
  const { config, repos, agents, github, git } = wiring;
  const integrator = createIntegrator(wiring.gitRunner);
  const writeToLinear = wiring.writeToLinear !== false;

  function project(ctx: StepContext) {
    const entry = config.registry.projects[ctx.projectId];
    if (!entry) throw new Error(`Unregistered project "${ctx.projectId}"`);
    return entry;
  }

  /** The registry clone. Only correct before the worktree exists. */
  function repoPath(ctx: StepContext): string {
    return project(ctx).repository.path;
  }

  /**
   * Where this run's code actually lives.
   *
   * Everything after PLANNING — integration, validation, the review diff, the
   * push — must run here. `repoPath` has the base branch checked out.
   */
  function treePath(ctx: StepContext): string {
    if (!ctx.worktreePath) {
      throw new Error(`Run ${ctx.run.id} has no parent worktree path; cannot operate on the base clone`);
    }
    return ctx.worktreePath;
  }

  function slug(ctx: StepContext): string {
    return project(ctx).repository.github;
  }

  /** Controller-owned scratch for one worker, deliberately not in the repo. */
  function workerControlDir(ctx: StepContext, taskKey: string): string {
    return resolve(config.rootDir, 'data', 'workers', ctx.run.id, taskKey);
  }

  function readIfPresent(base: string, relative: string): string {
    const path = join(base, relative);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  /** Bounded full-file context so review can see relevant unchanged tests. */
  function changedFileContext(base: string, paths: string[]): Record<string, string> {
    const files: Record<string, string> = {};
    let remaining = 96_000;
    for (const relative of paths) {
      if (remaining <= 0) break;
      const path = join(base, relative);
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, 'utf8');
        if (content.includes('\0')) continue;
        const excerpt = content.slice(0, Math.min(24_000, remaining));
        files[relative] = excerpt;
        remaining -= excerpt.length;
      } catch {
        // Deleted, binary or unreadable files remain represented by the diff.
      }
    }
    return files;
  }

  function issueContract(ctx: StepContext): string {
    const row = repos.getIssueContract(ctx.run.issueId);
    return row ?? `Issue ${ctx.run.issueId} (no curated body recorded)`;
  }

  const workerSteps = createWorkerStepHandlers({
    wiring,
    repoPath,
    treePath,
    workerControlDir,
    readIfPresent,
    issueContract,
  });


  return {
    config,
    repos,

    dependenciesMerged(issueId) {
      // Merged, and only merged. Every other signal is explicitly untrusted.
      return repos.getDependencies(issueId).every((d) => d.satisfiedAt !== null);
    },

    ...workerSteps,


    async integrate(ctx) {
      const workers = repos.workerCommits(ctx.run.id);
      const result = await integrator.integrate(treePath(ctx), workers);
      return {
        conflicts: result.conflicts.flatMap((c) => c.files),
        headSha: result.headSha,
      };
    },

    async runValidation(ctx) {
      // Setup first, and inside the same summary: a fresh worktree has no
      // installed dependencies, so without it every command fails for a
      // reason unrelated to the change. Recording it as a result rather than
      // hiding it means a failed install reads as a failed install.
      const baseSha = ctx.run.baseSha;
      const contract = baseSha
        ? await readValidationContractAtBaseSha(treePath(ctx), baseSha)
        : { source: 'none' as const, setup: null, commands: [] };
      const setup = baseSha
        ? await readEffectiveSetupCommandAtBaseSha(treePath(ctx), baseSha)
        : null;
      const summary = contract.source !== 'base-sha'
        ? {
            passed: false,
            failedRequired: ['setup'],
            results: [{
              name: 'setup',
              command: baseSha
                ? `immutable validation contract unavailable at ${baseSha}`
                : 'immutable validation contract requires a recorded base SHA',
              exitCode: 125,
              passed: false,
              required: true,
              durationMs: 0,
              stdoutTail: '',
              stderrTail: 'Refused to validate without an immutable base contract.',
              timedOut: false,
            }],
          }
        : await runRequiredValidation(
            treePath(ctx),
            [...(setup ? [setup] : []), ...contract.commands],
            {
              ...(baseSha ? { baseSha } : {}),
              safety: config.global.safety.forbiddenOperations,
            },
          );
      // Stored so the PR body reports the run that actually gated the
      // transition, rather than a second execution whose results may differ.
      repos.recordValidation(ctx.run.id, summary);
      return summary;
    },

    async pushBranch(ctx) {
      await git.pushBranch(treePath(ctx), ctx.branch, ctx.baseBranch, config.global.git.branchPrefix);
    },

    async ensureDraftPr(ctx) {
      // Stub body on purpose: this PR exists to trigger CI, and must not read
      // as reviewable work.
      const pr = await ensureDraftPullRequest(github, {
        slug: slug(ctx),
        head: ctx.branch,
        base: ctx.baseBranch,
        title: `${ctx.run.issueId}: in progress`,
        body: renderStubPrBody(ctx.run.issueId),
      });
      repos.recordPullRequest(ctx.run.id, {
        number: pr.number,
        url: pr.url,
        draft: pr.isDraft,
        headBranch: pr.headRefName,
        baseBranch: pr.baseRefName,
      });
      return pr;
    },

    async readChecks(ctx) {
      const pr = await findPullRequestByBranch(github, slug(ctx), ctx.branch);
      if (!pr) throw new Error(`No pull request for ${ctx.branch}`);
      const checks = await readChecks(github, slug(ctx), pr.number, project(ctx).ci.requiredChecks);
      repos.recordCiObservation(ctx.run.id, checks);
      return checks;
    },

    async retryEnvironmentalCi(ctx, checks) {
      const failedRuns = [...new Set(
        checks.checks
          .filter((check) => check.required && checks.failed.includes(check.name))
          .map((check) => check.githubRunId)
          .filter((id): id is number => id !== undefined),
      )];
      if (failedRuns.length === 0) return false;

      // Retry only failures whose raw evidence is unmistakably external. A
      // product/test failure must proceed to ordinary remediation instead of
      // being relabelled flaky because rerunning is cheaper.
      const environmental = /(?:\b(?:403|429|5\d\d)\b.*(?:Forbidden|rate limit|Service Unavailable)|runner (?:was|has been) lost|timed? out|network (?:error|failure)|ECONNRESET|ETIMEDOUT)/i;
      for (const runId of failedRuns) {
        if (repos.ciRetryRequested(ctx.run.id, runId)) return false;
        const failureLog = await github.text(['run', 'view', String(runId), '--repo', slug(ctx), '--log-failed']);
        if (!environmental.test(failureLog)) return false;
      }

      for (const runId of failedRuns) {
        await github.text(['run', 'rerun', String(runId), '--repo', slug(ctx), '--failed']);
        repos.recordCiRetry(ctx.run.id, checks.headSha, runId, checks.checks);
      }
      return true;
    },

    async review(ctx) {
      const baseSha = ctx.run.baseSha ?? ctx.baseBranch;
      const diff = await git.diffAgainst(treePath(ctx), baseSha);
      const changed = await git.changedFiles(treePath(ctx), baseSha);
      const pr = await findPullRequestByBranch(github, slug(ctx), ctx.branch);
      const checks = pr
        ? await readChecks(github, slug(ctx), pr.number, project(ctx).ci.requiredChecks)
        : undefined;
      const localValidation = checks ? null : repos.lastValidation(ctx.run.id);

      const packet = buildFinalReviewPacket({
        issueId: ctx.run.issueId,
        originalIssue: issueContract(ctx),
        curatedIssue: issueContract(ctx),
        acceptanceCriteria: repos.acceptanceCriteria(ctx.run.issueId),
        agentsMd: readIfPresent(treePath(ctx), 'AGENTS.md'),
        architectureSummary: readIfPresent(treePath(ctx), '.ai-workflow/generated/architecture-summary.md'),
        diff,
        changedFiles: changed.map((c) => c.path),
        currentFiles: changedFileContext(treePath(ctx), changed.map((c) => c.path)),
        ...(checks ? { checks } : {}),
        ...(localValidation ? { localValidation } : {}),
      });

      // The reviewer is chosen from the family least involved in authoring, so
      // no family grades its own homework.
      const authorship = authorshipByFamily(
        repos.attemptAuthorship(ctx.run.id),
        config.routing,
      );
      // Pressure applies to reviewers too. Selecting purely on family picked
      // the *least involved* one, which is exactly the family most likely to
      // be the one that is disabled or out of quota — the review then failed
      // instead of falling back to a reachable reviewer.
      const candidates = reviewerCandidates(config.routing).filter((id) => {
        const spec = config.routing.aliases[id];
        return spec ? isUsable(wiring.routing.pressure, spec.provider) : false;
      });
      if (candidates.length === 0) throw new Error('No reachable reviewer: every provider is EXHAUSTED');

      const { alias, data } = await agents.reviewFinal<ReviewResult>(
        authorship,
        candidates,
        renderPacket(packet),
      );

      return {
        ...data,
        // The old schema did not require an empty findings array. Normalize at
        // the provider boundary as well as tightening the schema so a model
        // omission can never crash the scheduler after the result is stored.
        findings: Array.isArray(data.findings) ? data.findings : [],
        criteria: Array.isArray(data.criteria) ? data.criteria : [],
        reviewer: { ...data.reviewer, id: alias },
      };
    },

    async pullRequestIsDraft(ctx) {
      const pr = await findPullRequestByBranch(github, slug(ctx), ctx.branch);
      return pr?.isDraft === true;
    },

    async writeProvenanceBody(ctx, assessment) {
      const pr = await findPullRequestByBranch(github, slug(ctx), ctx.branch);
      if (!pr) throw new Error(`No pull request for ${ctx.branch}`);

      const validation = repos.lastValidation(ctx.run.id) ?? (await this.runValidation(ctx));
      const criteria = repos.acceptanceCriteria(ctx.run.issueId);
      const attempts = repos.attemptSummary(ctx.run.id);
      const finalReview = repos.lastReview(ctx.run.id);

      // Criterion status comes from the reviewer, never assumed. Hardcoding
      // `satisfied: true` made the deliverable claim success it had not
      // established.
      const explicitStatus = new Map(finalReview?.criteria.map((criterion) => [criterion.id, criterion.status]) ?? []);
      const unsatisfied = new Set(criteria
        .filter((criterion) => explicitStatus.get(criterion.id) !== 'satisfied')
        .map((criterion) => criterion.id));

      const issueUrl = repos.issueUrl(ctx.run.issueId);
      const body = renderPrBody({
        issueId: ctx.run.issueId,
        ...(issueUrl ? { issueUrl } : {}),
        summary: issueContract(ctx).split('\n').slice(0, 3).join(' '),
        criteria: criteria.map((c) => ({
          id: c.id,
          statement: c.statement,
          // With no review recorded nothing is established, so nothing is ticked.
          satisfied: explicitStatus.get(c.id) === 'satisfied',
        })),
        implementationNotes: attempts.map((a) => `- ${a.alias}: ${a.role}`).join('\n'),
        validation: validation.results.map((r) => ({ name: r.name, passed: r.passed, command: r.command })),
        planner: attempts.find((a) => a.role === 'planner')?.alias ?? 'unknown',
        workers: attempts.filter((a) => a.role === 'worker').map((a) => ({ alias: a.alias, taskSummary: a.taskKey ?? '' })),
        integrationReviewer: attempts.find((a) => a.role === 'integration_reviewer')?.alias ?? null,
        finalReviewer:
          finalReview?.reviewer.id ?? attempts.find((a) => a.role === 'final_reviewer')?.alias ?? 'unknown',
        knowledgeStatus: project(ctx).knowledgeStatus === 'verified' ? 'VERIFIED' : 'UNVERIFIED',
        risks: unsatisfied.size > 0 ? [`${unsatisfied.size} acceptance criterion/criteria not established`] : [],
        // Non-blocking findings reach the human here or nowhere.
        reviewNotes: assessment ? toPrComments(assessment) : ['No review was recorded for this run.'],
        ...(ctx.run.baseSha ? { baseSha: ctx.run.baseSha } : {}),
        remediationCycles: repos.remediationCycles(ctx.run.id),
      });

      const title = repos.issueTitle(ctx.run.issueId);
      await updatePullRequestBody(
        github,
        slug(ctx),
        pr.number,
        body,
        title ? `${ctx.run.issueId}: ${title}` : ctx.run.issueId,
      );
    },

    async recordScores(ctx) {
      return finalizeRunScores({ run: ctx.run, repos, git, scoring: config.scoring });
    },

    remediationCycles: (runId) => repos.remediationCycles(runId),
    originalAuthors: (runId) => repos.attemptSummary(runId).map((a) => a.alias),


    async blockForHuman(ctx, trigger, question) {
      repos.recordEscalation(ctx.run.issueId, ctx.run.id, trigger, question);
      if (!writeToLinear) return;
      try {
        await postBlockerQuestion(ctx.run.issueId, question, trigger);
        await setAiLifecycleLabel(ctx.run.issueId, 'ai-blocked');
      } catch (err) {
        // Losing the Linear write must not lose the escalation itself.
        log.error(`${ctx.run.issueId}: could not write blocker to Linear`, err);
      }
    },
  };
}
