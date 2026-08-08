#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import pc from 'picocolors';
import { loadControllerConfig } from '../config/load-config.js';
import { openDatabase } from '../state/db.js';
import { createRepositories } from '../state/repositories.js';
import { defaultPressure, pressureFromOrca } from '../routing/pressure.js';
import { createOrcaClient, status as orcaStatus } from '../orca/client.js';
import { planBootstrap } from '../knowledge/bootstrap.js';
import { openBootstrapPullRequest } from '../knowledge/bootstrap-pr.js';
import { realGit } from '../git/repository.js';
import { createGitHub } from '../github/client.js';
import { reconcileAll, applicable } from '../recovery/reconcile.js';

/**
 * Operational escape hatch, not a daily tool. The normal loop is
 * Linear -> Orca -> GitHub, and v1 deliberately adds no fourth interface.
 */
const program = new Command();
program.name('ai-dev').description('Local AI development controller').version('0.1.0');

const ROOT = process.cwd();

function withDb<T>(fn: (deps: { config: ReturnType<typeof loadControllerConfig>; repos: ReturnType<typeof createRepositories>; close: () => void }) => T): T {
  const config = loadControllerConfig(ROOT);
  const db = openDatabase(config.global.paths.database);
  try {
    return fn({ config, repos: createRepositories(db), close: () => db.close() });
  } finally {
    db.close();
  }
}

program
  .command('config')
  .description('print the effective merged configuration')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean }) => {
    const config = loadControllerConfig(ROOT);
    if (opts.json) return void console.log(JSON.stringify(config, null, 2));
    console.log(pc.bold('concurrency'));
    for (const [k, v] of Object.entries(config.global.concurrency)) console.log(`  ${k.padEnd(22)}${v}`);
    console.log(pc.bold('\nrouting roles'));
    for (const [role, spec] of Object.entries(config.routing.roles)) {
      const challengers = spec.challengers.length ? ` (vs ${spec.challengers.join(', ')})` : '';
      console.log(`  ${role.padEnd(22)}${spec.champion}${pc.dim(challengers)}`);
    }
  });

program
  .command('projects')
  .description('registered repositories')
  .action(() => {
    const { registry } = loadControllerConfig(ROOT);
    const entries = Object.entries(registry.projects);
    if (entries.length === 0) return void console.log(pc.dim('None registered. Run `ai-dev onboard <path>`.'));
    for (const [id, p] of entries) {
      const flag = p.enabled ? pc.green('enabled') : pc.dim('disabled');
      console.log(
        `${id.padEnd(18)} ${flag}  ${p.repository.github.padEnd(32)} ${p.repository.baseBranch.padEnd(8)} ci:${p.ci.trigger.padEnd(13)} ${p.knowledgeStatus}`,
      );
    }
  });

program
  .command('status')
  .description('active runs and agent slot usage')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean }) =>
    withDb(({ config, repos }) => {
      const runs = repos.activeRuns();
      const escalations = repos.openEscalations();
      if (opts.json) return void console.log(JSON.stringify({ runs, escalations }, null, 2));

      console.log(`${runs.length} active / ${config.global.concurrency.activeIssues} issue slots`);
      for (const r of runs) {
        console.log(`  ${r.issueId.padEnd(12)} ${r.state.padEnd(18)} ${r.branch ?? ''}`);
      }
      if (runs.length === 0) console.log(pc.dim('  nothing running'));

      if (escalations.length > 0) {
        console.log(pc.bold(pc.yellow(`\n${escalations.length} waiting on you`)));
        for (const e of escalations) console.log(`  ${e.issueId.padEnd(12)} ${e.trigger}\n    ${e.question}`);
      }
    }),
  );

program
  .command('inspect <issue>')
  .description('full run detail for one issue')
  .action((issue: string) =>
    withDb(({ repos }) => {
      const run = repos.getActiveRun(issue);
      if (!run) return void console.log(pc.dim(`No active run for ${issue}.`));
      console.log(`${issue}  ${run.state}  attempt ${run.attempt}`);
      console.log(`  branch    ${run.branch ?? pc.dim('none')}`);
      console.log(`  worktree  ${run.orcaWorktreeId ?? pc.dim('none')}`);
      console.log(pc.bold('\n  history'));
      for (const s of repos.transitionHistory(run.id)) {
        console.log(`    ${(s.from ?? '-').padEnd(20)} -> ${s.to.padEnd(20)} ${s.reason ?? ''}`);
      }
      const deps = repos.getDependencies(issue);
      if (deps.length) {
        console.log(pc.bold('\n  dependencies'));
        for (const d of deps) {
          console.log(`    ${d.blockedBy.padEnd(14)} ${d.satisfiedAt ? pc.green('merged') : pc.yellow('waiting')}`);
        }
      }
    }),
  );

