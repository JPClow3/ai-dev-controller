import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireControllerLock } from '../../src/state/lock.js';

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
});
