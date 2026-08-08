import { execa } from 'execa';

/**
 * Orca CLI wrapper.
 *
 * Every call passes `--json` and parses the envelope. Human-readable output is
 * never parsed — crash recovery depends on machine-readable status, and a
 * layout change in the pretty printer must not silently break the controller.
 *
 * Envelope shape observed on Orca 1.4.176:
 *   { "id": "...", "ok": true, "result": { ... }, "_meta": { ... } }
 */
export interface OrcaEnvelope<T> {
  id: string;
  ok: boolean;
  result: T;
  error?: { message?: string; code?: string };
  _meta?: Record<string, unknown>;
}

export class OrcaCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(`orca ${args.join(' ')} failed (exit ${exitCode ?? '?'}): ${stderr.slice(0, 500)}`);
    this.name = 'OrcaCommandError';
  }
}

export class OrcaNotRunningError extends Error {
  constructor() {
    super('Orca runtime is not reachable. Open the Orca desktop app, or run `orca open`.');
    this.name = 'OrcaNotRunningError';
  }
}

export interface OrcaClientOptions {
  bin?: string;
  timeoutMs?: number;
  run?: (bin: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
}

export function createOrcaClient(options: OrcaClientOptions = {}) {
  const bin = options.bin ?? process.env['ORCA_BIN'] ?? 'orca';
  const defaultTimeout = options.timeoutMs ?? 120_000;

  const run =
    options.run ??
    (async (b: string, args: string[], timeoutMs: number) => {
      const result = await execa(b, args, { timeout: timeoutMs, reject: true });
      return { stdout: result.stdout, stderr: result.stderr };
    });

  /** Runs an Orca command and returns `result`, enforcing `--json`. */
  async function json<T>(args: string[], timeoutMs = defaultTimeout): Promise<T> {
    const withJson = args.includes('--json') ? args : [...args, '--json'];

    let stdout: string;
    try {
      ({ stdout } = await run(bin, withJson, timeoutMs));
    } catch (err) {
      const e = err as { exitCode?: number; stderr?: string; message?: string; code?: string };
      const stderr = e.stderr ?? e.message ?? '';
      if (e.code === 'ENOENT') {
        throw new Error(`Orca CLI not found at "${bin}". Set ORCA_BIN or add it to PATH.`);
      }
      if (/not reachable|runtime|ECONNREFUSED/i.test(stderr)) throw new OrcaNotRunningError();
      throw new OrcaCommandError(withJson, e.exitCode, stderr);
    }

    let envelope: OrcaEnvelope<T>;
    try {
      envelope = JSON.parse(stdout) as OrcaEnvelope<T>;
    } catch {
      throw new OrcaCommandError(withJson, 0, `expected JSON, got: ${stdout.slice(0, 300)}`);
    }

    if (!envelope.ok) {
      throw new OrcaCommandError(withJson, 0, envelope.error?.message ?? 'orca reported ok: false');
    }
    return envelope.result;
  }

  return { bin, json };
}

export type OrcaClient = ReturnType<typeof createOrcaClient>;

export interface OrcaStatus {
  app: { running: boolean; pid?: number };
  runtime: { state: string; reachable: boolean; appVersion: string; capabilities: string[] };
  graph: { state: string };
}

export async function status(client: OrcaClient): Promise<OrcaStatus> {
  return client.json<OrcaStatus>(['status']);
}

/** Fails fast at startup rather than midway through claiming an issue. */
export async function assertReady(client: OrcaClient): Promise<void> {
  const s = await status(client);
  if (!s.app.running || !s.runtime.reachable || s.runtime.state !== 'ready') {
    throw new OrcaNotRunningError();
  }
}
