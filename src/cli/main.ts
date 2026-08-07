#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import pc from 'picocolors';
import { loadControllerConfig } from '../config/load-config.js';
import { openDatabase } from '../state/db.js';
import { createRepositories } from '../state/repositories.js';

/**
 * Operational escape hatch, not a daily tool. The normal loop is
 * Linear -> Orca -> GitHub, and v1 deliberately adds no fourth interface.
 */
const program = new Command();

program.name('ai-dev').description('Local AI development controller').version('0.1.0');

function notYet(command: string): never {
  console.error(pc.yellow(`${command}: not implemented yet`));
  console.error(pc.dim('See docs/implementation-plan.md for the task that delivers it.'));
  process.exit(2);
}

program
  .command('config')
  .description('print the effective merged configuration')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean }) => {
    const config = loadControllerConfig(process.cwd());
    if (opts.json) {
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    console.log(pc.bold('concurrency'));
    for (const [k, v] of Object.entries(config.global.concurrency)) console.log(`  ${k.padEnd(22)}${v}`);
    console.log(pc.bold('\nrouting roles'));
    for (const [role, spec] of Object.entries(config.routing.roles)) {
      const challengers = spec.challengers.length > 0 ? ` (vs ${spec.challengers.join(', ')})` : '';
      console.log(`  ${role.padEnd(22)}${spec.champion}${pc.dim(challengers)}`);
    }
  });

program
  .command('projects')
  .description('registered repositories')
  .action(() => {
    const { registry } = loadControllerConfig(process.cwd());
    const entries = Object.entries(registry.projects);
    if (entries.length === 0) {
      console.log(pc.dim('No repositories registered. Run `ai-dev onboard <path>`.'));
      return;
    }
    for (const [id, project] of entries) {
      const flag = project.enabled ? pc.green('enabled') : pc.dim('disabled');
      console.log(`${id.padEnd(24)} ${flag}  ${project.repository.github}  ${project.knowledgeStatus}`);
    }
  });

program
  .command('status')
  .description('active runs and agent slot usage')
  .action(() => {
    const config = loadControllerConfig(process.cwd());
    const db = openDatabase(config.global.paths.database);
    try {
      const runs = db.raw
        .prepare(`SELECT issue_id, state, branch FROM runs WHERE state NOT IN ('MERGED','FAILED','CANCELLED')`)
        .all() as Array<{ issue_id: string; state: string; branch: string | null }>;

      console.log(`${runs.length} active / ${config.global.concurrency.activeIssues} issue slots`);
      for (const run of runs) {
        console.log(`  ${run.issue_id.padEnd(12)} ${run.state.padEnd(18)} ${run.branch ?? ''}`);
      }
      if (runs.length === 0) console.log(pc.dim('  nothing running'));
    } finally {
      db.close();
    }
  });

program
  .command('migrate')
  .description('create or update the controller database')
  .action(() => {
    const config = loadControllerConfig(process.cwd());
    const db = openDatabase(config.global.paths.database);
    const tables = db.raw
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table'`)
      .get() as { n: number };
    db.close();
    console.log(`${config.global.paths.database} ready (${tables.n} tables)`);
  });

program
  .command('inspect <issue>')
  .description('full run detail for one issue')
  .action((issue: string) => {
    const config = loadControllerConfig(process.cwd());
    const db = openDatabase(config.global.paths.database);
    try {
      const repos = createRepositories(db);
      const run = repos.getActiveRun(issue);
      if (!run) {
        console.log(pc.dim(`No active run for ${issue}.`));
        return;
      }
      console.log(`${issue}  ${run.state}  attempt ${run.attempt}`);
      console.log(`  branch    ${run.branch ?? pc.dim('none')}`);
      console.log(`  worktree  ${run.orcaWorktreeId ?? pc.dim('none')}`);
      console.log(pc.bold('\n  history'));
      for (const step of repos.transitionHistory(run.id)) {
        console.log(`    ${(step.from ?? '-').padEnd(20)} -> ${step.to.padEnd(20)} ${step.reason ?? ''}`);
      }
      const deps = repos.getDependencies(issue);
      if (deps.length > 0) {
        console.log(pc.bold('\n  dependencies'));
        for (const dep of deps) {
          const status = dep.satisfiedAt ? pc.green('merged') : pc.yellow('waiting');
          console.log(`    ${dep.blockedBy.padEnd(14)} ${status}`);
        }
      }
    } finally {
      db.close();
    }
  });

program.command('onboard <path>').description('register a repository').action(() => notYet('onboard'));
program.command('pause <issue>').description('pause an issue').action(() => notYet('pause'));
program.command('resume <issue>').description('resume an issue').action(() => notYet('resume'));
program.command('retry <issue>').description('retry within policy budget').action(() => notYet('retry'));
program.command('routes').description('effective routing and pressure').action(() => notYet('routes'));
program.command('metrics').description('champion/challenger stats').action(() => notYet('metrics'));

program.parse();
