import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ControllerConfig } from '../config/load-config.js';
import type { ControllerRepositories } from '../state/repositories.js';
import type { Agents } from '../agents/roles.js';
import { reviewerCandidates } from '../agents/roles.js';
import type { OrcaClient } from '../orca/client.js';
import type { GitHub } from '../github/client.js';
import type { Git } from '../git/repository.js';
import { createIntegrator } from '../git/integration.js';
import type { GitRunner } from '../git/repository.js';
import { listTerminals, launchWorker, WORKER_PROMPT_FILE } from '../orca/terminals.js';
import { createWorkerWorktree } from '../orca/worktrees.js';
import { ensureDraftPullRequest, updatePullRequestBody, findPullRequestByBranch } from '../github/pull-requests.js';
import { readChecks } from '../github/checks.js';
import { renderPrBody, renderStubPrBody } from '../github/pr-body.js';
import { readValidationCommands, runRequiredValidation } from '../validation/local.js';
import { buildFinalReviewPacket, renderPacket } from '../reviews/packet.js';
import { toPrComments, type ReviewResult } from '../reviews/review.js';
import { authorshipByFamily } from '../routing/selector.js';
import { selectModel, type SelectorDeps } from '../routing/selector.js';
import { postBlockerQuestion } from '../linear/dependencies.js';
import { setAiLifecycleLabel } from '../linear/labels.js';
import type { OrchestratorDeps, PlanTask, StepContext } from './orchestrator.js';
import { logger } from '../util/log.js';

const log = logger('steps');

export interface StepsWiring {
  config: ControllerConfig;
  repos: ControllerRepositories;
  agents: Agents;
  orca: OrcaClient;
  github: GitHub;
  git: Git;
  gitRunner: GitRunner;
  routing: SelectorDeps;
  agentNameFor: (alias: string) => string;
  /** Set false in tests and dry runs so Linear is never written to. */
  writeToLinear?: boolean;
}

interface PlanResponse {
  verdict: 'planned' | 'blocked';
  blocked?: { reason: string; question: string };
  tasks?: PlanTask[];
}

/**
 * Concrete implementations of every orchestrator seam.
 *
 * The orchestrator was written against injected dependencies so it could be
 * tested without Orca, GitHub or a model. This is the other half: the real
 * bindings, assembled in one place so the composition is visible rather than
 * scattered through the state machine.
 */
