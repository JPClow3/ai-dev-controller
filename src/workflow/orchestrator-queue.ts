import { overlappingOwnership } from '../git/integration.js';
import type { OrchestratorDeps, StepContext, StepResult } from './orchestrator-types.js';
import { move, recordOperationalRemediation } from './orchestrator-shared.js';

export function stepDependencyBlocked(ctx: StepContext, deps: OrchestratorDeps): StepResult {
  if (!deps.dependenciesMerged(ctx.run.issueId)) {
    return { from: ctx.run.state, to: null, action: 'waiting', detail: 'waiting for blocker merges' };
  }
  return move(ctx, deps, 'QUEUED', { reason: 'every explicit blocker is merged' });
}

export async function stepQueued(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  if (!deps.dependenciesMerged(ctx.run.issueId)) {
    return move(ctx, deps, 'DEPENDENCY_BLOCKED', { reason: 'blockers are not merged yet' });
  }

  // Fetch happens before the transition, because `freshBaseFetched` must be a
  // fact rather than an intention.
  const baseSha = await deps.fetchFreshBase(ctx);

  return move(ctx, deps, 'PLANNING', {
    reason: `dependencies merged; base ${baseSha.slice(0, 8)} fetched`,
    mechanicalFacts: { dependenciesMerged: true, capacityAvailable: true, freshBaseFetched: true },
  });
}

export async function stepPlanning(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const result = await deps.plan(ctx);

  if (result.blocked) {
    await deps.blockForHuman(ctx, 'unresolved_requirement', result.blocked);
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason: result.blocked });
  }

  // Prevention, not reconciliation: overlapping parallel tasks are the main
  // avoidable source of agent merge conflicts.
  const clashes = overlappingOwnership(
    result.tasks.map((t) => ({ id: t.id, owns: t.owns, blockedBy: t.blocked_by ?? [] })),
  );
  if (clashes.length > 0) {
    const detail = clashes.map((c) => `${c.a} and ${c.b} both own ${c.globs.join(', ')}`).join('; ');
    await deps.blockForHuman(ctx, 'plan_ownership_conflict', detail);
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason: `plan has overlapping ownership: ${detail}` });
  }

  await deps.createWorktrees(ctx, result.tasks);

  return move(ctx, deps, 'IMPLEMENTING', {
    reason: `${result.tasks.length} task(s) planned with disjoint ownership`,
    mechanicalFacts: { planValidated: true, ownershipSetsDisjoint: true, worktreesCreated: true },
  });
}

export async function stepImplementing(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const { allSettled, interrupted } = await deps.workersSettled(ctx);
  if (!allSettled) {
    return { from: ctx.run.state, to: null, action: 'waiting', detail: 'workers still running' };
  }
  if (interrupted.length > 0) {
    if (await deps.retryInterruptedWorkers(ctx, interrupted)) {
      return {
        from: ctx.run.state,
        to: null,
        action: 'waiting',
        detail: `relaunched interrupted worker(s): ${interrupted.join(', ')}`,
      };
    }
    const reason = `worker retry budget exhausted: ${interrupted.join(', ')}`;
    await deps.blockForHuman(ctx, 'retry_budget_exhausted', reason);
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason });
  }

  // A wave finishing is not the plan finishing. Tasks held back behind a
  // blocker become runnable exactly here, and integrating without them would
  // ship half a plan while reporting that every task reached a terminal state.
  const nextWave = await deps.dispatchNextWave(ctx);
  if (nextWave.started > 0 || nextWave.capacityBlocked) {
    const detail = nextWave.capacityBlocked
      ? `${nextWave.started} task(s) dispatched; waiting for worker capacity`
      : `${nextWave.started} task(s) dispatched in the next wave`;
    return { from: ctx.run.state, to: null, action: 'waiting', detail };
  }

  return move(ctx, deps, 'INTEGRATING', {
    reason: 'all workers reached a terminal state',
    mechanicalFacts: { allTasksTerminal: true },
  });
}

export async function stepIntegrating(ctx: StepContext, deps: OrchestratorDeps): Promise<StepResult> {
  const { conflicts, headSha } = await deps.integrate(ctx);

  if (conflicts.length > 0) {
    // Resolved in the parent, never by letting workers touch each other's trees.
    const tasks = conflicts.map((file, findingIndex) => ({
      findingIndex,
      file,
      acceptanceCriterion: null,
      instruction: `Resolve the integration conflict in ${file}. Keep both independently-owned changes unless their behavior is incompatible.`,
      suggestedValidation: 'Run the repository validation commands after resolving the conflict.',
      excludeAliases: deps.originalAuthors(ctx.run.id),
    }));
    recordOperationalRemediation(ctx, deps, tasks);
    return move(ctx, deps, 'REMEDIATING', {
      reason: `integration conflicts in ${conflicts.join(', ')}`,
    });
  }
  if (!headSha) {
    return move(ctx, deps, 'BLOCKED_HUMAN', { reason: 'no worker produced any commit' });
  }

  return move(ctx, deps, 'LOCAL_VALIDATION', {
    reason: `integrated at ${headSha.slice(0, 8)}`,
    mechanicalFacts: { integrationCommitPresent: true },
  });
}
