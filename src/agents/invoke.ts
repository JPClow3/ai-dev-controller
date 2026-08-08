import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { RoutingConfig } from '../config/routing-schema.js';
import { ollamaTransport } from './ollama-profiles.js';
import { codexTransport } from './codex-profiles.js';
import {
  StructuredInvocationError,
  type StructuredRequest,
  type StructuredResult,
  type StructuredTransport,
} from './types.js';

const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();

function validator(rootDir: string, schema: string) {
  const key = `${rootDir}:${schema}`;
  const existing = compiled.get(key);
  if (existing) return existing;
  const path = resolve(rootDir, 'schemas', `${schema}.schema.json`);
  const fn = ajv.compile(JSON.parse(readFileSync(path, 'utf8')) as object);
  compiled.set(key, fn);
  return fn;
}

function readSchema(rootDir: string, schema: string): string {
  return readFileSync(resolve(rootDir, 'schemas', `${schema}.schema.json`), 'utf8');
}

/**
 * Models wrap JSON in prose or fences despite instructions. Recovering here is
 * cheaper than burning a retry, but a response that needs recovery is still
 * recorded so the behaviour shows up in routing statistics.
 */
export function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();

  // Cheap path: the whole thing is already an object.
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* fall through */
  }

  // Scan for balanced objects rather than slicing first `{` to last `}`.
  // `codex exec` echoes the reply and then prints a token summary, so that
  // naive span covers two objects plus prose and never parses.
  const objects = balancedObjects(candidate);
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(objects[i]!) as unknown;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('no JSON object found in the response');
}

/** Every balanced `{...}` span, ignoring braces inside strings. */
function balancedObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        found.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return found;
}

export interface InvokerOptions {
  rootDir: string;
  routing: RoutingConfig;
  transports?: StructuredTransport[];
  /** Injected for tests. */
  readPrompt?: (name: string) => string;
}

export function createInvoker(options: InvokerOptions) {
  const transports = options.transports ?? [ollamaTransport(), codexTransport()];
  const readPrompt =
    options.readPrompt ??
    ((name: string) => readFileSync(resolve(options.rootDir, 'prompts', `${name}.md`), 'utf8'));

  /**
   * One structured call, validated against its schema.
   *
   * Invalid JSON is retried with the validation errors appended, because a
   * model that omitted a required field usually fixes it when told which one.
   * The retry budget is small on purpose — a model that cannot satisfy the
   * schema twice is a routing signal, not something to grind on.
   */
  async function structured<T = unknown>(request: StructuredRequest): Promise<StructuredResult<T>> {
    const alias = options.routing.aliases[request.alias];
    if (!alias) throw new Error(`Unknown routing alias "${request.alias}"`);

    const transport = transports.find((t) => t.supports(alias));
    if (!transport) {
      throw new Error(`No transport supports provider "${alias.provider}" (alias ${request.alias})`);
    }

    const validate = validator(options.rootDir, request.schema);

    // The prompts describe the *content* in prose; the schema describes the
    // *shape*. Sending only the prose leaves the model guessing at the JSON
    // layout - it reliably emits the documented section headings as top-level
    // keys, which `additionalProperties: false` then rejects.
    const system = [
      readPrompt(request.prompt),
      '',
      '---',
      '',
      'Your reply must be a single JSON object valid against this JSON Schema.',
      'Emit no properties the schema does not define.',
      '',
      '```json',
      readSchema(options.rootDir, request.schema),
      '```',
    ].join('\n');
    const timeoutMs = request.timeoutMs ?? 120_000;
    const maxAttempts = request.maxAttempts ?? 2;

    const started = Date.now();
    const issues: string[] = [];
    let raw = '';
    let user = request.input;

    // Handed to the transport so providers that support native structured
    // output can enforce it rather than merely being asked.
    const schemaObject = JSON.parse(readSchema(options.rootDir, request.schema)) as object;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const completion = await transport.complete({
        alias,
        system,
        user,
        timeoutMs,
        schema: schemaObject,
      });
      raw = completion.text;

      let parsed: unknown;
      try {
        parsed = extractJson(raw);
      } catch (err) {
        issues.push(`attempt ${attempt}: ${(err as Error).message}`);
        user = `${request.input}\n\nYour previous reply was not valid JSON. Reply with a single JSON object and nothing else.`;
        continue;
      }

      if (validate(parsed)) {
        return {
          data: parsed as T,
          alias: request.alias,
          attempts: attempt,
          wallClockMs: Date.now() - started,
          raw,
          ...(completion.usage ? { usage: completion.usage } : {}),
        };
      }

      const errors = (validate.errors ?? []).map(
        (e) => `${e.instancePath || '<root>'} ${e.message ?? 'invalid'}`,
      );
      issues.push(`attempt ${attempt}: ${errors.join('; ')}`);
      user = [
        request.input,
        '',
        'Your previous reply did not satisfy the required schema:',
        ...errors.map((e) => `- ${e}`),
        '',
        'Return a corrected JSON object.',
      ].join('\n');
    }

    throw new StructuredInvocationError(request.alias, maxAttempts, issues, raw);
  }

  return { structured };
}

export type Invoker = ReturnType<typeof createInvoker>;