program
  .command('routes')
  .description('effective routing table and provider pressure')
  .action(async () => {
    const config = loadControllerConfig(ROOT);
    let pressure = defaultPressure(config.routing);

    // Real quota, read from Orca rather than assumed.
    try {
      const orca = createOrcaClient({ bin: config.global.orca.bin });
      const accounts = await orca.json<{ rateLimits?: Parameters<typeof pressureFromOrca>[0] }>(['account', 'list']);
      pressure = { ...pressure, ...(pressureFromOrca(accounts.rateLimits ?? {}) as typeof pressure) };
    } catch {
      console.log(pc.dim('(could not read live quota from Orca; showing defaults)\n'));
    }

    console.log(pc.bold('provider pressure'));
    for (const p of Object.values(pressure)) {
      const colour = p.pressure === 'EXHAUSTED' ? pc.red : p.pressure === 'HIGH' ? pc.yellow : pc.green;
      console.log(`  ${p.provider.padEnd(10)} ${colour(p.pressure.padEnd(10))} ${pc.dim(p.source)}`);
    }

    console.log(pc.bold('\nrole -> champion (challengers)'));
    for (const [role, spec] of Object.entries(config.routing.roles)) {
      const alias = config.routing.aliases[spec.champion]!;
      const usable = pressure[alias.provider]?.pressure !== 'EXHAUSTED';
      const name = usable ? spec.champion : pc.red(`${spec.champion} (unavailable)`);
      console.log(`  ${role.padEnd(22)}${name}${pc.dim(spec.challengers.length ? ` vs ${spec.challengers.join(', ')}` : '')}`);
    }
  });

program
  .command('metrics')
  .description('champion/challenger statistics')
  .action(() =>
    withDb(({ repos }) => {
      const stats = repos.routingStats();
      if (stats.length === 0) {
        return void console.log(pc.dim('No samples yet. Statistics accumulate as runs complete.'));
      }
      console.log('scope      project        role                alias           n    composite  success');
      for (const s of stats) {
        console.log(
          `${s.scope.padEnd(10)} ${(s.projectId ?? '-').padEnd(14)} ${s.role.padEnd(19)} ${s.aliasId.padEnd(15)} ${String(s.samples).padEnd(4)} ${(s.compositeAvg ?? 0).toFixed(3).padEnd(10)} ${((s.successRate ?? 0) * 100).toFixed(0)}%`,
        );
      }
    }),
  );

program
  .command('pause <issue>')
  .description('stop scheduling work for an issue')
  .action((issue: string) =>
    withDb(({ repos }) => {
      repos.setPaused(issue, true);
      console.log(`${issue} paused. In-flight agents are not killed; use Orca for that.`);
    }),
  );

program
  .command('resume <issue>')
  .description('resume a paused or human-blocked issue')
  .action((issue: string) =>
    withDb(({ repos }) => {
      repos.setPaused(issue, false);
      const run = repos.getActiveRun(issue);
      if (run?.state === 'BLOCKED_HUMAN') {
        repos.transitionRun(run.id, 'QUEUED', { reason: 'resumed by operator' });
        console.log(`${issue} unblocked and requeued.`);
      } else {
        console.log(`${issue} unpaused.`);
      }
    }),
  );

program
  .command('retry <issue>')
  .description('retry a failed run within policy budget')
  .action((issue: string) =>
    withDb(({ config, repos }) => {
      const run = repos.getActiveRun(issue);
      if (!run) return void console.log(pc.dim(`No active run for ${issue}.`));

      const used = repos.remediationCycles(run.id);
      const limit = config.escalation.limits.reviewRemediationCycles;
      if (used > limit) {
        // The budget is the point; a CLI override would defeat it.
        return void console.log(
          pc.red(`Budget exhausted (${used}/${limit} cycles). Resolve the blocker rather than retrying.`),
        );
      }
      repos.transitionRun(run.id, 'REMEDIATING', { reason: 'operator retry' });
      console.log(`${issue} queued for remediation (cycle ${used + 1}/${limit}).`);
    }),
  );

