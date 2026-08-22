import { execa } from 'execa';
import { ProviderQuotaExhaustedError, ProviderUnavailableError, quotaResetAtFromOutput } from '../routing/quota.js';
import type { ModelAlias } from '../config/routing-schema.js';
import type { StructuredTransport } from './types.js';

export interface CommandCodeRunner {
  (
    bin: string,
    args: string[],
    input: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

interface CommandCodeResultFrame {
  type: 'result';
  subtype: 'success' | 'error' | 'max_turns';
  usage?: { input?: number; output?: number };
  finalText?: string;
  error?: unknown;
}

export interface CommandCodeTransportOptions {
  bin?: string;
  plan?: string;
  run?: CommandCodeRunner;
}

const DEFAULT_RUNNER: CommandCodeRunner = async (bin, args, input, timeoutMs) => {
  const result = await execa(bin, args, {
    input,
    timeout: timeoutMs,
    reject: false,
    // `cmd -p` is the non-interactive mode; keep the environment untouched so
    // the user's auth/session flows through exactly as an interactive run.
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 1 };
};

/**
 * Command Code headless transport.
 *
 * `cmd -p --output-format json` emits a newline-delimited stream of event
 * frames followed by exactly one `{"type":"result"}` frame. The final frame
 * carries `usage` and `finalText`, which is the only text this transport
 * returns.
 */
export function commandCodeTransport(options: CommandCodeTransportOptions = {}): StructuredTransport {
  const bin = options.bin ?? process.env['COMMAND_CODE_BIN'] ?? 'command-code';
  const plan = options.plan ?? process.env['COMMAND_CODE_PLAN'];
  const run = options.run ?? DEFAULT_RUNNER;

  return {
    name: 'command-code-cli',

    supports(alias: ModelAlias): boolean {
      return alias.provider === 'commandcode';
    },

    async complete({ alias, system, user, timeoutMs }) {
      const args = [
        '-p',
        '--output-format',
        'json',
        '--skip-onboarding',
        '--model',
        alias.model,
      ];
      if (alias.reasoningEffort) args.push('--effort', alias.reasoningEffort);
      if (plan) args.push('--config', `plan=${plan}`);
      // `-` reads the prompt from stdin.
      args.push('-');

      const prompt = `${system}\n\n---\n\n${user}`;
      let result;
      try {
        result = await run(bin, args, prompt, timeoutMs);
      } catch (err) {
        throw new ProviderUnavailableError('commandcode', `CLI failed to start: ${(err as Error).message}`);
      }

      if (result.exitCode === 5 || result.exitCode === 10) {
        throw new ProviderQuotaExhaustedError(
          'commandcode',
          quotaResetAtFromOutput(`${result.stdout}\n${result.stderr}`),
          result.exitCode === 5 ? 'rate limited' : 'insufficient credits',
        );
      }
      if (result.exitCode === 3) {
        throw new ProviderUnavailableError('commandcode', 'not authenticated; run `command-code login`', 15 * 60_000);
      }

      const frame = lastResultFrame(result.stdout);
      if (result.exitCode !== 0 && !frame) {
        const detail = `${result.stderr}\n${result.stdout}`.trim().slice(0, 400);
        throw new ProviderUnavailableError('commandcode', `CLI failed (exit ${result.exitCode}): ${detail}`);
      }
      if (!frame) {
        throw new Error('command-code produced no result frame');
      }

      const text = frame.finalText?.trim() ?? '';
      if (frame.subtype !== 'success' || !text) {
        throw new Error(
          `command-code run ended with ${frame.subtype}: ${JSON.stringify(frame.error ?? '')}`,
        );
      }

      const inputTokens = frame.usage?.input;
      const outputTokens = frame.usage?.output;
      if (inputTokens !== undefined || outputTokens !== undefined) {
        const usage: { inputTokens?: number; outputTokens?: number } = {};
        if (inputTokens !== undefined) usage.inputTokens = inputTokens;
        if (outputTokens !== undefined) usage.outputTokens = outputTokens;
        return { text, usage };
      }
      return { text };
    },
  };
}

export function lastResultFrame(stdout: string): CommandCodeResultFrame | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { type?: unknown };
      if (parsed.type === 'result') return parsed as CommandCodeResultFrame;
    } catch {
      // A non-JSON line (banner, warning) is ignored.
    }
  }
  return undefined;
}
