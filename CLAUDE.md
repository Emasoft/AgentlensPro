# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Doctrine sentences in this file must cite their evidence (a report path under `reports/`).

## AgentlensPro diagnostics (CLI — the MCP server is deliberately NOT registered)

All diagnostic tools (discover them with `agentlenspro list --desc`) are called via the globally-linked single **`agentlenspro`** executable
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
- **`@duckdb/node-api` is not bundled either — and a FAILED esbuild leaves the STALE bundle in place.** Native `.node` addons cannot be bundled, so the package is `external` in both node targets of `esbuild.js` and resolves from `node_modules` at runtime (it is a declared runtime dependency). The trap (commit 36c87c8): when esbuild fails it does NOT touch the outfile, so `standalone/*.js` keeps its old mtime and *looks* current — the store code sat un-shipped for a day this way while tsc+mocha gates (which run from `out/`, never esbuild) stayed green. **A change is deployed only after `node esbuild.js` succeeds AND `agentlenspro server restart` — verify with a grep for a new symbol in the bundle when in doubt.**
- **Unit tests mock the `vscode` module** via `src/test/setup.js` → `src/test/__mocks__/vscode.js` (so mocha runs without VS Code). Tests needing the real VS Code API belong in `pnpm test` (vscode-test) instead.
- **`.githooks/{post-merge,post-rewrite}`** rebuild bundles after pull/rebase to keep `standalone/*.js` in sync with source, but they are **not auto-enabled** — opt in with `git config core.hooksPath .githooks`.
- **Fixture JSON is gitignored** (`demo/fixtures/*.json`, `export_*.json`). Run `node scripts/redact-spans.js` before committing any fixture — they contain real telemetry/PII.
- **`.claude/settings.json` is PROJECT scope and tracked** (only `settings.local.json` is ignored). It registers one `PreToolUse(Bash)` deny: `scripts/deny-playwright-init-agents.js`, which refuses playwright's agent-generator subcommand because it writes `.claude/agents/`, `.github/agents/`, a `copilot-setup-steps.yml` workflow, and `.mcp.json` — files an agent then loads as instructions. Installing playwright writes nothing (`scripts: {}`); the command is the only trigger, so the invocation is the only thing worth guarding. Matching is token-based (a substring version blocked `git add` of the guard's own filename); `node scripts/test-deny-playwright-init-agents.js` is the 15-case matrix.

## Contribution conventions

Branch `feat/<slug>` or `fix/<slug>` off `main`; **Conventional Commits** (`type(scope): subject`); merges are **`--no-ff`, NEVER squash — history is the audit trail**. For user-facing changes, bump `version` in `package.json` and add a `CHANGELOG.md` entry **in the same PR**; tag `main` `vX.Y.Z` after merge.

## Releases — OIDC trusted publishing, CI-only (bootstrap is DONE)

Publishing is **tag-driven and tokenless**: push `vX.Y.Z` → `.github/workflows/publish.yml`
publishes to npm via the registered trusted publisher (OIDC) with automatic SLSA provenance,
then creates the GitHub Release. NEVER publish locally (the one sanctioned local publish was
the 1.0.0 bootstrap, already done) and NEVER introduce a token/`registry-url:` into the
workflow — a present auth token silently masks OIDC. Load-bearing facts:

- **npm authorizes the workflow FILENAME** — the trusted-publisher entry says `publish.yml`;
  renaming the workflow file (or re-registering under another name) breaks the token
  exchange (`E404 Not Found - PUT`). Keep both sides in lockstep (commit 899292b).
- Re-run a failed publish with `gh workflow run publish.yml` (no re-tag needed; the
  GitHub-Release/attestation steps are tag-guarded).
- Trusted-publisher admin has a CLI: `npm trust list|github|revoke` (npm ≥ 11.15; needs one
  interactive 2FA tap by design — tokens cannot administer trust).
- Post-release verification: registry `_npmUser` must contain `trustedPublisher` and
  `dist.attestations` must exist; a human `_npmUser` with no attestations = token fallback,
  investigate. Fresh 404s right after publish are CDN propagation, not failure.
- The full procedures live in the user-scope skills `npm-oidc-publishing`,
  `npm-pre-publish-checklist`, `npm-post-publish-checklist`.
- Tarball law: `package.json` `files` is the ONE allowlist (never add a `.npmignore` — it
  silently overrides `.gitignore` and once shipped private reports); build outputs must be
  built before `npm pack` or they are silently skipped.

## Operations — deploy, install, repair

ONE executable (`agentlenspro`) manages everything. The idempotent installer/repairer is
`agentlenspro setup [--dry-run] [--yes]`: detect → converge → verify-per-step → final
self-test; it migrates hook registrations across generations, repairs broken/maimed
installs, and NEVER wipes `~/.agentlens` data. Deploy on this machine = `node esbuild.js`
(or `pnpm run package`) + `agentlenspro server restart` (graceful: flushes spans, verifies
dashboard/OTLP). Hook registration changes need a Claude session restart to take effect.

## HOW TOKEN USAGE / CACHE ECONOMICS WORK — read before reasoning about burn OR writing any cost/attribution code (doc-verified 2026-07-11, re-affirmed after a live mis-scaling)

This is the model both the human AND the code must obey. Getting it wrong produces confident
false culprits and cost code that lies. The load-bearing rule is #1.

**1. Windows are metered by COST (USD-equivalent), NOT by raw token count.** The 5h and 7d
rate-limit windows fill by what the requests *cost*, so a token count alone tells you nothing
until each token is weighted by its rate. Any burn/attribution number that sums raw tokens is
wrong; it must weight every bucket. `investigate_burn` does this correctly —
`src/burnInvestigator.ts` `equivOf = cc*1.25 + cr*0.1` (input-equivalents); the full per-model
$ view is the `billable_weighted` bucket (`cacheCreationForensics.ts` / `mcpServer.ts`).

