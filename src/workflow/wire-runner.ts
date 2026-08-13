import type { ControllerConfig } from '../config/load-config.js';
import type { ControllerRepositories } from '../state/repositories.js';
import type { OrcaClient } from '../orca/client.js';
import type { GitHub } from '../github/client.js';
import type { Agents } from '../agents/roles.js';
import type { DispatchDeps } from './dispatch.js';
import { createDispatcher } from './dispatch.js';
import type { RunnerDeps } from './runner.js';
import type { WorkItem } from '../scheduler/priority.js';
import type { CapacityState } from '../scheduler/capacity.js';
import type { SelectorDeps } from '../routing/selector.js';
import type { RoutingConfig } from '../config/routing-schema.js';
import { listIssuesByLabel, listIssuesCreatedBetween, getIssueContract, updateIssueContract, commentOnIssue } from '../linear/issues.js';
import { setAiLifecycleLabel } from '../linear/labels.js';
import { AUTO_CURATE_CURSOR_KEY, AUTO_CURATE_FLOOR_KEY, autoCurateNewIssues } from '../linear/auto-curate.js';
import { postBlockerNotice, postBlockerQuestion } from '../linear/dependencies.js';
import { listRecentlyMerged, issueIdFromBranch } from '../github/pull-requests.js';
import { applyQuotaCooldown, isProviderQuotaExhausted, refreshRuntimePressure } from '../routing/quota.js';
import { pressureFromOrca } from '../routing/pressure.js';
import { resolveRepository } from '../projects/resolver.js';
import { selectModel } from '../routing/selector.js';
import {
  curateIssues as processCuration,
  normalizeCuratedBody,
  type CuratedIssueResult,
  type CuratorIssue,
  type NeedsContext,
} from '../curation/curate.js';
import { logger } from '../util/log.js';
const log = logger('wire-runner');

export interface RunnerWiring {
  config: ControllerConfig;
  repos: ControllerRepositories;
  writeToLinear: boolean;
  recoverReality: () => Promise<{ appliedRunIds: string[] }>;
  advanceAll: (skipRunIds?: ReadonlySet<string>) => Promise<number>;
  projectKnowledge: (projectId: string) => string;
  mirrorProject: (projectId: string) => void;
  agents: Agents;
  routing: SelectorDeps;
  routingConfig: RoutingConfig;
  pressure: ReturnType<typeof import('../routing/pressure.js').defaultPressure>;
  disabled: string[];
  orca: OrcaClient;
  github: GitHub;
  dispatchDeps: DispatchDeps;
}

