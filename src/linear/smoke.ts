import 'dotenv/config';
import { getLinearClient } from './client.js';
import { listIssuesByLabel } from './issues.js';
import { AI_LIFECYCLE_LABELS } from '../workflow/states.js';

/**
 * Verifies the Linear credential and that the lifecycle labels exist.
 *
 *   pnpm tsx src/linear/smoke.ts
 */
async function main(): Promise<void> {
  const client = getLinearClient();

  const me = await client.viewer;
  console.log(`authenticated  ${me.name} <${me.email}>`);

  const teams = await client.teams();
  console.log(`teams          ${teams.nodes.map((t) => `${t.name} (${t.key})`).join(', ')}`);

  const labels = await client.issueLabels();
  const present = new Set(labels.nodes.map((l) => l.name));
  const missing = AI_LIFECYCLE_LABELS.filter((l) => !present.has(l));
  console.log(`ai-* labels    ${AI_LIFECYCLE_LABELS.length - missing.length}/${AI_LIFECYCLE_LABELS.length} present`);
  if (missing.length > 0) console.log(`  MISSING: ${missing.join(', ')}`);

  const projects = await client.projects();
  console.log(`projects       ${projects.nodes.length}`);

  // The gate the whole system hangs on.
  const ready = await listIssuesByLabel('ai-ready');
  console.log(`ai-ready       ${ready.length} issue(s)`);
  for (const issue of ready) {
    console.log(`  ${issue.identifier}  ${issue.title}  [project: ${issue.projectName ?? 'none'}]`);
  }
}

main().catch((err: unknown) => {
  console.error(`FAILED  ${(err as Error).message}`);
  process.exitCode = 1;
});
