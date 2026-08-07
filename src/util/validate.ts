import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { configRoot } from '../config/index.js';

/**
 * Every model response is validated before it touches state. An unparseable or
 * schema-invalid response is a failed attempt, not something to coerce.
 */
export type SchemaName =
  | 'curated-issue'
  | 'implementation-plan'
  | 'worker-result'
  | 'review'
  | 'failure';

// Schemas are draft 2020-12, so the 2020 build - the default Ajv export is draft-07.
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);

const compiled = new Map<SchemaName, ReturnType<typeof ajv.compile>>();

function validator(name: SchemaName) {
  const existing = compiled.get(name);
  if (existing) return existing;
  const path = resolve(configRoot(), 'schemas', `${name}.schema.json`);
  const fn = ajv.compile(JSON.parse(readFileSync(path, 'utf8')) as object);
  compiled.set(name, fn);
  return fn;
}

export interface ValidationResult<T> {
  ok: boolean;
  data?: T;
  errors: string[];
}

export function validate<T>(name: SchemaName, payload: unknown): ValidationResult<T> {
  const fn = validator(name);
  if (fn(payload)) return { ok: true, data: payload as T, errors: [] };
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
  return { ok: false, errors };
}

/** Models sometimes wrap JSON in prose or fences despite instructions. */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in model response');
  return JSON.parse(candidate.slice(start, end + 1));
}
