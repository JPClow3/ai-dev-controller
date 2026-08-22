import type { ProvidersConfig } from '../config/providers-schema.js';
import { codexTransport } from './codex-profiles.js';
import { commandCodeTransport } from './command-code-transport.js';
import { openAiCompatibleTransport } from './openai-compatible-transport.js';
import type { StructuredTransport } from './types.js';

export interface BuildTransportsOptions {
  providers: ProvidersConfig;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface TransportBuildResult {
  transports: StructuredTransport[];
  /** A provider omitted from `transports` must be ineligible to the router. */
  unavailable: Record<string, string>;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function isAmbiguousCommandCodeBin(bin: string): boolean {
  return bin.trim().toLowerCase() === 'cmd';
}

/**
 * Builds one structured transport per enabled provider.
 *
 * Providers with unsupported transport kinds (`opencode-cli` in this phase) or
 * `enabled: false` are skipped rather than failing composition, so the config
 * can declare a roadmap provider without breaking the controller.
 */
export function buildTransports(options: BuildTransportsOptions): TransportBuildResult {
  const env = options.env ?? process.env;
  const transports: StructuredTransport[] = [];
  const unavailable: Record<string, string> = {};

  for (const [id, provider] of Object.entries(options.providers.providers)) {
    if (!provider.enabled) continue;

    if (provider.transport === 'codex-cli') {
      transports.push(codexTransport(provider.bin));
    } else if (provider.transport === 'command-code-cli') {
      const bin = nonEmpty(env['COMMAND_CODE_BIN']) ?? provider.bin;
      if (isAmbiguousCommandCodeBin(bin)) {
        unavailable[id] = 'COMMAND_CODE_BIN/config bin cannot be bare "cmd" on Windows; use command-code or an absolute path';
        continue;
      }
      transports.push(commandCodeTransport({
        bin,
        plan: nonEmpty(env['COMMAND_CODE_PLAN']) ?? provider.plan,
      }));
    } else if (provider.transport === 'openai-compatible-http') {
      const apiKey = env[provider.apiKeyEnv]?.trim();
      if (!apiKey) {
        unavailable[id] = `missing ${provider.apiKeyEnv}`;
        continue;
      }
      transports.push(
        openAiCompatibleTransport({
          provider: id,
          baseUrl: provider.baseUrl,
          apiKey,
        }),
      );
    } else {
      unavailable[id] = `transport ${provider.transport} is not implemented`;
    }
  }

  return { transports, unavailable };
}
