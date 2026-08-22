import 'dotenv/config';
import { loadControllerConfig } from '../src/config/load-config.js';
import { planBootstrap, applyBootstrap } from '../src/knowledge/bootstrap.js';

/**
 * Generates .ai-workflow/ for registered repositories.
 *
 *   pnpm bootstrap [--apply] [projectId ...]
 *
 * Dry-run by default: it prints what would be written, because this touches
 * nine repositories the user cares about and "map, do not move" is easier to
 * trust when you can see the plan first.
 */
const ROOT = process.cwd();
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const wanted = args.filter((a) => !a.startsWith('--'));

function main(): void {
  const config = loadControllerConfig(ROOT);
  const entries = Object.entries(config.registry.projects).filter(
    ([id, p]) => p.enabled && (wanted.length === 0 || wanted.includes(id)),
  );

  if (entries.length === 0) {
    console.error('No matching enabled projects.');
    process.exit(1);
  }

  console.log(apply ? 'APPLYING\n' : 'DRY RUN (pass --apply to write)\n');

  for (const [id, project] of entries) {
    let plan;
    try {
      plan = planBootstrap({
        projectId: id,
        repoPath: project.repository.path,
        baseBranch: project.repository.baseBranch,
        discovery: {
          scanGlobs: config.global.knowledge.scanGlobs,
          excludeGlobs: config.global.knowledge.excludeGlobs,
          maxFileBytes: config.global.knowledge.maxFileBytes,
        },
      });
    } catch (err) {
      console.log(`${id.padEnd(18)} ERROR ${(err as Error).message}`);
      continue;
    }

    const commands = plan.derived.commands;
    const status = commands.length === 0 ? 'NO COMMANDS DERIVED' : `${commands.length} commands`;
    console.log(`${id.padEnd(18)} ${plan.derived.packageManager.padEnd(7)} ci:${plan.ciTrigger.padEnd(13)} ${status}`);
    for (const c of commands) {
      console.log(`  ${c.required ? 'required' : 'optional'}  ${c.name.padEnd(10)} ${c.command}`);
    }
    for (const note of plan.derived.notes) console.log(`  note: ${note}`);
    if (plan.preserved.includes('AGENTS.md')) {
      console.log('  AGENTS.md already exists and will NOT be overwritten');
    }

    if (apply) {
      const written = applyBootstrap(plan);
      console.log(`  wrote: ${written.join(', ')}`);
    }
    console.log('');
  }
}

main();
