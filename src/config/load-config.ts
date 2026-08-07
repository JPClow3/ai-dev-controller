import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { globalConfigSchema, type GlobalConfig } from './schema.js';
import { scoringConfigSchema, type ScoringConfig } from './scoring-schema.js';
import { routingConfigSchema, type RoutingConfig } from './routing-schema.js';
import { escalationConfigSchema, type EscalationConfig } from './escalation-schema.js';
import { projectRegistrySchema, type ProjectRegistry } from './registry-schema.js';

export interface ControllerConfig {
  rootDir: string;
  global: GlobalConfig;
  routing: RoutingConfig;
  escalation: EscalationConfig;
  scoring: ScoringConfig;
  registry: ProjectRegistry;
}

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly issues: string[],
  ) {
    super(`Invalid config in ${file}:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function readYaml(rootDir: string, relative: string): unknown {
  const path = resolve(rootDir, relative);
  if (!existsSync(path)) throw new ConfigError(relative, ['file not found']);
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(relative, [`YAML parse error: ${(err as Error).message}`]);
  }
}

// Generic over the schema, not its output: every config schema is a
// ZodEffects (it transforms snake_case to camelCase), and `ZodType<T>` would
// force TypeScript to unify the input and output shapes.
function parseWith<S extends z.ZodTypeAny>(schema: S, relative: string, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  throw new ConfigError(
    relative,
    result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
  );
}

/**
 * Loads and validates every config file. Fails loudly and completely rather
 * than starting with a half-valid policy — a controller running on partially
 * defaulted routing rules is worse than one that refuses to start.
 *
 * `config/local.yaml` and `projects/registry.local.yaml` are gitignored
 * operator overrides, shallow-merged over the committed defaults.
 */
export function loadControllerConfig(rootDir: string): ControllerConfig {
  const globalRaw = readYaml(rootDir, 'config/global.yaml') as Record<string, unknown>;
  const localPath = resolve(rootDir, 'config/local.yaml');
  const localRaw = existsSync(localPath)
    ? (parse(readFileSync(localPath, 'utf8')) as Record<string, unknown> | null)
    : null;

  const mergedGlobal = localRaw ? { ...globalRaw, ...localRaw } : globalRaw;

  const registryRelative = existsSync(resolve(rootDir, 'projects/registry.local.yaml'))
    ? 'projects/registry.local.yaml'
    : 'projects/registry.yaml';

  return {
    rootDir,
    global: parseWith(globalConfigSchema, 'config/global.yaml', mergedGlobal),
    routing: parseWith(routingConfigSchema, 'config/routing.yaml', readYaml(rootDir, 'config/routing.yaml')),
    escalation: parseWith(
      escalationConfigSchema,
      'config/escalation.yaml',
      readYaml(rootDir, 'config/escalation.yaml'),
    ),
    scoring: parseWith(scoringConfigSchema, 'config/scoring.yaml', readYaml(rootDir, 'config/scoring.yaml')),
    registry: parseWith(projectRegistrySchema, registryRelative, readYaml(rootDir, registryRelative)),
  };
}

export type { GlobalConfig, RoutingConfig, EscalationConfig, ScoringConfig, ProjectRegistry };
export type { ConcurrencyConfig } from './schema.js';
export type { ModelAlias } from './routing-schema.js';
export type { ScoreWeights } from './scoring-schema.js';
