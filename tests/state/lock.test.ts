import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireControllerLock, ControllerAlreadyRunning } from '../../src/state/lock.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('controller process lock', () => {
  it('uses an ignored runtime-only filename and removes it on release', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-dev-lock-'));
    directories.push(directory);
    const database = join(directory, 'controller.db');

    const release = acquireControllerLock(database);

    expect(existsSync(join(directory, '.controller-runtime.lock'))).toBe(true);
    expect(existsSync(join(directory, 'controller.lock'))).toBe(false);

    release();
    expect(existsSync(join(directory, '.controller-runtime.lock'))).toBe(false);
  });

  it('rejects a second owner even when it is the same process', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-dev-lock-'));
    directories.push(directory);
    const database = join(directory, 'controller.db');
    const release = acquireControllerLock(database);

    expect(() => acquireControllerLock(database)).toThrow(ControllerAlreadyRunning);

    release();
  });

  it('reclaims a stale lock without leaving quarantine or claim files behind', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-dev-lock-'));
    directories.push(directory);
    const database = join(directory, 'controller.db');
    const lockPath = join(directory, '.controller-runtime.lock');
    writeFileSync(lockPath, '2147483647\n', 'utf8');

    const release = acquireControllerLock(database);

    expect(existsSync(lockPath)).toBe(true);
    expect(readdirSync(directory).filter((name) => name.includes('.claim') || name.includes('.stale.'))).toEqual([]);

    release();
  });
});
