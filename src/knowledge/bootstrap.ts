import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { deriveProject, detectCiTrigger, renderProjectYaml, type DerivedProject } from './derive.js';
import { buildKnowledgeMap, type ClassifiedKnowledge, type KnowledgeConflict, type KnowledgeMap } from './manifest.js';
import { discoverKnowledgeFiles, type DiscoveryOptions } from './discovery.js';

export interface BootstrapPlan {
  projectId: string;
  repoPath: string;
  baseBranch: string;
  ciTrigger: 'pull_request' | 'branch_push' | 'none';
  derived: DerivedProject;
  map: KnowledgeMap;
  files: Array<{ path: string; content: string }>;
  /** Files that already exist and are deliberately left untouched. */
  preserved: string[];
}

export interface BootstrapInput {
  projectId: string;
  repoPath: string;
  baseBranch: string;
  discovery: DiscoveryOptions;
  classified?: ClassifiedKnowledge[];
  conflicts?: KnowledgeConflict[];
}

/**
 * Plans a repository's bootstrap without writing anything.
 *
 * Map, do not move. Existing documentation stays exactly where it is with
 * exactly its current content — the repository may be messy, and that is
 * allowed. Only new files under `.ai-workflow/` (plus AGENTS.md when absent)
 * are produced.
 */
export function planBootstrap(input: BootstrapInput): BootstrapPlan {
  const candidates = discoverKnowledgeFiles(input.repoPath, input.discovery);
  const derived = deriveProject(input.repoPath, input.baseBranch);
  const ciTrigger = detectCiTrigger(input.repoPath);

  const classified =
    input.classified ??
    candidates.map((c) => ({
      path: c.path,
      category: 'domain' as const,
      confidence: 0,
      summary: 'unclassified (no model available at bootstrap time)',
      inferred: true,
    }));

  const map = buildKnowledgeMap(classified, input.discovery.excludeGlobs, input.conflicts ?? []);

  const files: Array<{ path: string; content: string }> = [
    { path: '.ai-workflow/project.yaml', content: renderProjectYaml(input.projectId, derived) },
    { path: '.ai-workflow/knowledge-map.yaml', content: stringify(map) },
    {
      path: '.ai-workflow/generated/unresolved-conflicts.md',
      content: renderConflicts(map.conflicts, derived),
    },
  ];

  const preserved: string[] = [];
  const agentsPath = join(input.repoPath, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    // Never overwrite an AGENTS.md the author wrote. 7 of 9 repositories
    // already have one.
    preserved.push('AGENTS.md');
    files.push({
      path: '.ai-workflow/generated/agents-addendum.md',
      content: renderAgents(input.projectId, derived, ciTrigger, true),
    });
  } else {
    files.push({ path: 'AGENTS.md', content: renderAgents(input.projectId, derived, ciTrigger, false) });
  }

  for (const candidate of candidates) preserved.push(candidate.path);

  return {
    projectId: input.projectId,
    repoPath: input.repoPath,
    baseBranch: input.baseBranch,
    ciTrigger,
    derived,
    map,
    files,
    preserved,
  };
}

/** Writes the planned files. Refuses to overwrite anything not in the plan. */
export function applyBootstrap(plan: BootstrapPlan): string[] {
  const written: string[] = [];
  for (const file of plan.files) {
    const full = join(plan.repoPath, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content, 'utf8');
    written.push(file.path);
  }
  return written;
}

function renderAgents(
  projectId: string,
  derived: DerivedProject,
  ciTrigger: string,
  addendum: boolean,
): string {
  const commands = derived.commands.length
    ? derived.commands.map((c) => `- \`${c.command}\`${c.required ? ' (required)' : ''}`).join('\n')
    : '- **None derived.** Fill in `.ai-workflow/project.yaml` before running agents here.';

  return [
    addendum ? `# AI workflow addendum — ${projectId}` : `# AGENTS.md — ${projectId}`,
    '',
    addendum
      ? 'This repository already has an `AGENTS.md`, which was left untouched. This file records only what the AI dev controller needs.'
      : 'Entry point for automated agents working in this repository.',
    '',
    '## Non-negotiables',
    '',
    `- Base branch: \`${derived.baseBranch}\``,
    `- CI trigger: \`${ciTrigger}\``,
    '- Never merge a pull request. Never push to the base branch. Never force-push.',
    '- Never run migrations, deployments, or destructive operations against production.',
    '',
    '## Validation',
    '',
    commands,
    '',
    '## Knowledge map',
    '',
    'See `.ai-workflow/knowledge-map.yaml`. Documents under `historical_notes` are superseded and must not be followed.',
    '',
  ].join('\n');
}

function renderConflicts(conflicts: KnowledgeConflict[], derived: DerivedProject): string {
  const lines = ['# Unresolved conflicts', ''];

  if (derived.notes.length > 0) {
    lines.push('## Undetermined during bootstrap', '');
    for (const note of derived.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  if (conflicts.length === 0) {
    lines.push('## Contradictory documentation', '', 'None detected.', '');
  } else {
    lines.push('## Contradictory documentation', '');
    for (const conflict of conflicts) {
      lines.push(`### ${conflict.topic}`, '', `Sources: ${conflict.sources.join(', ')}`, '', conflict.description, '');
    }
  }

  lines.push(
    '---',
    '',
    'These are recorded, not resolved. Picking a winner is a human decision.',
    '',
  );
  return lines.join('\n');
}