export function createSteps(wiring: StepsWiring): OrchestratorDeps {
  const { config, repos, agents, orca, github, git } = wiring;
  const integrator = createIntegrator(wiring.gitRunner);
  const writeToLinear = wiring.writeToLinear !== false;

  function project(ctx: StepContext) {
    const entry = config.registry.projects[ctx.projectId];
    if (!entry) throw new Error(`Unregistered project "${ctx.projectId}"`);
    return entry;
  }

  function repoPath(ctx: StepContext): string {
    return project(ctx).repository.path;
  }

  function slug(ctx: StepContext): string {
    return project(ctx).repository.github;
  }

  function readIfPresent(base: string, relative: string): string {
    const path = join(base, relative);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  function issueContract(ctx: StepContext): string {
    const row = repos.getIssueContract(ctx.run.issueId);
    return row ?? `Issue ${ctx.run.issueId} (no curated body recorded)`;
  }

  return {
    config,
    repos,

    dependenciesMerged(issueId) {
      // Merged, and only merged. Every other signal is explicitly untrusted.
      return repos.getDependencies(issueId).every((d) => d.satisfiedAt !== null);
    },

    async fetchFreshBase(ctx) {
      return git.fetchFreshBase(repoPath(ctx), ctx.baseBranch);
    },

    async plan(ctx) {
      const decision = selectModel(
        { projectId: ctx.projectId, role: 'orchestrator', risk: ctx.risk },
        wiring.routing,
      );

      const response = await agents.plan<PlanResponse>(
        decision.alias,
        [
          issueContract(ctx),
          '',
          '## Repository instructions',
          readIfPresent(repoPath(ctx), 'AGENTS.md'),
          '',
          '## Validation commands available',
          readValidationCommands(repoPath(ctx))
            .map((c) => `- ${c.name}: ${c.command}${c.required ? ' (required)' : ''}`)
            .join('\n') || '- none declared',
          '',
          `Base branch: ${ctx.baseBranch}`,
        ].join('\n'),
      );

      if (response.verdict === 'blocked') {
        return { tasks: [], blocked: response.blocked?.question ?? 'planner reported a blocker' };
      }
      return { tasks: response.tasks ?? [] };
    },

    async createWorktrees(ctx, tasks) {
      const parent = ctx.run.orcaWorktreeId;
      if (!parent) throw new Error(`Run ${ctx.run.id} has no parent worktree`);

      // Persist the decomposition first: integration, reviewer selection and
      // the provenance body all read these rows, and a crash between creating
      // a worktree and recording it would orphan the work.
      repos.recordTasks(ctx.run.id, tasks);

      for (const task of tasks) {
        // A planner may return a task_category that is not a declared routing
        // role. Falling back is right; throwing here would escape advanceRun.
        const role = wiring.routing.routing.roles[task.task_category]
          ? task.task_category
          : 'routine_behavior';
        if (role !== task.task_category) {
          log.warn(`${ctx.run.issueId}/${task.id}: unknown task_category "${task.task_category}", routing as ${role}`);
        }

        const decision = selectModel(
          { projectId: ctx.projectId, role, risk: task.risk ?? 'low' },
          wiring.routing,
        );
        // No `--agent`: custom agents can only be registered through the Orca
        // GUI, which would make this un-runnable from a script. The worker is
        // launched as a plain command instead.
        const worktree = await createWorkerWorktree(orca, {
          parentSelector: `id:${parent}`,
          name: `${ctx.branch}/${task.id}`,
        });

        const profile = config.routing.aliases[decision.alias]?.profile;
        if (!profile) throw new Error(`Alias ${decision.alias} declares no Codex profile`);

        // The prompt goes to a file: it exceeds the Windows argv limit, and a
        // file also survives for inspection after the run.
        writeFileSync(join(worktree.path, WORKER_PROMPT_FILE), workerPrompt(ctx, task), 'utf8');
        await launchWorker(orca, {
          worktreeSelector: `id:${worktree.id}`,
          profile,
          title: `${ctx.run.issueId}/${task.id}`,
        });

        repos.recordTasks(ctx.run.id, [
          { ...task, branch: worktree.branch ?? `${ctx.branch}/${task.id}`, orcaWorktreeId: worktree.id },
        ]);
        repos.recordAttempt(ctx.run.id, task.id, {
          aliasId: decision.alias,
          role: 'worker',
          isChallenger: decision.isChallenger,
        });
        log.info(`${ctx.run.issueId}/${task.id}: dispatched to ${decision.alias}`);
      }
    },

    async workersSettled(ctx) {
      const terminals = await listTerminals(orca, `id:${ctx.run.orcaWorktreeId}`);
      const running = terminals.filter((t) => t.status === 'running');
      // A non-zero exit is an interrupted attempt, not a silent success.
      const interrupted = terminals
        .filter((t) => t.status !== 'running' && t.exitCode !== null && t.exitCode !== 0)
        .map((t) => t.handle);
      return { allSettled: running.length === 0, interrupted };
    },

    async integrate(ctx) {
      const workers = repos.workerCommits(ctx.run.id);
      const result = await integrator.integrate(repoPath(ctx), workers);
      return {
        conflicts: result.conflicts.flatMap((c) => c.files),
        headSha: result.headSha,
      };
    },

    async runValidation(ctx) {
      const commands = readValidationCommands(repoPath(ctx));
      const summary = await runRequiredValidation(repoPath(ctx), commands);
      // Stored so the PR body reports the run that actually gated the
      // transition, rather than a second execution whose results may differ.
      repos.recordValidation(ctx.run.id, summary);
      return summary;
    },

    async pushBranch(ctx) {
      await git.pushBranch(repoPath(ctx), ctx.branch, ctx.baseBranch, config.global.git.branchPrefix);
    },

    async ensureDraftPr(ctx) {
      // Stub body on purpose: this PR exists to trigger CI, and must not read
      // as reviewable work.
      return ensureDraftPullRequest(github, {
        slug: slug(ctx),
        head: ctx.branch,
        base: ctx.baseBranch,
        title: `${ctx.run.issueId}: in progress`,
        body: renderStubPrBody(ctx.run.issueId),
      });
    },

    async readChecks(ctx) {
      const pr = await findPullRequestByBranch(github, slug(ctx), ctx.branch);
      if (!pr) throw new Error(`No pull request for ${ctx.branch}`);
      return readChecks(github, slug(ctx), pr.number, project(ctx).ci.requiredChecks);
    },

    async review(ctx) {
      const baseSha = ctx.run.baseSha ?? ctx.baseBranch;
      const diff = await git.diffAgainst(repoPath(ctx), baseSha);
      const changed = await git.changedFiles(repoPath(ctx), baseSha);

      const packet = buildFinalReviewPacket({
        issueId: ctx.run.issueId,
        originalIssue: issueContract(ctx),
        curatedIssue: issueContract(ctx),
        acceptanceCriteria: repos.acceptanceCriteria(ctx.run.issueId),
        agentsMd: readIfPresent(repoPath(ctx), 'AGENTS.md'),
        architectureSummary: readIfPresent(repoPath(ctx), '.ai-workflow/generated/architecture-summary.md'),
        diff,
        changedFiles: changed.map((c) => c.path),
      });

      // The reviewer is chosen from the family least involved in authoring, so
      // no family grades its own homework.
      const authorship = authorshipByFamily(
        repos.attemptAuthorship(ctx.run.id),
        config.routing,
      );
      const { alias, data } = await agents.reviewFinal<ReviewResult>(
        authorship,
        reviewerCandidates(config.routing),
        renderPacket(packet),
      );

      return { ...data, reviewer: { ...data.reviewer, id: alias } };
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

      // Criterion status comes from the reviewer, never assumed. Hardcoding
      // `satisfied: true` made the deliverable claim success it had not
      // established.
      const unsatisfied = new Set([
        ...(assessment?.unsatisfiedCriteria ?? []),
        ...(assessment?.uncertainCriteria ?? []),
      ]);
      const reviewed = assessment !== null;

      const body = renderPrBody({
        issueId: ctx.run.issueId,
        summary: issueContract(ctx).split('\n').slice(0, 3).join(' '),
        criteria: criteria.map((c) => ({
          id: c.id,
          statement: c.statement,
          // With no review recorded nothing is established, so nothing is ticked.
          satisfied: reviewed && !unsatisfied.has(c.id),
        })),
        implementationNotes: attempts.map((a) => `- ${a.alias}: ${a.role}`).join('\n'),
        validation: validation.results.map((r) => ({ name: r.name, passed: r.passed })),
        planner: attempts.find((a) => a.role === 'planner')?.alias ?? 'unknown',
        workers: attempts.filter((a) => a.role === 'worker').map((a) => ({ alias: a.alias, taskSummary: a.taskKey ?? '' })),
        integrationReviewer: attempts.find((a) => a.role === 'integration_reviewer')?.alias ?? null,
        finalReviewer: attempts.find((a) => a.role === 'final_reviewer')?.alias ?? 'unknown',
        knowledgeStatus: project(ctx).knowledgeStatus === 'verified' ? 'VERIFIED' : 'UNVERIFIED',
        risks: unsatisfied.size > 0 ? [`${unsatisfied.size} acceptance criterion/criteria not established`] : [],
        // Non-blocking findings reach the human here or nowhere.
        reviewNotes: assessment ? toPrComments(assessment) : ['No review was recorded for this run.'],
        ...(ctx.run.baseSha ? { baseSha: ctx.run.baseSha } : {}),
        remediationCycles: repos.remediationCycles(ctx.run.id),
      });

      await updatePullRequestBody(github, slug(ctx), pr.number, body);
    },

    remediationCycles: (runId) => repos.remediationCycles(runId),
    originalAuthors: (runId) => repos.attemptSummary(runId).map((a) => a.alias),

    async dispatchRemediation(ctx) {
      log.info(`${ctx.run.issueId}: remediation dispatch`);
      // Remediation reuses the worker path; the packet is built by the caller
      // from the specific finding rather than restating the whole task.
    },

    async blockForHuman(ctx, trigger, question) {
      repos.recordEscalation(ctx.run.issueId, ctx.run.id, trigger, question);
      if (!writeToLinear) return;
      try {
        await postBlockerQuestion(ctx.run.issueId, question);
        await setAiLifecycleLabel(ctx.run.issueId, 'ai-blocked');
      } catch (err) {
        // Losing the Linear write must not lose the escalation itself.
        log.error(`${ctx.run.issueId}: could not write blocker to Linear`, err);
      }
    },
  };
}

function workerPrompt(ctx: StepContext, task: PlanTask): string {
  return [
    `You are implementing task "${task.id}" for issue ${ctx.run.issueId}.`,
    '',
    task.summary,
    '',
    '## You own ONLY these paths',
    ...task.owns.map((o) => `- ${o}`),
    '',
    'Editing anything outside this set is a scope violation. If the task cannot',
    'be completed without touching another path, stop and say so.',
    '',
    '## Acceptance criteria this task advances',
    ...task.acceptance_criteria.map((c) => `- ${c}`),
    '',
    `Base branch: ${ctx.baseBranch}. Never merge, never push to the base branch.`,
  ].join('\n');
}
