import { execa } from 'execa';
import { ProviderQuotaExhaustedError, ProviderUnavailableError, quotaResetAtFromOutput } from '../routing/quota.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAlias } from '../config/routing-schema.js';
import type { StructuredTransport } from './types.js';

/**
 * Codex CLI in non-interactive mode, for the ChatGPT-backed tiers.
 *
 * Two flags do the heavy lifting, and both were found the hard way:
 *
 *   --output-last-message  `codex exec` prints a banner, the conversation and
 *                          a token summary to stdout. Scraping JSON out of
 *                          that is unreliable: the first `{` and last `}` span
 *                          the trailing duplicate of the reply, producing
 *                          invalid JSON. This flag writes only the final
 *                          assistant message.
 *
 *   --output-schema        Native structured output enforcing JSON schema adherence.
 *                          Enforcing the shape at the provider is much stronger than asking politely.
 */
export function codexTransport(bin = process.env['CODEX_BIN'] ?? 'codex'): StructuredTransport {
  return {
    name: 'codex-exec',

    supports(alias: ModelAlias): boolean {
      return alias.provider === 'chatgpt';
    },

    async complete({ alias, system, user, timeoutMs, schema }) {
      const dir = mkdtempSync(join(tmpdir(), 'ai-dev-codex-'));
      const messagePath = join(dir, 'last-message.txt');
      const schemaPath = join(dir, 'schema.json');

      const args: string[] = [
        'exec',
        '--profile',
        alias.profile ?? '',
        '--sandbox',
        'read-only',
        // Same reason as the worker launcher: the "elevated" Windows sandbox
        // raises a UAC prompt that an unattended run cannot answer. Read-only
        // calls have survived it so far, which is luck, not design.
        '-c',
        'windows.sandbox="unelevated"',
        '--skip-git-repo-check',
        '--output-last-message',
        messagePath,
      ];

      // Native enforcement only when the schema is inside OpenAI's supported
      // subset. Ours mostly are not: they use `allOf`/`if`/`then` to make
      // required fields depend on `verdict`, and the API rejects that with
      // "'allOf' is not permitted". Sending it anyway fails the whole call, so
      // an incompatible schema falls back to the prompt copy plus local Ajv
      // validation - which is the real gate in either case.
      if (schema && supportsNativeSchema(schema)) {
        writeFileSync(schemaPath, JSON.stringify(schema), 'utf8');
        args.push('--output-schema', schemaPath);
      }

      // `-` makes codex read the prompt from stdin. Passing it as an argument
      // breaks on Windows: the system prompt plus an embedded JSON Schema
      // exceeds the ~32KB command-line limit and fails with "command line too
      // long" before the model is ever contacted.
      args.push('-');
      const prompt = `${system}\n\n---\n\n${user}`;

      try {
        const result = await execa(bin, args, { timeout: timeoutMs, reject: true, input: prompt });

        let text = '';
        try {
          text = readFileSync(messagePath, 'utf8').trim();
        } catch {
          // Fall back to stdout only if the flag produced nothing.
          text = result.stdout.trim();
        }
        if (!text) throw new Error(`codex exec --profile ${alias.profile} produced no final message`);

        return { text, ...parseUsage(result.stdout) };
      } catch (err) {
        const e = err as { timedOut?: boolean; stderr?: string; stdout?: string; message?: string };
        if (e.timedOut) {
          throw new ProviderUnavailableError(alias.provider, `profile ${alias.profile} timed out after ${timeoutMs}ms`);
        }
        const detail = `${e.stderr ?? ''}\n${e.stdout ?? ''}`;
        if (/rate limit|quota|usage limit|429/i.test(detail)) {
          throw new ProviderQuotaExhaustedError(
            alias.provider,
            quotaResetAtFromOutput(detail),
            `profile ${alias.profile}`,
          );
        }
        if (/legacy `profile`|cannot be used while/i.test(detail)) {
          throw new ProviderUnavailableError(
            alias.provider,
            `profile ${alias.profile} is in the legacy config.toml format; move it to ~/.codex/${alias.profile}.config.toml`,
            15 * 60_000,
          );
        }
        throw new ProviderUnavailableError(alias.provider, `profile ${alias.profile} failed: ${detail.trim().slice(0, 400)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Keywords OpenAI's structured-output schema subset rejects. */
const UNSUPPORTED_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'not', '$ref'];

export function supportsNativeSchema(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return true;
  if (Array.isArray(schema)) return schema.every(supportsNativeSchema);

  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.includes(key)) return false;
    if (!supportsNativeSchema(value)) return false;
  }
  return true;
}

/** `codex exec` prints a "tokens used" line; best-effort, never load-bearing. */
function parseUsage(stdout: string): { usage?: { outputTokens?: number } } {
  const match = /tokens used\s*[\r\n]+\s*([\d.,]+)/i.exec(stdout);
  if (!match?.[1]) return {};
  const tokens = Number.parseInt(match[1].replace(/[.,]/g, ''), 10);
  return Number.isFinite(tokens) ? { usage: { outputTokens: tokens } } : {};
}

/** Profiles this controller expects as ~/.codex/<name>.config.toml files. */
export const EXPECTED_CODEX_PROFILES = [
  'gpt-luna-low',
  'gpt-luna-medium',
  'gpt-luna-high',
  'gpt-luna-xhigh',
  'gpt-terra-medium',
  'gpt-terra-high',
  'gpt-terra-xhigh',
  'gpt-sol-medium',
  'gpt-sol-high',
  'gpt-sol-xhigh',
] as const;
