import 'dotenv/config';
import { loadControllerConfig } from './config/load-config.js';

/**
 * Controller entry point.
 *
 * Tasks 1-5 (config, state, Linear, resolution, scheduling) are implemented.
 * The polling runner is Task 12 and is not wired yet, so this validates the
 * environment and reports what is ready rather than pretending to run.
 */
async function main(): Promise<void> {
  const config = loadControllerConfig(process.cwd());

  console.log('ai-dev-controller');
  console.log(`  poll interval      ${config.global.pollIntervalSeconds}s`);
  console.log(
    `  concurrency        ${config.global.concurrency.activeIssues} issues / ` +
      `${config.global.concurrency.workersPerIssue} workers per issue / ` +
      `${config.global.concurrency.globalAgents} agents`,
  );
  console.log(`  routing aliases    ${Object.keys(config.routing.aliases).length}`);
  console.log(`  roles              ${Object.keys(config.routing.roles).length}`);
  console.log(`  registered repos   ${Object.keys(config.registry.projects).length}`);

  const missing = ['LINEAR_API_KEY'].filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.log(`\n  missing env        ${missing.join(', ')}  (copy .env.example to .env)`);
  }

  console.log('\nThe scheduler loop is Task 12 and is not implemented yet.');
  console.log('Run `pnpm cli --help` for the operational commands that exist.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
