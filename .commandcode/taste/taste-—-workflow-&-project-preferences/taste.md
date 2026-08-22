# Taste — Workflow & project preferences
- Wants the development workflow automated end-to-end: Linear issue → agent execution → draft PR → human review, including closing issues via commit/PR references for a complete lifecycle. Confidence: 0.8
- Prefers full audit sweeps of a project (improvements, fixes, QOL, bugs) and applying all suggested + residual items in one pass rather than incrementally. Confidence: 0.8
- Wants README and other documentation updated as part of code changes, not left as a follow-up. Confidence: 0.8
- Expects routine test failures to be auto-fixed by the tooling when they show up, instead of being surfaced for manual handling. Confidence: 0.7
- Wants issues to be "AI ready" after automated curation: the curation step should gather repository context itself rather than returning "needs context" to a human; flow is curation > implementation. Confidence: 0.7
- Builds deterministic orchestration around AI agents (Codex, Claude) so coordination decisions (ordering, concurrency, routing, what counts as a real blocker) are automated, keeping the human involved only for genuine product/repo ambiguity. Confidence: 0.6
- Prefers provider-agnostic, multi-provider integration over single-vendor lock-in: wants to connect several AI providers/models and route work based on quota, token usage, and available credit so a low limit on one provider shifts traffic to another rather than blocking. Confidence: 0.6
- Wants an observability dashboard (TUI or GUI) for operational state: which providers are connected, remaining limits/tokens, and historical usage — visibility into consumption and connection health, not just config. Confidence: 0.6
