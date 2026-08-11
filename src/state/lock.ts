import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class ControllerAlreadyRunning extends Error {
  constructor(
    readonly pid: number,
    readonly lockPath: string,
  ) {
    super(
      `Another controller (pid ${pid}) is already running against this database.\n` +
        `Stop it first, or delete ${lockPath} if that process is gone.`,
    );
    this.name = 'ControllerAlreadyRunning';
  }
}

/**
 * A single-writer lock around the controller database.
 *
 * The comment above `openDatabase` claims "a single writer process" but
 * nothing enforced it, and two controllers on one database is not a
 * hypothetical: it happened here. Both polled Linear, both saw the same
 * `ai-ready` issue, and the partial unique index on `runs` did its job — one
 * run — but the loser had already created a second Orca worktree and branch
 * for it. Duplicate-prevention on the run row alone is not enough; the
 * expensive side effects happen outside the transaction.
 *
 * `wx` is the whole mechanism: an atomic create-if-absent. A lock left behind
 * by a crash is reclaimed only after confirming the recorded process is
 * genuinely gone, because refusing to start after a power cut would be worse
 * than the problem.
 */
export function acquireControllerLock(databasePath: string): () => void {
  if (databasePath === ':memory:') return () => undefined;

  const lockPath = resolve(dirname(resolve(databasePath)), '.controller-runtime.lock');

  const claim = (): void => {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, `${process.pid}\n`, 'utf8');
    closeSync(fd);
  };

  try {
    claim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

    const holder = readLockPid(lockPath);
    if (holder !== null && holder !== process.pid && isAlive(holder)) {
      throw new ControllerAlreadyRunning(holder, lockPath);
    }
    // Stale: the recorded process is gone, or the file is unreadable.
    unlinkSync(lockPath);
    claim();
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    // Only ever remove our own lock, never someone else's.
    if (existsSync(lockPath) && readLockPid(lockPath) === process.pid) unlinkSync(lockPath);
  };

  process.once('exit', release);
  return release;
}

function readLockPid(lockPath: string): number | null {
  try {
    const parsed = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Signal 0 tests for existence without delivering anything. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
