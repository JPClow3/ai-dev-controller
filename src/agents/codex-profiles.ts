import { execa } from 'execa';
import type { ModelAlias } from '../config/routing-schema.js';
import type { StructuredTransport } from './types.js';

/**
 * Codex CLI in non-interactive mode, for the ChatGPT-backed tiers.
 *
 * UNVERIFIED against a live account: the Codex weekly quota was exhausted when
 * this was written, so the flag shape below is from `codex --help` and has not
 * been observed returning a real completion. Treat the first successful run as
 * the actual test.
 *
 * `codex exec` is used rather than the interactive TUI, and the sandbox is
 * pinned read-only: a structured call must never touch the filesystem.
 */
export function codexTransport(bin = process.env['CODEX_BIN'] ?? 'codex'): StructuredTransport {
  return {
    name: 'codex-exec',

    supports(alias: ModelAlias): boolean {
      return alias.provider === 'chatgpt';
    },

    async complete({ alias, system, user, timeoutMs }) {
      const prompt = `${system}\n\n---\n\n${user}\n\nRespond with a single JSON object and nothing else.`;

      try {
        const result = await execa(
          bin,
          [
            'exec',
            '--profile',
            alias.profile,
            '--sandbox',
            'read-only',
            '--skip-git-repo-check',
            prompt,
          ],
          { timeout: timeoutMs, reject: true, stdin: 'ignore' },
        );
        const text = result.stdout.trim();
        if (!text) throw new Error(`codex exec --profile ${alias.profile} produced no output`);
        return { text };
      } catch (err) {
        const e = err as { timedOut?: boolean; stderr?: string; message?: string };
        if (e.timedOut) {
          throw new Error(`codex exec --profile ${alias.profile} timed out after ${timeoutMs}ms`);
        }
        const stderr = e.stderr ?? '';
        if (/rate limit|quota|429/i.test(stderr)) {
          throw new Error(
            `Codex quota exhausted for profile ${alias.profile}. Routing should mark this provider EXHAUSTED.`,
          );
        }
        throw new Error(`codex exec --profile ${alias.profile} failed: ${stderr || e.message}`);
      }
    },
  };
}

/** Profiles this controller expects in ~/.codex/config.toml. */
export const EXPECTED_CODEX_PROFILES = [
  'gpt-luna-low',
  'gpt-luna-high',
  'gpt-luna-xhigh',
  'gpt-terra-high',
  'gpt-terra-xhigh',
  'gpt-sol-xhigh',
  'ollama-glm',
  'ollama-kimi',
  'ollama-deepseek',
] as const;
