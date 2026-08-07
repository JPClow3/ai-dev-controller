import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function load<T>(relative: string): T {
  const path = resolve(ROOT, relative);
  if (!existsSync(path)) throw new Error(`Missing config file: ${path}`);
  return parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Config is read once at process start. `config/local.yaml` and
 * `projects/registry.local.yaml` are gitignored operator overrides, shallow
 * merged over the committed defaults.
 */
export interface LoadedConfig {
  global: Record<string, unknown>;
  routing: Record<string, unknown>;
  escalation: Record<string, unknown>;
  scoring: Record<string, unknown>;
  registry: Record<string, unknown>;
  root: string;
}

let cached: LoadedConfig | null = null;

export function loadConfig(force = false): LoadedConfig {
  if (cached && !force) return cached;

  const globalCfg = load<Record<string, unknown>>('config/global.yaml');
  const localPath = resolve(ROOT, 'config/local.yaml');
  const localCfg = existsSync(localPath)
    ? (parse(readFileSync(localPath, 'utf8')) as Record<string, unknown>)
    : {};

  const registryPath = resolve(ROOT, 'projects/registry.local.yaml');
  const registry = existsSync(registryPath)
    ? (parse(readFileSync(registryPath, 'utf8')) as Record<string, unknown>)
    : load<Record<string, unknown>>('projects/registry.yaml');

  cached = {
    global: { ...globalCfg, ...localCfg },
    routing: load('config/routing.yaml'),
    escalation: load('config/escalation.yaml'),
    scoring: load('config/scoring.yaml'),
    registry,
    root: ROOT,
  };
  return cached;
}

export function configRoot(): string {
  return ROOT;
}
