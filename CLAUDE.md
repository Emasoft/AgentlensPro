# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Doctrine sentences in this file must cite their evidence (a report path under `reports/`).

## AgentlensPro diagnostics (CLI — the MCP server is deliberately NOT registered)

All 32 diagnostic tools are called via the globally-linked single **`agentlenspro`** executable
(`npm link` from this repo; source `standalone/cli.ts` → `src/cli/*`), not MCP: resident MCP
schemas cost ~8k tokens per turn and any toolset change breaks the prompt-cache prefix, so
`.mcp.json` intentionally does not register the server. The user-scoped
**`agentlenspro-diagnostics`** skill documents the full surface; the essentials:

```bash
agentlenspro setup [--dry-run] [--yes]           # detect → converge → verify → self-test (idempotent installer/repairer)
agentlenspro server start|stop|restart|status    # manage the server; `dashboard` opens the UI
agentlenspro list --desc                         # discover tools
agentlenspro help <tool>                         # flags from the live schema
agentlenspro <tool> --param value --out FILE     # full JSON to disk, digest to stdout
agentlenspro --install-otel | --uninstall-otel   # wire/unwire Claude Code telemetry (verified transaction)
agentlenspro --install-hooks | --uninstall-hooks # wire/unwire lifecycle hook capture + the burn-gate
                                                 # (PreToolUse deny on agent-launch disasters; AGENTLENS_GATE=off)
agentlenspro --install-skill                     # (re)install this skill into ~/.claude/skills/
```

Both `--install-*` settings flags go through `safeConfigEdit`; they never clobber other tools'
hooks, and a hook change needs a session restart to take effect.

Before any task: `get_recent_sessions` (recent work + cost) and `get_workspace_patterns`
(hot files, recurring issues) — batch them in one invocation. Do not re-register the MCP
server without asking the user.

## What this is