program
  .command('onboard <path>')
  .description('register a repository and open its knowledge-bootstrap PR')
  .option('--dry-run', 'show the plan without writing or pushing')
  .option('--project <id>', 'registry id (defaults to the folder name)')
  .action(async (path: string, opts: { dryRun?: boolean; project?: string }) => {
    const config = loadControllerConfig(ROOT);
    const id = opts.project ?? path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()!.toLowerCase();
    const entry = config.registry.projects[id];

    if (!entry) {
      console.error(pc.red(`"${id}" is not in projects/registry.yaml.`));
      console.error('Add it there first: the registry is the source of truth for paths and base branches.');
      process.exit(1);
    }

    const plan = planBootstrap({
      projectId: id,
      repoPath: entry.repository.path,
      baseBranch: entry.repository.baseBranch,
      discovery: {
        scanGlobs: config.global.knowledge.scanGlobs,
        excludeGlobs: config.global.knowledge.excludeGlobs,
        maxFileBytes: config.global.knowledge.maxFileBytes,
      },
    });

    console.log(`${id}  ${plan.derived.packageManager}  ci:${plan.ciTrigger}`);
    for (const c of plan.derived.commands) console.log(`  ${c.required ? 'required' : 'optional'}  ${c.command}`);
    for (const n of plan.derived.notes) console.log(pc.dim(`  note: ${n}`));
    console.log(`  would write: ${plan.files.map((f) => f.path).join(', ')}`);
    console.log(`  preserves ${plan.preserved.length} existing file(s)`);

    if (opts.dryRun) return void console.log(pc.dim('\nDry run; nothing written.'));

    const result = await openBootstrapPullRequest(plan, {
      git: realGit,
      github: createGitHub(),
      slug: entry.repository.github,
      branch: config.global.git.bootstrapBranch,
      baseBranch: entry.repository.baseBranch,
      branchPrefix: config.global.git.branchPrefix,
    });

    console.log(
      result.pullRequest
        ? pc.green(`\nPR #${result.pullRequest} on ${result.branch} (${result.action})`)
        : pc.yellow(`\n${result.action}: ${result.reason ?? 'no pull request opened'}`),
    );
  });

program
  .command('recover')
  .description('reconcile interrupted runs against Orca, git, GitHub and Linear')
  .option('--apply', 'apply the reconciliation instead of reporting it')
  .action((opts: { apply?: boolean }) =>
    withDb(({ repos }) => {
      const runs = repos.activeRuns();
      if (runs.length === 0) return void console.log(pc.dim('No incomplete runs.'));

      // Observation is left unpopulated here: the CLI reports what the
      // reconciler would conclude from controller state alone. The scheduler
      // fills in Orca/git/GitHub before acting.
      const reports = reconcileAll(
        runs.map((r) => ({
          runId: r.id,
          issueId: r.issueId,
          dbState: r.state,
          ciTrigger: 'pull_request' as const,
          orca: null,
          git: null,
          github: null,
          linear: null,
        })),
      );

      for (const report of reports) {
        const flag = applicable(report) ? pc.yellow(report.action) : pc.dim(report.action);
        console.log(`${report.issueId.padEnd(12)} ${report.dbState.padEnd(18)} -> ${report.derivedState.padEnd(18)} ${flag}`);
        console.log(pc.dim(`  ${report.reason}`));
        if (opts.apply && applicable(report)) {
          repos.transitionRun(report.runId, report.derivedState, {
            reason: `recovery: ${report.reason}`,
            mechanicalFacts: report.facts,
          });
        }
      }
      if (!opts.apply) console.log(pc.dim('\nReport only; pass --apply to reconcile.'));
    }),
  );

program
  .command('doctor')
  .description('check that everything the controller depends on is reachable')
  .action(async () => {
    const config = loadControllerConfig(ROOT);
    const checks: Array<[string, boolean, string]> = [];

    checks.push(['config', true, `${Object.keys(config.registry.projects).length} project(s) registered`]);
    checks.push(['LINEAR_API_KEY', Boolean(process.env['LINEAR_API_KEY']), 'required for issue polling']);

    try {
      const orca = createOrcaClient({ bin: config.global.orca.bin });
      const s = await orcaStatus(orca);
      checks.push(['orca', s.runtime.reachable && s.runtime.state === 'ready', `runtime ${s.runtime.state}`]);
    } catch (err) {
      checks.push(['orca', false, (err as Error).message.slice(0, 80)]);
    }

    for (const [name, ok, detail] of checks) {
      console.log(`${ok ? pc.green('ok  ') : pc.red('FAIL')} ${name.padEnd(18)} ${pc.dim(detail)}`);
    }
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
  });

program
  .command('run')
  .description('start the scheduler polling loop')
  .option('--once', 'run a single tick and exit')
  .action(async (opts: { once?: boolean }) => {
    const config = loadControllerConfig(ROOT);
    console.error(pc.yellow('The scheduler loop needs its dependencies wired to live services.'));
    console.error('Run `ai-dev doctor` first, then `ai-dev recover` to reconcile.');
    console.error(pc.dim(`Poll interval would be ${config.global.pollIntervalSeconds}s; once=${opts.once ?? false}.`));
    process.exitCode = 2;
  });

program
  .command('migrate')
  .description('create or update the controller database')
  .action(() =>
    withDb(({ config, repos: _r }) => {
      void _r;
      console.log(`${config.global.paths.database} ready`);
    }),
  );

program.parse();
