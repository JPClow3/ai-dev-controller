---
name: ai-dev-controller-dev
description: >-
  Development runbook, architecture patterns, and verification commands for the AI Dev Controller
  autonomous orchestrator, model routing, Orca worktree management, and Linear/GitHub syncing.
---

# AI Dev Controller Development Skill

This skill provides procedures and architectural guidelines for developing, testing, and operating the `ai-dev-controller` autonomous system.

## 1. Project Architecture & Stack

- **Runtime**: Node.js 24+ (or Node 26) / TypeScript (ESM)
- **Database**: SQLite (`better-sqlite3`) with schema migrations (`src/state/migrations.ts`)
- **Orchestration**: Orca CLI worktrees, terminals, and workspace board status tracking (`src/orca/`)
- **Model Routing**: Pure OpenAI/ChatGPT Codex profiles (`gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`) with Luna-heavy cost routing and token penalty ledger (`src/routing/`, `src/agents/`)
- **Integrations**: Linear GraphQL API (`src/linear/`), GitHub Checks and Pull Requests API (`src/github/`)
- **Testing**: Vitest (`tests/`) with 43 suites and 600+ unit, integration, and regression tests

## 2. Key Commands

### Environment Setup
```powershell
pnpm install
```

### Verification & Testing
```powershell
# Run full Vitest test suite (43 suites)
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run TypeScript typecheck
pnpm typecheck

# Run SQLite migrations
pnpm migrate

# Run production build
pnpm build
```

### Running the Controller
```powershell
# Run one scheduler tick
pnpm dev -- --tick

# Run continuous scheduler loop
pnpm dev

# Run CLI commands
pnpm cli status
pnpm cli projects
pnpm cli inspect <issue-id>
```

## 3. Core Architectural Invariants

1. **State Transitions & Orca Board**: Workflow states map strictly to Orca workspace board columns (`todo`, `in-progress`, `in-review`, `completed`). Transitions must keep Linear labels, SQLite state, and Orca board in sync.
2. **Model Routing**: High-volume tasks (routine_bugfix, multi_file_feature, large_context, planning) route to Luna (`luna_xhigh` / `luna_high`) for cost efficiency. Review and high_risk roles use Sol. Token usage is persisted in `token_usage` table and penalizes verbose aliases in utility calculations.
3. **Safety First**: Workers may write code that modifies systems, but the controller forbids autonomous execution of destructive operations (production DB mutation, force-pushing protected branches, PR auto-merges).

## 4. Git Tagging & Release Workflow

- **Release Tag Standard**: `vMAJOR.MINOR.PATCH` (e.g. `v0.1.0`)
- **Commands**:
  ```powershell
  git tag -a v0.1.0 -m "Release v0.1.0: Multi-project autonomous dev controller"
  git push origin v0.1.0
  ```