**2. Per-token cost weights (Claude; per-model in `src/shared/pricing.ts`).** Relative to
1× input: **cache READ ≈ 0.1×**, **output ≈ 5×**, and the **cache WRITE is TIERED BY TTL —
5-minute = 1.25×, 1-hour = 2×** (opus-5 / opus-4-8: input 5.00, cacheRead 0.50, cacheWrite-5m 6.25,
**cacheWrite-1h 10.00**, output 25.00 per MTok). The tier is not cosmetic: Claude Code puts every
main-conversation turn on a subscription into the **1h** tier automatically, so most writes on this
machine bill at 2× and the old flat 1.25× under-reported them by 60%. Verified against Claude Code's
own `cost_usd`, three ways — median implied rate exactly $10.00/MTok with p10 exactly $6.25 over
~700 opus calls; 26/26 agreement with the raw body's `usage.cache_creation.ephemeral_{5m,1h}` tier;
and one call reconciled to the cent. `calcTokenCostUsd` takes the 1h portion as a trailing argument
(default 0 = today's all-5m behavior); `cacheWrite1hRate` derives 2× only for entries with the
Anthropic 1.25× shape, so a provider that prices writes differently is never handed a rate it does
not charge. **Prefer a harness-reported `cost_usd` (OTEL `claude_code.api_request`) over recomputing
— Claude Code's own table is tier-aware.** A few models differ (codex-mini reads at 0.25×) — code
that must be exact reads the rate from `pricing.ts`, never a hardcoded flat factor.

**3. Cache TTL depends on WHERE the turn runs — memorize this:**
- **MAIN conversation → 1h TTL** automatically (subscription). **Drops to 5m when the account
  is drawing usage credits / in overage.**
- **Fresh sub-agents → ALWAYS 5m TTL.**
- **Cron / heartbeat fires are MAIN-conversation turns** → they get the 1h TTL, but each one
  still re-reads the whole prefix (cheap if warm, a cold WRITE if the TTL lapsed since the last turn).
- A turn arriving *after* its TTL has elapsed hits a COLD cache → the entire prefix is re-billed
  at the **write** rate (1.25×), not the read rate. Keeping turns closer together than the TTL is
  what keeps them at 0.1×.

**4. What RESETS the cache prefix → forces a full cold WRITE (1.25× the whole prefix) on the
next turn.** Avoid mid-session unless necessary:
`/reload-plugins` and `/reload-skills` (re-register the tool/skill/agent catalogs in the stable
prefix), `/login` (new auth ⇒ new prefix), a `/model` / reasoning-effort / fast-mode switch, an
MCP server connect/disconnect, a bare-tool **deny**, `/compact`, and a Claude Code upgrade.
`/clear` resets the transcript floor (a deliberate, GOOD reset — cheap thereafter). A small
per-turn `cache_creation` is just normal suffix writing; only a **full-prefix-sized** spike is a
true cold rewrite.

**5. Fork agents PRESERVE the cache; fresh subagents DON'T.** A **fork** inherits the parent's
context and reads+renews the PARENT's cache entry → warm 0.1× reads. A **fresh subagent** starts
a NEW prefix → a cold WRITE (1.25×) up front, plus a 5m TTL. So when a fan-out needs the parent's
context, **fork** it; spawning N fresh subagents off a fat parent pays the whole fat prefix as a
cold write N times — this is the **FORK_STORM** burn pattern (the dominant real-world window-eater).

**6. Request SIZE ≠ billed COST — the exact trap to never repeat.** The request body always
carries the full transcript, so a "fat" request (megabytes on the wire) is **cheap** if it's a
warm cache READ (0.1×) and **expensive** only on a cold WRITE. A byte-size signal (e.g. the
`HUGE_REQUEST_BURST` risk) flags a fat request *in flight*; it is NOT a cost verdict. Rank
culprits by cache-**weighted** equiv (`investigate_burn`), never by request bytes or raw tokens.

**7. Consequences that follow from the above:**
- The window-eater is **cold full-prefix WRITES**, above all FORK_STORMs; warm re-reads barely
  move the meter even when huge.
- **Rotating accounts does NOT reduce burn** — it only changes which account pays for the same
  cold writes. The fix is always to stop the *source* (kill the fan-out, `/compact` the fat parent).
- An un-evicted image/blob re-sent every turn is the worst resident-context cost (one 8-image
  paste ≈ 525k tokens/turn, ~$425) — analyze images in a subagent or `/compact` immediately.
- To answer "what's burning NOW", read the **live** window (`--risk`, 5-min `get_burn_status`)
  weighted by cost; to answer "what burned the window", read `investigate_burn` (already weighted).
  Do not answer a "now" question from a 5h aggregate, or a cost question from a byte signal.
- For "**how full is the window really**", read `get_subscription_usage` — Anthropic's own 5h/7d
  percentages (what `/usage` shows). Everything else here INFERS the cap from observed rate-limit
  hits. Its `usageCreditsEnabled` is also the live TTL-regime oracle (credits off = 1h TTL = 2× writes).
- For "**did that turn miss the cache**", read `get_cache_event_log` — one row per call, sourced from
  the OTEL span store (whose `api_request` events carry `session.id` directly, so a compaction's own
  summarization call is attributed instead of being invisible) with the API's own `cache_miss_reason`.

Diagnostics encode this as the TTL-regime matrix (TRDD-VY1IUVUM); the full model with measured
costs: `.claude/project/memory/cache-ttl-model.md`.
