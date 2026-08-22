import 'dotenv/config';
import { loadControllerConfig } from '../src/config/load-config.js';
import { createInvoker } from '../src/agents/invoke.js';
import { codexTransport } from '../src/agents/codex-profiles.js';
import { createAgents, reviewerCandidates } from '../src/agents/roles.js';
import { StructuredInvocationError } from '../src/agents/types.js';
import { overlappingOwnership } from '../src/git/integration.js';
import { assessReview, type ReviewResult } from '../src/reviews/review.js';

/**
 * Exercises curator -> planner -> reviewer against a real model, through the
 * same roles/invoker path the orchestrator uses.
 *
 *   pnpm smoke:pipeline [alias]
 *
 * Proves the wiring, not the model: a model failing a schema is a legitimate
 * outcome, because it still demonstrates that invalid output is caught
 * rather than acted on.
 */
const ROOT = process.cwd();
const alias = process.argv[2] ?? 'luna_low';
const config = loadControllerConfig(ROOT);

const RAW_ISSUE = `
Title: export button does nothing on the reports page

clicking Export on /reports just spins. no file downloads. worked last month.
`;

function ok(label: string, detail = ''): void {
  console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`);
}
function bad(label: string, detail = ''): void {
  console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const invoker = createInvoker({
    rootDir: ROOT,
    routing: config.routing,
    transports: [codexTransport()],
  });
  const agents = createAgents(invoker, config.routing);
  let failures = 0;

  console.log(`alias ${alias}\n`);

  // ---- curator -------------------------------------------------------------
  console.log('curator');
  let contract = '';
  try {
    const curated = await agents.curate<Record<string, unknown>>(alias, RAW_ISSUE);
    ok('schema-valid curated issue', `verdict=${String(curated['verdict'])}`);
    const criteria = curated['acceptance_criteria'];
    if (Array.isArray(criteria) && criteria.length > 0) {
      ok('produced acceptance criteria', `${criteria.length}`);
    } else if (curated['verdict'] === 'needs_context') {
      ok('correctly refused rather than inventing requirements');
    } else {
      bad('no acceptance criteria and no needs_context');
      failures += 1;
    }
    contract = JSON.stringify(curated, null, 2);
  } catch (err) {
    if (err instanceof StructuredInvocationError) {
      ok('invalid output rejected by the schema', `after ${err.attempts} attempts`);
      contract = `Issue: export button does nothing.\nAC-1: clicking Export downloads a file.`;
    } else {
      bad('transport error', (err as Error).message);
      failures += 1;
      return;
    }
  }

  // ---- planner -------------------------------------------------------------
  console.log('\nplanner');
  try {
    const plan = await agents.plan<{ verdict: string; tasks?: Array<{ id: string; owns: string[]; blocked_by?: string[] }> }>(
      alias,
      `${contract}\n\nBase branch: main. Validation: npm run test, npm run build.`,
    );
    ok('schema-valid plan', `verdict=${plan.verdict}`);

    const tasks = plan.tasks ?? [];
    if (tasks.length > 0) {
      ok('decomposed into tasks', `${tasks.length}`);
      const clashes = overlappingOwnership(
        tasks.map((t) => ({ id: t.id, owns: t.owns, blockedBy: t.blocked_by ?? [] })),
      );
      // The controller catches overlap regardless of what the model proposed;
      // this shows the check running on real model output.
      if (clashes.length === 0) ok('ownership sets are disjoint');
      else ok('overlapping ownership detected and would be refused', `${clashes.length} clash(es)`);
    }
  } catch (err) {
    if (err instanceof StructuredInvocationError) {
      ok('invalid plan rejected by the schema', `after ${err.attempts} attempts`);
    } else {
      bad('planner transport error', (err as Error).message);
      failures += 1;
    }
  }

  // ---- reviewer ------------------------------------------------------------
  console.log('\nreviewer');
  try {
    const candidates = reviewerCandidates(config.routing);
    ok('reviewer candidates drawn from routable aliases', `${candidates.length}`);

    const { data } = await agents.reviewFinal<ReviewResult>(
      { byFamily: { openai: 400, deepseek: 20 } },
      [alias],
      `## Acceptance criteria\n- AC-1: clicking Export downloads a file.\n\n## Diff\n\`\`\`diff\n+ console.log('export');\n\`\`\`\n\n## CI\nrequired checks passed: true`,
    );

    const assessment = assessReview(data, config.escalation.reviewRemediation.blockingSeverities);
    ok('schema-valid review', `verdict=${data.verdict} -> ${assessment.verdict}`);
    if (assessment.inconsistencies.length > 0) {
      ok('self-contradiction caught and downgraded', assessment.inconsistencies[0]);
    }
  } catch (err) {
    if (err instanceof StructuredInvocationError) {
      ok('invalid review rejected by the schema', `after ${err.attempts} attempts`);
    } else {
      bad('reviewer transport error', (err as Error).message);
      failures += 1;
    }
  }

  console.log(
    failures === 0 ? '\nPIPELINE WIRING OK' : `\n${failures} STAGE(S) FAILED FOR NON-SCHEMA REASONS`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((err: unknown) => {
  console.error(`FAILED  ${(err as Error).message}`);
  process.exitCode = 1;
});
