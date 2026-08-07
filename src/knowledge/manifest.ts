import { z } from 'zod';

/**
 * Knowledge categories.
 *
 * `historical_notes` earns its place: a stale design doc that agents follow is
 * worse than no doc at all, so superseded material is retained but explicitly
 * demoted rather than deleted.
 */
export const KNOWLEDGE_CATEGORIES = [
  'architecture',
  'domain',
  'product',
  'coding_conventions',
  'testing',
  'deployment',
  'security',
  'database',
  'ui_design',
  'historical_notes',
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export interface ClassifiedKnowledge {
  path: string;
  category: KnowledgeCategory;
  confidence: number;
  summary: string;
  /** True when the classifier inferred rather than read this. */
  inferred?: boolean;
}

export interface KnowledgeConflict {
  topic: string;
  sources: string[];
  description: string;
}

export interface KnowledgeMap {
  sources: Record<KnowledgeCategory, string[]>;
  exclude: string[];
  conflicts: KnowledgeConflict[];
  generatedAt: string;
}

export const classifiedKnowledgeSchema = z.object({
  path: z.string(),
  category: z.enum(KNOWLEDGE_CATEGORIES),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  inferred: z.boolean().optional(),
});

export const classificationResponseSchema = z.object({
  classified: z.array(classifiedKnowledgeSchema),
  exclude: z.array(z.string()).default([]),
  conflicts: z
    .array(
      z.object({
        topic: z.string(),
        sources: z.array(z.string()).min(2),
        description: z.string(),
      }),
    )
    .default([]),
});

function emptySources(): Record<KnowledgeCategory, string[]> {
  const sources = {} as Record<KnowledgeCategory, string[]>;
  for (const category of KNOWLEDGE_CATEGORIES) sources[category] = [];
  return sources;
}

export function buildKnowledgeMap(
  classified: ClassifiedKnowledge[],
  exclude: string[] = [],
  conflicts: KnowledgeConflict[] = [],
): KnowledgeMap {
  const sources = emptySources();
  for (const item of classified) {
    const bucket = sources[item.category];
    if (!bucket.includes(item.path)) bucket.push(item.path);
  }
  for (const list of Object.values(sources)) list.sort();

  return {
    sources,
    exclude: [...exclude].sort(),
    conflicts,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Documents an agent should actually be shown. Historical notes are mapped so
 * a human can see them, but never fed to a worker as guidance.
 */
export function activeSources(map: KnowledgeMap): string[] {
  return KNOWLEDGE_CATEGORIES.filter((c) => c !== 'historical_notes').flatMap((c) => map.sources[c]);
}
