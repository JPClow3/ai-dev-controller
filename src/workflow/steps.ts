import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ControllerConfig } from '../config/load-config.js';
import type { ControllerRepositories } from '../state/repositories.js';
import type { Agents } from '../agents/roles.js';
import { reviewerCandidates } from '../agents/roles.js';
import type { OrcaClient } from '../orca/client.js';
import type { GitHub } from '../github/client.js';
import type { Git } from '../git/repository.js';
import { createIntegrator } from '../git/integration.js';
import type { GitRunner } from '../git/repository.js';
import {
  launchWorker,
  readWorkerExit,
  workerScript,
  WORKER_PROMPT_FILE,
  WORKER_SCRIPT_FILE,
  WORKER_EXIT_FILE,
  WORKER_RESULT_FILE,
} from '../orca/terminals.js';
import { createWorkerWorktree, worktreePathFromId } from '../orca/worktrees.js';
import { ensureDraftPullRequest, updatePullRequestBody, findPullRequestByBranch } from '../github/pull-requests.js';
import { readChecks } from '../github/checks.js';
import { renderPrBody, renderStubPrBody } from '../github/pr-body.js';
import { readValidationCommands, readSetupCommand, runRequiredValidation } from '../validation/local.js';
import { buildFinalReviewPacket, renderPacket } from '../reviews/packet.js';
import { toPrComments, type ReviewResult } from '../reviews/review.js';
import { authorshipByFamily } from '../routing/selector.js';
import { isUsable } from '../routing/pressure.js';
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

  /**
   * Where this run's validation contract actually is.
   *
   * `.ai-workflow/project.yaml` is meant to be committed, by the bootstrap PR,
   * so it travels with the branch and a run on an old base is validated by the
   * rules of that base. Until that PR merges the file exists only in the
   * registry clone's working tree, and a fresh worktree checkout has none —
   * which silently produced a run with no setup command and no validation
   * commands at all, and a pull request whose body honestly reported that the
   * repository declared none.
   *
   * Falling back to the clone keeps the soft knowledge gate usable. Saying so
   * out loud every time keeps it from becoming the permanent arrangement.
   */
  function contractPath(ctx: StepContext): string {
    const tree = treePath(ctx);
    if (existsSync(join(tree, '.ai-workflow/project.yaml'))) return tree;

    const clone = repoPath(ctx);
    if (existsSync(join(clone, '.ai-workflow/project.yaml'))) {
      log.warn(
        `${ctx.run.issueId}: .ai-workflow/project.yaml is not committed; ` +
          `reading the validation contract from ${clone}. Merge the bootstrap PR so it travels with the branch.`,
      );
      return clone;
    }
    return tree;
  }

  /** Controller-owned scratch for one worker, deliberately not in the repo. */
  function workerControlDir(ctx: StepContext, taskKey: string): string {
    return resolve(config.rootDir, 'data', 'workers', ctx.run.id, taskKey);
  }

  function readIfPresent(base: string, relative: string): string {
    const path = join(base, relative);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  function issueContract(ctx: StepContext): string {
    const row = repos.getIssueContract(ctx.run.issueId);
    return row ?? `Issue ${ctx.run.issueId} (no curated body recorded)`;
  }

  /**
   * Creates a worker's worktree, writes its prompt and launcher, and starts it.
   *
   * Shared by the first wave and every later one so a task dispatched second
   * is dispatched identically to a task dispatched first.
   */
  async function dispatchTask(ctx: StepContext, task: PlanTask): Promise<void> {
    const parent = ctx.run.orcaWorktreeId;
    if (!parent) throw new Error(`Run ${ctx.run.id} has no parent worktree`);

    // A planner may return a task_category that is not a declared routing
    // role. Falling back is right; throwing here would escape advanceRun.
    const role = wiring.routing.routing.roles[task.task_category] ? task.task_category : 'routine_behavior';
    if (role !== task.task_category) {
      log.warn(`${ctx.run.issueId}/${task.id}: unknown task_category "${task.task_category}", routing as ${role}`);
    }

    const decision = selectModel({ projectId: ctx.projectId, role, risk: task.risk ?? 'low' }, wiring.routing);
    const profile = config.routing.aliases[decision.alias]?.profile;
    if (!profile) throw new Error(`Alias ${decision.alias} declares no Codex profile`);

    // No `--agent`: custom agents can only be registered through the Orca
    // GUI, which would make this un-runnable from a script. The worker is
    // launched as a plain command instead.
    // Flat name: Orca rejects a worktree name carrying the parent's path
    // separators, and the parent link already expresses the relationship.
    const worktree = await createWorkerWorktree(orca, {
      parentSelector: `id:${parent}`,
      repoSelector: `id:${parent.split('::')[0]}`,
      name: `${ctx.branch.replace(/\//g, '-')}-${task.id}`,
    });

    // Both go to files: the prompt exceeds the Windows argv limit, and the
    // files survive for inspection after the run. They go OUTSIDE the
    // worktree so they cannot end up in the worker's commit.
    const controlDir = workerControlDir(ctx, task.id);
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(join(controlDir, WORKER_PROMPT_FILE), workerPrompt(ctx, task), 'utf8');
    const setup = readSetupCommand(contractPath(ctx));
    writeFileSync(
      join(controlDir, WORKER_SCRIPT_FILE),
      workerScript(profile, controlDir, {
        ...(setup?.command ? { setupCommand: setup.command } : {}),
      }),
      'utf8',
    );

    await launchWorker(orca, {
      worktreeSelector: `id:${worktree.id}`,
      title: `${ctx.run.issueId}/${task.id}`,
      controlDir,
    });

    repos.recordTasks(ctx.run.id, [
      { ...task, branch: worktree.branch ?? `${ctx.branch}/${task.id}`, orcaWorktreeId: worktree.id },
    ]);
    repos.setTaskState(ctx.run.id, task.id, 'DISPATCHED');
    repos.recordAttempt(ctx.run.id, task.id, {
      aliasId: decision.alias,
      role: 'worker',
      isChallenger: decision.isChallenger,
    });
    log.info(`${ctx.run.issueId}/${task.id}: dispatched to ${decision.alias} (${profile})`);
  }

  /**
   * The worktree's tracked files, capped.
   *
   * Capped rather than truncated silently: a planner that is told it has the
   * whole tree, and is handed a third of it, will confidently declare
   * ownership of paths it never saw. The cap says so out loud.
   */
  async function trackedFiles(ctx: StepContext, limit = 600): Promise<string> {
    try {
      const out = await wiring.gitRunner(treePath(ctx), ['ls-files']);
      const files = out.split('\n').filter(Boolean);
      if (files.length <= limit) return files.join('\n');
      return [
        ...files.slice(0, limit),
        `... ${files.length - limit} more tracked file(s) not shown; ask for a subtree if you need them.`,
      ].join('\n');
    } catch {
      return '(file tree unavailable)';
    }
  }

  /**
   * Commits whatever a finished worker left uncommitted, within its own paths.
   *
   * Workers cannot commit for themselves: a linked worktree's git directory is
   * outside the sandbox's writable root, and granting it pushes codex onto a
   * Windows elevation helper that cannot run unattended. So the controller
   * does it — which turns out to be the better arrangement anyway. Staging by
   * pathspec makes the ownership rule mechanical: a change outside the
   * declared set cannot be committed, however convinced the model is that it
   * belonged. Files left dirty afterwards are reported as the scope violation
   * they are, rather than silently swept into the pull request.
   */
  async function commitWorkerChanges(
    ctx: StepContext,
    task: { id: string; summary: string; owns: string[] },
    workerPath: string,
    controlDir: string,
  ): Promise<void> {
    const run = (args: string[]) => wiring.gitRunner(workerPath, args);

    const dirty = await run(['status', '--porcelain']).catch(() => '');
    if (!dirty.trim()) return;

    // Pathspecs, not a hand-rolled glob matcher: git already knows how to
    // match `packages/shared/**` against a path, and getting that subtly
    // wrong would either drop the work or widen the scope.
    if (task.owns.length === 0) {
      log.warn(`${ctx.run.issueId}/${task.id}: uncommitted changes but no declared ownership; leaving them`);
      return;
    }
    await run(['add', '--', ...task.owns]).catch((err: unknown) => {
      log.warn(`${ctx.run.issueId}/${task.id}: could not stage owned paths`, (err as Error).message);
    });

    const staged = await run(['diff', '--cached', '--name-only']).catch(() => '');
    if (!staged.trim()) {
      log.warn(`${ctx.run.issueId}/${task.id}: changes exist but none inside ${task.owns.join(', ')}`);
      return;
    }

    // The worker's own account of what it did, so the commit says something
    // truer than a template would.
    const summary = readIfPresent(controlDir, WORKER_RESULT_FILE).split('\n')[0]?.trim() ?? '';
    const message = [
      `${ctx.run.issueId}: ${task.summary}`,
      '',
      summary || `Task ${task.id}.`,
      '',
      `Task: ${task.id}`,
      `Owned paths: ${task.owns.join(', ')}`,
    ].join('\n');

    await run(['commit', '-m', message]);
    log.info(`${ctx.run.issueId}/${task.id}: committed ${staged.split('\n').filter(Boolean).length} owned file(s)`);

    const leftover = await run(['status', '--porcelain']).catch(() => '');
    const outside = leftover
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    if (outside.length > 0) {
      log.warn(
        `${ctx.run.issueId}/${task.id}: left ${outside.length} change(s) outside its ownership, not committed: ${outside
          .slice(0, 5)
          .join(', ')}`,
      );
    }
  }

  /** Records what a finished worker actually committed on its own branch. */
  async function harvestCommits(
    ctx: StepContext,
    taskKey: string,
    workerPath: string,
    controlDir: string,
  ): Promise<Array<{ sha: string; message: string }>> {
    const baseSha = ctx.run.baseSha;
    if (!baseSha) return [];

    const commits = await git.commitsSince(workerPath, baseSha).catch((err: unknown) => {
      log.warn(`${ctx.run.issueId}/${taskKey}: could not read commits`, (err as Error).message);
      return [] as Array<{ sha: string; message: string }>;
    });

    // Oldest first, so cherry-picking replays the worker's own order.
    const ordered = [...commits].reverse();
    repos.recordAttemptResult(ctx.run.id, taskKey, {
      commits: ordered,
      finalMessage: readIfPresent(controlDir, WORKER_RESULT_FILE).slice(0, 4000),
    });
    return ordered;
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
          readIfPresent(treePath(ctx), 'AGENTS.md'),
          '',
          '## Validation commands available',
          readValidationCommands(contractPath(ctx))
            .map((c) => `- ${c.name}: ${c.command}${c.required ? ' (required)' : ''}`)
            .join('\n') || '- none declared',
          '',
          // The prompt tells the planner it receives the worktree's file tree.
          // It did not, so every `owns` glob was guessed from the issue text
          // alone — and a glob that matches nothing produces a worker with no
          // files it is allowed to touch.
          '## Repository tree (tracked files)',
          await trackedFiles(ctx),
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
      // Persist the decomposition first: integration, reviewer selection and
      // the provenance body all read these rows, and a crash between creating
      // a worktree and recording it would orphan the work.
      repos.recordTasks(ctx.run.id, tasks);

      // Dispatch only the tasks with no unsatisfied blockers.
      //
      // The ownership check deliberately PERMITS overlapping paths between
      // sequential tasks — serialising is how the design resolves a clash.
      // Launching every task regardless of `blocked_by` threw that guarantee
      // away: two workers were observed editing the same file concurrently,
      // which is precisely the corruption the rule exists to prevent.
      const runnable = tasks.filter((t) => (t.blocked_by ?? []).length === 0);

      if (runnable.length === 0 && tasks.length > 0) {
        throw new Error(
          `Every task in the plan declares a blocker; the dependency graph has no starting point.`,
        );
      }
      for (const task of tasks.filter((t) => (t.blocked_by ?? []).length > 0)) {
        log.info(`${ctx.run.issueId}/${task.id}: deferred behind ${(task.blocked_by ?? []).join(', ')}`);
      }
      for (const task of runnable) await dispatchTask(ctx, task);
    },

    /**
     * Launches the tasks whose blockers have all finished.
     *
     * Without this a plan containing any sequential step lost its dependent
     * half outright: the tasks were recorded, never launched, and the run
     * integrated only the first wave while reporting success.
     */
    async dispatchNextWave(ctx) {
      const tasks = repos.runTasks(ctx.run.id);
      const done = new Set(tasks.filter((t) => t.state === 'DONE').map((t) => t.id));

      const ready = tasks.filter(
        (t) => t.state === 'PENDING' && t.blocked_by.every((b) => done.has(b)),
      );
      for (const task of ready) {
        await dispatchTask(ctx, {
          id: task.id,
          summary: task.summary,
          task_category: task.task_category,
          owns: task.owns,
          blocked_by: task.blocked_by,
          acceptance_criteria: task.acceptance_criteria,
          ...(task.risk ? { risk: task.risk as NonNullable<PlanTask['risk']> } : {}),
        });
      }
      return ready.length;
    },

    /**
     * Whether every dispatched worker has finished.
     *
     * Read from each worker's own worktree, not from Orca. Orca terminals are
     * long-lived shells: `terminal list` reports neither a status nor an exit
     * code, so the previous check ("no terminal has status running") was
     * vacuously true on the first tick and every worker was declared settled
     * the instant it was launched. It also scoped the query to the PARENT
     * worktree, which never contains worker terminals at all.
     */
    async workersSettled(ctx) {
      const tasks = repos.runTasks(ctx.run.id).filter((t) => t.state === 'DISPATCHED');
      const interrupted: string[] = [];
      let pending = 0;

      for (const task of tasks) {
        if (!task.orcaWorktreeId) continue;
        const path = worktreePathFromId(task.orcaWorktreeId);
        const control = workerControlDir(ctx, task.id);
        const exit = readWorkerExit(readIfPresent(control, WORKER_EXIT_FILE) || null);

        if (exit === null) {
          pending += 1;
          continue;
        }
        if (exit !== 0) {
          repos.setTaskState(ctx.run.id, task.id, 'FAILED');
          repos.recordAttemptResult(ctx.run.id, task.id, { exitCode: exit, commits: [] });
          interrupted.push(task.id);
          continue;
        }

        // Commit, then harvest. The commits recorded here are the only thing
        // integration has to work with, and nothing was writing them, so every
        // run reached INTEGRATING and reported "no worker produced any
        // commit".
        await commitWorkerChanges(ctx, task, path, control).catch((err: unknown) => {
          log.error(`${ctx.run.issueId}/${task.id}: could not commit`, (err as Error).message);
        });
        const commits = await harvestCommits(ctx, task.id, path, control);
        repos.setTaskState(ctx.run.id, task.id, 'DONE');
        log.info(`${ctx.run.issueId}/${task.id}: finished with ${commits.length} commit(s)`);
      }

      return { allSettled: pending === 0, interrupted };
    },

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
      const setup = readSetupCommand(contractPath(ctx));
      const commands = [...(setup ? [setup] : []), ...readValidationCommands(contractPath(ctx))];
      const summary = await runRequiredValidation(treePath(ctx), commands);
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
      const diff = await git.diffAgainst(treePath(ctx), baseSha);
      const changed = await git.changedFiles(treePath(ctx), baseSha);

      const packet = buildFinalReviewPacket({
        issueId: ctx.run.issueId,
        originalIssue: issueContract(ctx),
        curatedIssue: issueContract(ctx),
        acceptanceCriteria: repos.acceptanceCriteria(ctx.run.issueId),
        agentsMd: readIfPresent(treePath(ctx), 'AGENTS.md'),
        architectureSummary: readIfPresent(treePath(ctx), '.ai-workflow/generated/architecture-summary.md'),
        diff,
        changedFiles: changed.map((c) => c.path),
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

      const issueUrl = repos.issueUrl(ctx.run.issueId);
      const body = renderPrBody({
        issueId: ctx.run.issueId,
        ...(issueUrl ? { issueUrl } : {}),
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
    '## Finishing',
    "This worktree's dependencies were installed for you before you started,",
    'so you can and should run the relevant tests before you finish.',
    '',
    'Leave your changes in the working tree. Do not commit, branch, merge or',
    'push — the controller commits the files you own, on the branch this',
    'worktree already has checked out, once you exit. Anything you change',
    'outside the paths above will NOT be committed and will be reported as a',
    'scope violation, so keep your edits inside them.',
    '',
    'Your last message becomes the commit description. Make it an accurate',
    'account of what you actually changed and what you verified.',
    '',
    `Base branch: ${ctx.baseBranch}. Never merge, never push to the base branch.`,
  ].join('\n');
}