export function createRunnerDeps(wiring: RunnerWiring): RunnerDeps {
  const {
    config,
    repos,
    writeToLinear,
    recoverReality,
    advanceAll,
    projectKnowledge,
    mirrorProject,
    agents,
    routing,
    routingConfig,
    pressure,
    disabled,
    orca,
    github,
    dispatchDeps,
  } = wiring;
    return {
      config,
      repos,
  
      async reconcile() {
        const recovery = await recoverReality();
        const recovered = new Set(recovery.appliedRunIds);
        return recovered.size + (await advanceAll(recovered));
      },
  
      async adoptNewIssues() {
        // Dry runs must not consume the durable watermark: the same issues need
        // to remain visible when the controller is restarted with writes on.
        if (!writeToLinear) return 0;
        const report = await autoCurateNewIssues({
          getCursor: () => repos.getControllerMeta(AUTO_CURATE_CURSOR_KEY),
          setCursor: (value) => repos.setControllerMeta(AUTO_CURATE_CURSOR_KEY, value),
          getFloor: () => repos.getControllerMeta(AUTO_CURATE_FLOOR_KEY),
          setFloor: (value) => repos.setControllerMeta(AUTO_CURATE_FLOOR_KEY, value),
          fetchIssues: listIssuesCreatedBetween,
          resolveRepository(issue) {
            const resolution = resolveRepository(issue, config.registry);
            if (!resolution.ok) {
              return {
                ok: false,
                message: resolution.message,
                candidates: resolution.candidates,
              };
            }
            return {
              ok: true,
              projectId: resolution.projectId,
              context: projectKnowledge(resolution.projectId),
            };
          },
          setLifecycle: setAiLifecycleLabel,
          async requestContext(identifier, message, candidates) {
            await postBlockerNotice({
              issueId: identifier,
              trigger: 'curation_needs_context',
              reason: message,
              ...(candidates?.length ? { evidence: `- Candidate repositories: ${candidates.join(', ')}` } : {}),
            });
          },
        });
        for (const identifier of report.curationBlocked) {
          log.warn(`${identifier}: new issue is blocked during repository resolution`);
        }
        return report.adopted.length + report.curationBlocked.length;
      },
  
      async curateIssues() {
        const summaries = await listIssuesByLabel(config.global.linear.labels.curate);
        const rough: CuratorIssue[] = [];
        for (const summary of summaries) {
          const issue = await getIssueContract(summary.identifier);
          rough.push({
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description,
            labels: issue.labels,
            projectName: issue.projectName,
            url: issue.url,
          });
        }
  
        const report = await processCuration({
          fetchIssues: async () => rough,
          resolveRepository(issue) {
            const resolution = resolveRepository(issue, config.registry);
            if (!resolution.ok) {
              return {
                ok: false,
                message: resolution.message,
                candidates: resolution.candidates,
              };
            }
            return {
              ok: true,
              projectId: resolution.projectId,
              context: projectKnowledge(resolution.projectId),
            };
          },
          async invokeCurator(issue, repository) {
            const decision = selectModel(
              { projectId: repository.projectId, role: 'issue_cleanup', risk: 'low' },
              routing,
            );
            const input = JSON.stringify(
              {
                raw_issue: issue,
                resolved_repository: repository.projectId,
                repository_knowledge: repository.context,
                routing_categories: Object.keys(routingConfig.roles),
                sibling_issues: [],
              },
              null,
              2,
            );
            return agents.curate<CuratedIssueResult>(decision.alias, input);
          },
          async persistCurated(issue, result) {
            const projectId = result.repository!;
            const role = result.task_category!;
            if (!routingConfig.roles[role]) {
              throw new Error(`curator returned unknown task_category ${role}`);
            }
            mirrorProject(projectId);
            repos.upsertIssue({
              id: issue.identifier,
              projectId,
              title: issue.title,
              body: issue.description,
              url: issue.url,
            });
            const body = normalizeCuratedBody(result.body!, result.acceptance_criteria!);
            repos.recordCuratedIssue(issue.identifier, {
              title: result.title!,
              body,
              role,
              risk: result.risk!,
              acceptanceCriteria: result.acceptance_criteria!,
            });
            if (writeToLinear) {
              await updateIssueContract(issue.identifier, { title: result.title!, body });
              for (const proposal of result.dependency_proposals ?? []) {
                await commentOnIssue(
                  issue.identifier,
                  [
                    'AI dependency proposal (not applied):',
                    `- ${proposal.blocked_issue} blocked by ${proposal.blocking_issue}`,
                    `- Criterion: ${proposal.acceptance_criterion}`,
                    `- Reason: ${proposal.reason}`,
                    '',
                    'A human must approve and create this Linear relation.',
                  ].join('\n'),
                );
              }
            }
          },
          async requestContext(identifier, context: NeedsContext) {
            if (!writeToLinear) return;
            await postBlockerNotice({
              issueId: identifier,
              trigger: 'curation_needs_context',
              reason: context.reason,
              evidence: [
                ...context.questions.map((question) => `- ${question}`),
                ...(context.candidate_repositories?.length
                  ? [`- Candidate repositories: ${context.candidate_repositories.join(', ')}`]
                  : []),
              ].join('\n'),
            });
          },
          async setLifecycle(identifier, label) {
            if (writeToLinear) await setAiLifecycleLabel(identifier, label);
          },
          onFailure(issue, error) {
            if (!isProviderQuotaExhausted(error)) return 'continue';
            const resetAt = applyQuotaCooldown(repos, pressure, error);
            log.warn(
              `${issue.identifier}: ${error.provider} exhausted; curation paused until ${resetAt.toISOString()}`,
            );
            return 'stop';
          },
        });
  
        for (const failure of report.failed) {
          log.warn(`${failure.identifier}: curation failed`, failure.error);
        }
        return report.curated.length + report.curationBlocked.length;
      },
  
      async fetchReadyIssues() {
        const label = config.global.linear.labels.ready;
        const issues = await listIssuesByLabel(label);
        const out = [];
        for (const issue of issues) {
          // The contract read gives us the explicit blockers; inferred ones are
          // never trusted.
          const contract = await getIssueContract(issue.identifier);
          out.push({
            identifier: issue.identifier,
            title: issue.title,
            projectName: issue.projectName,
            description: contract.description,
            labels: issue.labels,
            blockedBy: contract.blockedBy,
            url: contract.url,
          });
        }
        return out;
      },
  
      async syncMergedPullRequests() {
        const merged: string[] = [];
        const slugs = new Set(
          Object.values(config.registry.projects).filter((p) => p.enabled).map((p) => p.repository.github),
        );
        for (const slug of slugs) {
          try {
            for (const pr of await listRecentlyMerged(github, slug, 30)) {
              const issueId = issueIdFromBranch(pr.headRefName, config.global.git.branchPrefix);
              if (issueId) merged.push(issueId);
            }
          } catch (err) {
            log.warn(`could not read merged PRs for ${slug}`, (err as Error).message);
          }
        }
        return merged;
      },
  
      async pendingWork(): Promise<WorkItem[]> {
        // Active runs are advanced by `reconcile`; they are not re-queued here,
        // or a run would be stepped twice in one tick.
        return [];
      },
  
      async capacityState(): Promise<CapacityState> {
        const runs = repos.activeRuns();
        return {
          activeIssues: runs.map((r) => r.issueId),
          agents: runs.map((r) => ({
            issueId: r.issueId,
            repositoryId: r.repositoryId,
            aliasId: 'active',
            provider: 'ollama' as const,
            heavy: false,
            luna: false,
          })),
        };
      },
  
      async remediationBacklog() {
        return repos.activeRuns().filter((r) => r.state === 'REMEDIATING').length;
      },
  
      async providerPressures() {
        // Start from every configured provider, then overlay what Orca reports.
        // Returning only the Orca-derived entry made "all providers EXHAUSTED"
        // true from a sample of one: a spent Codex quota throttled the whole
        // controller even though Ollama was idle and usable.
        let observed = {};
        try {
          const accounts = await orca.json<{ rateLimits?: Parameters<typeof pressureFromOrca>[0] }>([
            'account',
            'list',
          ]);
          observed = pressureFromOrca(accounts.rateLimits ?? {});
        } catch {
          // No quota data is not the same as no quota.
        }
        refreshRuntimePressure(
          pressure,
          config.routing,
          repos.activeProviderPressures(),
          disabled,
          observed,
        );
        return Object.values(pressure).map((p) => p.pressure);
      },
  
      dispatch: createDispatcher(dispatchDeps),
  
      async markCurationBlocked(identifier, message) {
        repos.recordEscalation(identifier, '', 'repository_resolution_ambiguous', message);
        if (!writeToLinear) return;
        await postBlockerQuestion(identifier, message, 'repository_resolution_ambiguous').catch(() => undefined);
        await setAiLifecycleLabel(identifier, 'ai-blocked').catch(() => undefined);
      },
  
      async flagCycle(identifiers) {
        const message = `Dependency cycle detected: ${identifiers.join(' -> ')}. It cannot resolve on its own.`;
        for (const id of identifiers) {
          repos.recordEscalation(id, '', 'dependency_cycle_detected', message);
          if (writeToLinear) await postBlockerQuestion(id, message, 'dependency_cycle_detected').catch(() => undefined);
        }
      },
    };
}
