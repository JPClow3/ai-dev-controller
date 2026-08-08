import 'dotenv/config';
import { loadControllerConfig } from '../config/load-config.js';
import { createInvoker } from './invoke.js';
import { ollamaTransport } from './ollama-profiles.js';
import { StructuredInvocationError } from './types.js';

/**
 * End-to-end smoke test of the model invocation path against a real model.
 *
 * Exercises: HTTP transport -> JSON extraction -> schema validation -> retry.
 * Uses whichever alias is passed (default `local_smoke`, a small local model)
 * so the wiring can be proven without a paid subscription.
 *
 *   pnpm tsx src/agents/smoke.ts [alias]
 */
const ROOT = process.cwd();
const alias = process.argv[2] ?? 'local_smoke';

const RAW_ISSUE = `
Title: remember me keeps logging people out

right now if you tick "remember me" you still get logged out after a while,
seems random. happens in the web app. should stay logged in.
`;

async function main(): Promise<void> {
  const config = loadControllerConfig(ROOT);
  const spec = config.routing.aliases[alias];
  if (!spec) {
    console.error(`Unknown alias "${alias}". Known: ${Object.keys(config.routing.aliases).join(', ')}`);
    process.exit(1);
  }

  console.log(`alias      ${alias}`);
  console.log(`provider   ${spec.provider}`);
  console.log(`model      ${spec.model ?? spec.profile}`);
  console.log('');

  const invoker = createInvoker({
    rootDir: ROOT,
    routing: config.routing,
    transports: [ollamaTransport()],
  });

  const started = Date.now();
  try {
    const result = await invoker.structured({
      alias,
      prompt: 'curator',
      input: [
        'Curate this raw issue. The repository is `lorebound` and the Linear identifier is UNI-1.',
        'Valid task_category values include: routine_behavior, routine_bugfix, multi_file_feature.',
        '',
        RAW_ISSUE,
      ].join('\n'),
      schema: 'curated-issue',
      maxAttempts: 3,
      timeoutMs: 180_000,
    });

    const data = result.data as Record<string, unknown>;
    console.log('PASS  structured call returned schema-valid JSON');
    console.log(`  attempts   ${result.attempts}`);
    console.log(`  wall clock ${(result.wallClockMs / 1000).toFixed(1)}s`);
    console.log(`  verdict    ${String(data['verdict'])}`);
    console.log(`  issue_id   ${String(data['issue_id'])}`);
    if (data['risk']) console.log(`  risk       ${String(data['risk'])}`);
    const criteria = data['acceptance_criteria'];
    if (Array.isArray(criteria)) {
      console.log(`  criteria   ${criteria.length}`);
      for (const c of criteria as Array<{ id?: string; statement?: string }>) {
        console.log(`    - ${c.id}: ${c.statement}`);
      }
    }
    if (data['needs_context']) {
      console.log(`  needs_context ${JSON.stringify(data['needs_context'])}`);
    }
  } catch (err) {
    if (err instanceof StructuredInvocationError) {
      // A small model failing the schema is a legitimate result: it proves the
      // validation and retry path works, which is what this is testing.
      console.log('SCHEMA REJECTED  the transport worked; the model could not satisfy the schema');
      console.log(`  attempts ${err.attempts}`);
      for (const issue of err.issues) console.log(`  - ${issue}`);
      console.log('');
      console.log('  last raw response:');
      console.log(err.lastRaw.slice(0, 600));
      process.exitCode = 0;
      return;
    }
    console.error('FAIL  transport error');
    console.error(`  ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    console.log(`\ntotal ${(Date.now() - started) / 1000}s`);
  }
}

void main();
