# Taste
- Prefers non-destructive git reconciliation: verify divergence first (`git cherry` for patch-id equivalence, tree diffs against `origin/main~1`), then `git pull --rebase` to drop duplicated commits — avoiding force-pushes and relying on reflog for recoverability. Confidence: 0.8
- Investigates before mutating git state: fetch, compare both sides of divergence, and confirm local work is fully contained upstream before rebasing or pushing. Confidence: 0.85
- Always verifies final state after git operations (status, log, diff against remote) before declaring a task complete. Confidence: 0.8
- Prioritizes security findings first (command injection, evadable deny-list screening, secrets handling), then reliability (unhandled promise rejections, silent `.catch(() => '')` swallowing git failures, race conditions), then hygiene (dead deps, inverted imports), then tooling/testing, then observability. Confidence: 0.75
- Values fail-loud behavior over silent error swallowing — flags empty catch blocks, floating promises, and `.catch(() => '')` patterns that mask real failures. Confidence: 0.8
- Recommends concrete, file-path-and-line-specific fixes (e.g., `src/orca/terminals.ts:157`) rather than vague advice, and offers a small high-value next step at the end of a review. Confidence: 0.8
- Favors allow-lists over deny-lists for command safety screening, and argv-based execution over `shell: true`. Confidence: 0.75
- Wants linters/formatters (oxlint/biome), coverage tooling (`@vitest/coverage-v8`) with CI gates, and self-installing git hooks via npm `prepare`. Confidence: 0.7
- Investigates a codebase with parallel subagent explorations (architecture, code quality, testing/tooling) before answering broad questions like "how do we improve this app". Confidence: 0.8
