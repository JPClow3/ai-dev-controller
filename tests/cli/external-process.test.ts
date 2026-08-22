import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/state/db.js';

const repositoryRoot = process.cwd();
const tsxCli = resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs');
const controllerCli = resolve(repositoryRoot, 'src/cli/main.ts');

describe('CLI command surface through child processes', () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'ai-dev-cli-'));
    cpSync(resolve(repositoryRoot, 'config'), resolve(fixtureRoot, 'config'), { recursive: true });
    cpSync(resolve(repositoryRoot, 'projects'), resolve(fixtureRoot, 'projects'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  async function cli(...args: string[]) {
    return execa(process.execPath, [tsxCli, controllerCli, ...args], {
      cwd: fixtureRoot,
      env: { ...process.env, AI_DEV_DB: './data/controller.db', NO_COLOR: '1' },
    });
  }

  it('registers every operational command with Commander', { timeout: 60_000 }, async () => {
    const commands = [
      'config', 'projects', 'status', 'inspect', 'routes', 'metrics', 'providers', 'usage', 'ui',
      'pause', 'resume', 'retry', 'onboard', 'recover', 'doctor', 'run', 'migrate',
    ];
    const results = await Promise.all(commands.map((command) => cli(command, '--help')));

    for (const [index, result] of results.entries()) {
      expect(result.stdout).toContain(`Usage: ai-dev ${commands[index]}`);
    }
  });

  it('reports configuration and empty controller state without contacting providers', { timeout: 60_000 }, async () => {
    const databasePath = resolve(fixtureRoot, 'data/controller.db');
    const db = openDatabase(databasePath);
    db.close();
    const [configResult, projects, status, inspect, metrics, usage, retry, recover] = await Promise.all([
      cli('config', '--json'),
      cli('projects'),
      cli('status', '--json'),
      cli('inspect', 'MISSING-1'),
      cli('metrics'),
      cli('usage', '--json'),
      cli('retry', 'MISSING-1'),
      cli('recover'),
    ]);
    const config = JSON.parse(configResult.stdout) as {
      global: { concurrency: { activeIssues: number } };
    };
    expect(config.global.concurrency.activeIssues).toBeGreaterThan(0);
    expect(projects.stdout).toContain('portfolio');
    expect(JSON.parse(status.stdout)).toEqual({ runs: [], escalations: [] });
    expect(inspect.stdout).toContain('No active run for MISSING-1.');
    expect(metrics.stdout).toContain('No samples yet.');
    expect(JSON.parse(usage.stdout)).toEqual({ summary: [], history: [] });
    expect(retry.stdout).toContain('No active run for MISSING-1.');
    expect(recover.stdout).toContain('No incomplete runs.');
  });

  it('migrates, mutates operator state, and reports it from separate processes', { timeout: 60_000 }, async () => {
    const migrated = await cli('migrate');
    expect(migrated.stdout).toContain('data/controller.db ready');

    const databasePath = resolve(fixtureRoot, 'data/controller.db');
    const db = openDatabase(databasePath);
    db.raw
      .prepare("INSERT INTO issues (id, state, paused) VALUES ('JP-CLI', 'QUEUED', 0)")
      .run();
    db.raw
      .prepare("INSERT INTO runs (id, issue_id, repository_id, state) VALUES ('run-cli', 'JP-CLI', 'lorebound', 'BLOCKED_HUMAN')")
      .run();
    db.close();

    expect((await cli('pause', 'JP-CLI')).stdout).toContain('JP-CLI paused');
    expect((await cli('resume', 'JP-CLI')).stdout).toContain('JP-CLI unblocked and requeued');

    const status = JSON.parse((await cli('status', '--json')).stdout) as {
      runs: Array<{ issueId: string; state: string }>;
    };
    expect(status.runs).toEqual(
      expect.arrayContaining([expect.objectContaining({ issueId: 'JP-CLI', state: 'QUEUED' })]),
    );

    const verified = openDatabase(databasePath);
    expect(
      verified.raw.prepare("SELECT paused FROM issues WHERE id = 'JP-CLI'").get(),
    ).toEqual({ paused: 0 });
    expect(
      verified.raw
        .prepare("SELECT reason FROM state_transitions WHERE run_id = 'run-cli' ORDER BY id DESC LIMIT 1")
        .get(),
    ).toEqual({ reason: 'resumed by operator' });
    verified.close();
  });
});
