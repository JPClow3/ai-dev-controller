import type { ProvidersConfig } from '../config/providers-schema.js';
import { isAmbiguousCommandCodeBin } from '../agents/transports.js';

export interface ProviderProbeResult {
  provider: string;
  connected: boolean;
  authOk: boolean;
  detail: string;
}

export interface ProbeRunner {
  (
    bin: string,
    args: string[],
    input?: string,
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface ProbeProvidersOptions {
  providers: ProvidersConfig;
  env?: Readonly<Record<string, string | undefined>>;
  run?: ProbeRunner;
  now?: () => number;
}

const PROBE_TIMEOUT_MS = 120_000;

/**
 * Cheap reachability/auth probes, never a full model call.
 *
 * A provider can report "connected" without an auth check (e.g. an HTTP
 * provider with no key), but the TUI shows `authOk: false` in that case so the
 * operator knows the connection is only configuration, not live.
 */
export async function probeProviders(options: ProbeProvidersOptions): Promise<ProviderProbeResult[]> {
  const env = options.env ?? process.env;
  const run = options.run ?? defaultRunner;
  const results: ProviderProbeResult[] = [];

  for (const [id, provider] of Object.entries(options.providers.providers)) {
    if (!provider.enabled) {
      results.push({ provider: id, connected: false, authOk: false, detail: 'disabled' });
      continue;
    }

    if (provider.transport === 'codex-cli') {
      try {
        const out = await run(provider.bin, ['exec', '--help'], undefined, PROBE_TIMEOUT_MS);
        results.push({
          provider: id,
          connected: out.exitCode === 0,
          authOk: out.exitCode === 0 && !/refresh_token_invalidated|401/i.test(`${out.stderr}\n${out.stdout}`),
          detail: out.exitCode === 0 ? 'codex CLI reachable' : out.stderr.trim().slice(0, 120),
        });
      } catch (err) {
        results.push({ provider: id, connected: false, authOk: false, detail: (err as Error).message.slice(0, 120) });
      }
    } else if (provider.transport === 'command-code-cli') {
      const bin = env['COMMAND_CODE_BIN']?.trim() || provider.bin;
      if (isAmbiguousCommandCodeBin(bin)) {
        results.push({
          provider: id,
          connected: false,
          authOk: false,
          detail: 'Command Code binary cannot be bare "cmd" on Windows',
        });
        continue;
      }
      try {
        const out = await run(bin, ['status'], undefined, PROBE_TIMEOUT_MS);
        results.push({
          provider: id,
          connected: out.exitCode === 0,
          authOk: out.exitCode === 0 && !/not authenticated|unauthorized|login/i.test(`${out.stderr}\n${out.stdout}`),
          detail: out.exitCode === 0 ? 'command code status ok' : out.stderr.trim().slice(0, 120),
        });
      } catch (err) {
        results.push({ provider: id, connected: false, authOk: false, detail: (err as Error).message.slice(0, 120) });
      }
    } else if (provider.transport === 'openai-compatible-http') {
      const apiKey = env[provider.apiKeyEnv]?.trim();
      results.push({
        provider: id,
        connected: Boolean(apiKey),
        authOk: false,
        detail: apiKey ? `${provider.apiKeyEnv} configured` : `missing ${provider.apiKeyEnv}`,
      });
    } else {
      results.push({
        provider: id,
        connected: false,
        authOk: false,
        detail: `transport ${provider.transport} not implemented`,
      });
    }
  }

  return results;
}

async function defaultRunner(
  bin: string,
  args: string[],
  input?: string,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Local import keeps probe usable in test/mock contexts that don't need
  // execa, and avoids pulling the full CLI dependency into pure reads.
  const { execa } = await import('execa');
  const options: { input?: string; timeout?: number; reject: false } = { reject: false };
  if (input !== undefined) options.input = input;
  if (timeoutMs !== undefined) options.timeout = timeoutMs;
  const result = await execa(bin, args, options);
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 1 };
}
