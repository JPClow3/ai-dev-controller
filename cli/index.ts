#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../src/config/index.js';

/**
 * Operational escape hatch, not a daily tool. Normal workflow is
 * Linear -> Orca -> GitHub. v1 deliberately ships no web dashboard: Orca is
 * the agent interface, Linear is the issue interface, GitHub is the review
 * interface. A fourth interface would be wasted work.
 */

const program = new Command();

program
  .name('ai-dev')
  .description('Thin deterministic controller for Orca agent orchestration')
  .version('0.1.0');

function todo(command: string): never {
  console.error(pc.yellow(`NOT_IMPLEMENTED: ${command}`));
  console.error(pc.dim('Scaffold only. See docs/v1-scope.md for the implementation checklist.'));
  process.exit(2);
}

program
  .command('status')
  .description('active runs and agent slot usage')
  .action(() => todo('status'));

program
  .command('projects')
  .description('registered repositories')
  .action(() => todo('projects'));

program
  .command('onboard <path>')
  .description('register a repository and open its knowledge-bootstrap PR')
  .action(() => todo('onboard'));

program
  .command('inspect <issue>')
  .description('full run detail for one issue')
  .action(() => todo('inspect'));

program.command('pause <issue>').description('pause an issue').action(() => todo('pause'));
program.command('resume <issue>').description('resume an issue').action(() => todo('resume'));
program.command('cancel <issue>').description('cancel a run').action(() => todo('cancel'));
program.command('retry <issue>').description('retry within policy budget').action(() => todo('retry'));

program
  .command('routes')
  .description('effective routing table and provider pressure')
  .action(() => todo('routes'));

program
  .command('metrics')
  .description('champion/challenger statistics')
  .action(() => todo('metrics'));

program
  .command('run')
  .description('start the scheduler polling loop')
  .option('--once', 'single tick then exit')
  .action(() => todo('run'));

program
  .command('config')
  .description('print the effective merged configuration')
  .action(() => {
    const cfg = loadConfig();
    console.log(JSON.stringify({ global: cfg.global, routing: cfg.routing }, null, 2));
  });

program.parse();