AgentlensPro (repo: <https://github.com/Emasoft/AgentlensPro>, forked from AgentLens) is a local AI-agent observability product — a CLI, an **npx/standalone server** with a served dashboard, a **Docker image**, and Claude Code skills, all from one codebase (the VS Code extension host was removed pre-fork). It ingests OpenTelemetry traces and local session log files from Copilot, Claude Code, Codex, and OpenCode, persists them to a local SQLite DB, and renders a dashboard. See `ARCHITECTURE.md` (deep, with mermaid diagrams) and `README.md` (user-facing) for full detail.

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

## Architecture: three runtime contexts, one codebase

This is the single most important thing to internalize. Code is split by **where it executes**, and the three contexts cannot import each other:

1. **`src/**`** — core **Node.js** logic (no DOM), bundled into the standalone outputs and exercised by the unit tests. The VS Code extension host was removed pre-fork (TRDD-6E6416B8) — there is no `src/extension.ts` and no `vscode` dependency; the retained persistence modules (`src/database/*`, `sessionRepository.ts`) type-check via the structural stand-ins in `src/vscodeCompat.ts` and run only under tests.
2. **`media/src/**`** — the served **dashboard** (Preact + `@preact/signals`, browser, no Node). Entry `media/src/dashboard.tsx` → `media/dashboard.js` (iife); plus `media/src/sidebarWebview.ts` → `media/sidebar.js`.
3. **`standalone/**`** — the server + CLI that reuse `src/**` (the `npx agentlenspro` path). `standalone/server.ts` + `standalone/cli.ts` → `standalone/*.js` (cjs).

`esbuild.js` builds **four** separate targets for these. The server↔dashboard boundary is a **message-shaped protocol** (`media/src/App.tsx` message handler, fed in standalone by an inline shim that proxies `/api/*` endpoints on `standalone/server.ts`); the two sides share shapes by importing **`src/shared/`** — the runtime-neutral directory (no Node imports, no DOM APIs) that holds the card/timeline/telemetry types and the pure engines. `media/src/types.ts` declares ONLY webview-specific message/UI types and re-exports the shared ones; it must never re-declare them (see the shared-module gotcha below). Evidence: `reports/p2-dedup/20260710_183417+0200-shared-modules.md`.

### Dual ingestion → SQLite (`SessionRepository` is the single read point)

Two independent sources converge on `DatabaseWriter`:

- **OTLP/HTTP (network):** agents POST to `OtlpCollector` (port 4318) → `SessionStore` (5-minute rolling span window) → `spanSummarizer` → write.
- **Local logs (disk):** `LogReader` parses JSONL from `~/.claude`, `~/.codex`, `~/.copilot`, and OpenCode's SQLite db → write.

When both capture the same session: **for Claude sessions the log transcript wins on collision (OTEL is a lossy lower bound — span-store eviction + collector downtime); OTEL wins only where no transcript exists. Every other source keeps OTEL-wins.** The rule lives in ONE place — `src/feedMergePolicy.ts` — consumed by the standalone merge, the repository merge/dedup, and the DB write guard; never re-encode the preference inline. `SessionRepository` is the one place reads happen — it merges the persisted SQLite DB with the live in-memory span window. Per-agent parsing is isolated in `src/summarizers/{claude,codex,copilot}.ts`; storage in `src/database/` (`schema.ts`, `writer.ts`, `reader.ts`, `migration.ts`, `retention.ts`).

## Gotchas

- **NEVER write a user config file with `fs.writeFile`/`JSON.parse`-fallback.** Every mutation of `~/.claude/settings.json`, `~/.codex/config.toml`, or VS Code `settings.json` MUST go through `safeConfigEdit` (`src/safeConfigEdit.ts` → `scripts/safe_config_edit.py`): a verified transaction (refuse-unparseable, verify-diff, atomic backup+rename, cross-process lock, bounded retries). A direct writer with a "start fresh on parse failure" path wiped a user's entire 57.8KB settings.json on 2026-07-07 (commit 1a661a9 removed it — do not reintroduce the pattern).

- **One source of truth in `src/shared/` — never mirror it into `media/src/`.** The runtime-neutral modules (`pricing.ts`, `summarizerTypes.ts`, `telemetryTypes.ts`, `cacheBreak.ts`, `keepWarm.ts`, `tokenBuckets.ts`, `fallbackCounters.ts`, `residentCost.ts`, `spawnRollup.ts`, `tokensByCause.ts`) are imported by BOTH the host and the webview; they must stay free of Node imports and DOM APIs. The old hand-synced copies drifted (the webview's cacheBreak had lost FAST_MODE detection; the two pricing tables had diverged into different interfaces), so `scripts/check-no-mirrors.js` (`pnpm run check-mirrors`, run in CI after Lint) FAILS the build if any file under `media/src/` re-declares a symbol `src/shared/` exports — import or re-export instead. Rates change in ONE place: `src/shared/pricing.ts` (bump `PRICING_LAST_UPDATED`; `PRICING_SOURCES.md` has the authoritative per-provider rate URLs). Evidence: `reports/p2-dedup/20260710_183417+0200-shared-modules.md`.
- **`sql.js` is not bundled.** The standalone server resolves it from `node_modules` at runtime (`require.resolve('sql.js')` + `locateFile` for its WASM, `standalone/server.ts`) to read OpenCode's SQLite database; when it is unavailable, OpenCode ingestion falls back to the per-message JSON files.
- **Unit tests mock the `vscode` module** via `src/test/setup.js` → `src/test/__mocks__/vscode.js` (so mocha runs without VS Code). Tests needing the real VS Code API belong in `pnpm test` (vscode-test) instead.
- **`.githooks/{post-merge,post-rewrite}`** rebuild bundles after pull/rebase to keep `standalone/*.js` in sync with source, but they are **not auto-enabled** — opt in with `git config core.hooksPath .githooks`.
- **Fixture JSON is gitignored** (`demo/fixtures/*.json`, `export_*.json`). Run `node scripts/redact-spans.js` before committing any fixture — they contain real telemetry/PII.

## Contribution conventions

Branch `feat/<slug>` or `fix/<slug>` off `main`; **Conventional Commits** (`type(scope): subject`); merges are **`--no-ff`, NEVER squash — history is the audit trail**. For user-facing changes, bump `version` in `package.json` and add a `CHANGELOG.md` entry **in the same PR**; tag `main` `vX.Y.Z` after merge.
