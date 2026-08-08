export interface ChangedFile {
  path: string;
  insertions: number;
  deletions: number;
}

export interface ChurnInput {
  changed: ChangedFile[];
  /** Glob prefixes the task was allowed to modify. */
  ownedGlobs: string[];
  /** Dependency manifests touched, e.g. package.json. */
  dependencyFilesChanged: string[];
  /** True when a criterion actually required a new dependency. */
  dependencyJustified: boolean;
  /** Files whose diff is formatting-only, detected upstream. */
  formattingOnlyFiles: string[];
}

export interface ChurnBreakdown {
  /** 0 = no churn, 1 = maximum penalty. */
  penalty: number;
  outsideOwnership: string[];
  unjustifiedDependencyChanges: string[];
  formattingOnly: string[];
  totalLines: number;
  outsideLines: number;
}

/**
 * Deterministic churn measurement.
 *
 * Explicitly not an LLM judgement: "did this diff touch files it did not own"
 * is a fact, and asking a model to opine on it would introduce noise into a
 * signal used to compare models.
 */
export function measureChurn(input: ChurnInput): ChurnBreakdown {
  const owned = input.ownedGlobs.map(globPrefix);

  const outside = input.changed.filter((f) => !owned.some((prefix) => f.path.startsWith(prefix)));
  const totalLines = input.changed.reduce((sum, f) => sum + f.insertions + f.deletions, 0);
  const outsideLines = outside.reduce((sum, f) => sum + f.insertions + f.deletions, 0);

  const unjustifiedDeps = input.dependencyJustified ? [] : input.dependencyFilesChanged;

  const scopeRatio = totalLines === 0 ? 0 : outsideLines / totalLines;
  const penalty = clamp(
    scopeRatio * 0.6 +
      (unjustifiedDeps.length > 0 ? 0.3 : 0) +
      (input.formattingOnlyFiles.length > 0 ? 0.2 : 0),
  );

  return {
    penalty,
    outsideOwnership: outside.map((f) => f.path),
    unjustifiedDependencyChanges: unjustifiedDeps,
    formattingOnly: input.formattingOnlyFiles,
    totalLines,
    outsideLines,
  };
}

function globPrefix(glob: string): string {
  return glob.replace(/\*\*.*$/, '').replace(/\*.*$/, '');
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}
