import { describe, expect, it, vi } from 'vitest';
import { createOrcaClient, OrcaCommandError, OrcaNotRunningError } from '../../src/orca/client.js';

/** execa rejects with an object carrying stdout, stderr and exitCode. */
function failing(stdout: string, stderr = '', exitCode = 1) {
  return createOrcaClient({
    run: vi.fn(async () => {
      throw Object.assign(new Error('Command failed'), { stdout, stderr, exitCode });
    }),
  });
}

/**
 * Regression for a diagnostics failure, not a logic failure.
 *
 * Orca exits non-zero with an EMPTY stderr and puts the reason in stdout as
 * {"ok":false,"error":{...}}. Reporting only stderr produced
 * `failed (exit 1): ` with no cause — the message was right there and thrown
 * away, which turned a one-line fix into a manual reproduction.
 */
describe('failures report the reason Orca actually gave', () => {
  it('surfaces the error message from the stdout envelope', async () => {
    const client = failing(
      JSON.stringify({
        id: 'local',
        ok: false,
        error: {
          code: 'invalid_argument',
          message: 'Missing repo selector. Pass --repo or run from inside an Orca-managed worktree.',
        },
      }),
    );

    await expect(client.json(['worktree', 'create'])).rejects.toThrow(/Missing repo selector/);
  });

  it('includes the error code so it can be matched on', async () => {
    const client = failing(
      JSON.stringify({ id: 'l', ok: false, error: { code: 'invalid_argument', message: 'nope' } }),
    );
    await expect(client.json(['worktree', 'create'])).rejects.toThrow(/invalid_argument/);
  });

  it('never reports an empty reason', async () => {
    const client = failing('', '', 1);
    await expect(client.json(['worktree', 'create'])).rejects.toThrow(/no error output|Command failed/);
  });

  it('falls back to stderr when stdout is not an envelope', async () => {
    const client = failing('not json', 'something broke on stderr');
    await expect(client.json(['status'])).rejects.toThrow(/something broke on stderr/);
  });

  it('falls back to raw stdout when there is no stderr and no envelope', async () => {
    const client = failing('plain text failure', '');
    await expect(client.json(['status'])).rejects.toThrow(/plain text failure/);
  });

  it('still detects an unreachable runtime from whichever stream carries it', async () => {
    const viaStderr = failing('', 'runtime not reachable');
    await expect(viaStderr.json(['status'])).rejects.toThrow(OrcaNotRunningError);

    const viaStdout = failing('ECONNREFUSED talking to runtime', '');
    await expect(viaStdout.json(['status'])).rejects.toThrow(OrcaNotRunningError);
  });

  it('reports ok:false on a zero exit too', async () => {
    const client = createOrcaClient({
      run: vi.fn(async () => ({
        stdout: JSON.stringify({ id: 'l', ok: false, error: { message: 'worktree not found' } }),
        stderr: '',
      })),
    });
    await expect(client.json(['worktree', 'show'])).rejects.toThrow(/worktree not found/);
  });

  it('keeps the failing argv on the error for reproduction', async () => {
    const client = failing(JSON.stringify({ ok: false, error: { message: 'x' } }));
    await client.json(['worktree', 'create', '--name', 'y']).catch((err: unknown) => {
      expect(err).toBeInstanceOf(OrcaCommandError);
      expect((err as OrcaCommandError).args).toContain('--name');
      expect((err as OrcaCommandError).args).toContain('--json');
    });
  });
});
