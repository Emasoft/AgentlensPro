# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## AgentLens MCP (this project dogfoods its own MCP server)

Before any task: call `get_recent_sessions` (recent work + cost) and `get_workspace_patterns` (hot files, recurring issues).
Only use `find_relevant_context` if your task closely matches past prompts by keyword — skip it for novel tasks.
Other tools: `get_session_detail`, `get_efficiency_report`, `get_instruction_suggestions` (all defined in `src/mcpServer.ts`).

## What this is

AgentLens is a local AI-agent observability tool, shipped three ways from one codebase: a **VS Code extension**, an **npx/standalone server**, and a **Docker image**. It ingests OpenTelemetry traces and local session log files from Copilot, Claude Code, Codex, and OpenCode, persists them to a local SQLite DB, and renders a dashboard. See `ARCHITECTURE.md` (deep, with mermaid diagrams) and `README.md` (user-facing) for full detail.

## Commands

Package manager is **pnpm**. Node 18+.

| Task | Command |
| --- | --- |
| Type-check (both runtimes) | `pnpm run check-types` |
| Lint | `pnpm run lint` |
| Bundle only (no checks) | `node esbuild.js` |
| Full compile (check + lint + bundle) | `pnpm run compile` |
| Production bundle (what ships) | `pnpm run package` |
| Watch (rebuild on change) | `pnpm run watch` |
| Run standalone server locally | `pnpm run local` |
| Unit tests (fast, mocked VS Code) | `pnpm run test:unit` |
| Integration tests (real VS Code) | `pnpm test` |

**Run a single unit test** — tests compile from `src/**` to `out/test/`, so `src/test/database/writer.test.ts` → `out/test/test/database/writer.test.js`:

```bash
pnpm run compile-tests && npx mocha out/test/test/database/writer.test.js   # one file
pnpm run compile-tests && npx mocha --grep "drains the queue"               # by test name
```

`check-types` runs `tsc --noEmit` twice — once for `src/` (`tsconfig.json`, Node) and once for `media/src/` (`media/tsconfig.json`, DOM/Preact). TypeScript is `strict` plus `noUnusedLocals`/`noUnusedParameters`/`noImplicitReturns`, so unused symbols fail the build.

> `CONTRIBUTING.md` mentions `pnpm run standalone` — that script does not exist; the correct one is `pnpm run local`.

## Architecture: three runtime contexts, one codebase

This is the single most important thing to internalize. Code is split by **where it executes**, and the three contexts cannot import each other:

1. **`src/**`** — VS Code **extension host** (Node.js, no DOM). Entry `src/extension.ts` → `dist/extension.js` (cjs).
2. **`media/src/**`** — **webview** dashboard (Preact + `@preact/signals`, browser, no Node). Entry `media/src/dashboard.tsx` → `media/dashboard.js` (iife); plus `media/src/sidebarWebview.ts` → `media/sidebar.js`.
3. **`standalone/**`** — headless server that reuses `src/**` logic outside VS Code (the `npx agentlens-dashboard` path). `standalone/server.ts` + `standalone/cli.ts` → `standalone/*.js` (cjs).

`esbuild.js` builds **five** separate targets for these. The extension↔webview boundary is a **postMessage protocol** (`src/dashboardPanel.ts` ↔ `media/src/App.tsx`); the two sides share shapes by **mirroring types** (`src/types.ts` ↔ `media/src/types.ts`), not by importing — the webview cannot import Node code. When you change a message shape or a session field, update **both** sides.

### Dual ingestion → SQLite (`SessionRepository` is the single read point)

Two independent sources converge on `DatabaseWriter`:

- **OTLP/HTTP (network):** agents POST to `OtlpCollector` (port 4318) → `SessionStore` (5-minute rolling span window) → `spanSummarizer` → write.
- **Local logs (disk):** `LogReader` parses JSONL from `~/.claude`, `~/.codex`, `~/.copilot`, and OpenCode's SQLite db → write.

When both capture the same session, **OTEL always wins**. `SessionRepository` is the one place reads happen — it merges the persisted SQLite DB with the live in-memory span window. Per-agent parsing is isolated in `src/summarizers/{claude,codex,copilot}.ts`; storage in `src/database/` (`schema.ts`, `writer.ts`, `reader.ts`, `migration.ts`, `retention.ts`).

## Gotchas

- **NEVER write a user config file with `fs.writeFile`/`JSON.parse`-fallback.** Every mutation of `~/.claude/settings.json`, `~/.codex/config.toml`, or VS Code `settings.json` MUST go through `safeConfigEdit` (`src/safeConfigEdit.ts` → `scripts/safe_config_edit.py`): a verified transaction (refuse-unparseable, verify-diff, atomic backup+rename, cross-process lock, bounded retries). A direct writer with a "start fresh on parse failure" path wiped a user's entire 57.8KB settings.json on 2026-07-07 (commit 1a661a9 removed it — do not reintroduce the pattern).

- **Two pricing tables, synced by hand.** `src/pricing.ts` (extension host, write-time, stored as `cost_usd`) and `media/src/pricing.ts` (browser, display-time) carry duplicate rate tables on purpose. Change rates in **both**. `PRICING_SOURCES.md` has the authoritative per-provider rate URLs.
- **`sql.js` is not bundled.** It's `external` in the extension build and loaded dynamically at runtime; esbuild copies its WASM to `dist/sql-wasm.wasm`, located via `extensionUri` at activation.
- **Unit tests mock the `vscode` module** via `src/test/setup.js` → `src/test/__mocks__/vscode.js` (so mocha runs without VS Code). Tests needing the real VS Code API belong in `pnpm test` (vscode-test) instead.
- **`.githooks/{post-merge,post-rewrite}`** rebuild bundles after pull/rebase to keep `standalone/*.js` in sync with source, but they are **not auto-enabled** — opt in with `git config core.hooksPath .githooks`.
- **Fixture JSON is gitignored** (`demo/fixtures/*.json`, `export_*.json`). Run `node scripts/redact-spans.js` before committing any fixture — they contain real telemetry/PII.

## Contribution conventions

Branch `feat/<slug>` or `fix/<slug>` off `main`; **Conventional Commits** (`type(scope): subject`); PRs are **squash-merged**. For user-facing changes, bump `version` in `package.json` and add a `CHANGELOG.md` entry **in the same PR**; tag `main` `vX.Y.Z` after merge.
