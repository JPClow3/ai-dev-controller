import { describe, expect, it } from 'vitest';
import { hasControllerPrefix, assertControllerBranch, ForbiddenGitOperation } from '../../src/git/repository.js';
import { issueIdFromBranch } from '../../src/github/pull-requests.js';
import { worktreePathFromId } from '../../src/orca/worktrees.js';
import { matchesRequestedBranch, shortBranch } from '../../src/workflow/dispatch.js';
import { pressureFromOrca, defaultPressure, isUsable } from '../../src/routing/pressure.js';
import { parseAcceptanceCriteria } from '../../src/workflow/runner.js';
import { loadControllerConfig } from '../../src/config/load-config.js';

/**
 * Every case here is a defect the first live end-to-end run actually hit.
 * They are grouped by the assumption that turned out to be false, because the
 * shared root cause is more useful than the individual symptoms: the
 * controller had been written against an imagined Orca rather than the
 * installed one.
 */

describe('Orca names branches, the controller does not', () => {
  /**
   * `orca worktree create --name ai/JP-9-work` produces
   * `refs/heads/JPClow3/ai/JP-9-work`. There is no flag to override it.
   */
  const ORCA_BRANCH = 'refs/heads/JPClow3/ai/JP-9-work';

  it('strips the ref prefix Orca reports', () => {
    expect(shortBranch(ORCA_BRANCH)).toBe('JPClow3/ai/JP-9-work');
    expect(shortBranch(undefined)).toBe('');
  });

  it('recognises an owner-namespaced branch as the one it asked for', () => {
    // Equality returned false for every real worktree, so duplicate detection
    // never fired and a restart created a second worktree each time.
    expect(matchesRequestedBranch({ id: 'r::p', path: 'p', branch: ORCA_BRANCH }, 'ai/JP-9-work')).toBe(true);
    expect(matchesRequestedBranch({ id: 'r::p', path: 'p', branch: ORCA_BRANCH }, 'ai/JP-8-work')).toBe(false);
  });

  it('still refuses to push a branch the controller did not create', () => {
    // The guard was relaxed to accept a namespaced prefix, not removed.
    expect(hasControllerPrefix('JPClow3/ai/JP-9-work', 'ai/')).toBe(true);
    expect(hasControllerPrefix('ai/JP-9-work', 'ai/')).toBe(true);
    expect(hasControllerPrefix('JPClow3/hotfix', 'ai/')).toBe(false);
    expect(hasControllerPrefix('feature/ai-thing', 'ai/')).toBe(false);
  });

  it('never pushes a base branch, however it is namespaced', () => {
    expect(() => assertControllerBranch('main', 'ai/', 'main')).toThrow(ForbiddenGitOperation);
    expect(() => assertControllerBranch('master', 'ai/', 'main')).toThrow(ForbiddenGitOperation);
    expect(() => assertControllerBranch('JPClow3/ai/JP-9-work', 'ai/', 'main')).not.toThrow();
  });

  it('resolves an issue id from a namespaced merged branch', () => {
    // Without this a merged PR released none of its blockers.
    expect(issueIdFromBranch('JPClow3/ai/JP-8-work', 'ai/')).toBe('JP-8');
    expect(issueIdFromBranch('ai/JP-8-work', 'ai/')).toBe('JP-8');
    expect(issueIdFromBranch('JPClow3/feature/JP-8', 'ai/')).toBeNull();
  });
});

describe('the run works in its worktree, not in the registry clone', () => {
  /**
   * Orca worktrees are real `git worktree`s sharing the main clone's object
   * store. Cherry-picking into the registry path therefore landed worker
   * commits on the checked-out BASE branch of the user's own working copy.
   */
  it('reads the path out of an Orca worktree id', () => {
    expect(worktreePathFromId('86c0e1e0::C:/Users/x/orca/workspaces/Lorebound/ai-JP-8-work')).toBe(
      'C:/Users/x/orca/workspaces/Lorebound/ai-JP-8-work',
    );
  });

  it('refuses an id with no path rather than falling back to the clone', () => {
    expect(() => worktreePathFromId('86c0e1e0')).toThrow(/carries no path/);
    expect(() => worktreePathFromId('86c0e1e0::')).toThrow(/carries no path/);
  });
});

describe('a stale quota reading is not a spent quota', () => {
  const NOW = 1_000_000_000_000;

  it('ignores a window whose reset has already passed', () => {
    // Orca caches its last reading. Believing a 100% window that reset hours
    // ago marked the only usable provider EXHAUSTED and stalled everything.
    const result = pressureFromOrca(
      { codex: { weekly: { usedPercent: 100, resetsAt: NOW - 60_000 } } },
      NOW,
    );
    expect(result).toEqual({});
  });

  it('believes a window that has not reset yet', () => {
    const result = pressureFromOrca(
      { codex: { weekly: { usedPercent: 100, resetsAt: NOW + 60_000 } } },
      NOW,
    );
    expect(result['chatgpt']?.pressure).toBe('EXHAUSTED');
  });

  it('grades pressure by how much of the window is spent', () => {
    const at = (usedPercent: number) =>
      pressureFromOrca({ codex: { weekly: { usedPercent, resetsAt: NOW + 60_000 } } }, NOW)['chatgpt']
        ?.pressure;
    expect(at(10)).toBe('LOW');
    expect(at(50)).toBe('NORMAL');
    expect(at(85)).toBe('HIGH');
  });
});

describe('a Codex-only portfolio still routes every role', () => {
  /**
   * The pilot disables both Ollama providers. Every role must still resolve to
   * a reachable alias, or the run dies at its first routing decision.
   */
  it('leaves at least one ChatGPT-backed candidate in every role', () => {
    const config = loadControllerConfig(process.cwd());
    let pressure = defaultPressure(config.routing);
    pressure = { ...pressure, ollama: { ...pressure['ollama']!, pressure: 'EXHAUSTED' } };
    pressure = { ...pressure, ollama_local: { ...pressure['ollama_local']!, pressure: 'EXHAUSTED' } };

    for (const [name, role] of Object.entries(config.routing.roles)) {
      const reachable = [role.champion, ...role.challengers].filter((alias) => {
        const spec = config.routing.aliases[alias];
        return spec ? isUsable(pressure, spec.provider) : false;
      });
      expect(reachable, `role ${name} has no reachable alias`).not.toHaveLength(0);
    }
  });
});

describe('acceptance criteria come from the issue, not from nowhere', () => {
  /**
   * Nothing populated them, so the review packet carried an empty criteria
   * list and the PR body rendered an empty checklist — the reviewer had no
   * yardstick at all.
   */
  it('reads AC labels out of a Linear body', () => {
    const body = [
      '# Acceptance criteria',
      '',
      '- AC-1: `canAffordInk` is exported.',
      '* [ ] AC-2 — a balance equal to the cost is affordable.',
      'AC-3. shortfall is never negative',
      '',
      'Some prose mentioning AC-1 again should not duplicate it.',
    ].join('\n');

    expect(parseAcceptanceCriteria(body)).toEqual([
      { id: 'AC-1', statement: '`canAffordInk` is exported.' },
      { id: 'AC-2', statement: 'a balance equal to the cost is affordable.' },
      { id: 'AC-3', statement: 'shortfall is never negative' },
    ]);
  });

  it('returns nothing rather than inventing criteria', () => {
    expect(parseAcceptanceCriteria('An issue with no criteria at all.')).toEqual([]);
    expect(parseAcceptanceCriteria('')).toEqual([]);
  });
});
