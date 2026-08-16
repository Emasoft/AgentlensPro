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
                                                 # + the image cache-guard on Read (WARN-only;
                                                 # AGENTLENS_CACHE_GUARD=off / --hooks cacheguard=off)
agentlenspro --install-skill                     # (re)install this skill into ~/.claude/skills/
agentlenspro statusline-history project          # what is running in THIS project: model, effort,
                                                 # ctx fill, cost, 5h/7d window. Self-scopes to the
                                                 # cwd; `--project [DIR]` works on every view
agentlenspro last-compact [--seconds]            # how long ago THIS project compacted (manual OR
                                                 # auto), from the PreCompact hook — off disk, works
                                                 # with the server down. No record = exit 2, stdout
                                                 # EMPTY (never "0", the opposite claim)
agentlenspro cache-expired [-q]                  # has THIS project's main conversation outlived its
                                                 # cache TTL? one word, `true`/`false` (-q: exit
                                                 # 0=expired 1=fresh 2=cannot answer). Never prints
                                                 # `false` for a question it could not resolve
```

Both `--install-*` settings flags go through `safeConfigEdit`; they never clobber other tools'
hooks, and a hook change needs a session restart to take effect.

Before any task: `get_recent_sessions` (recent work + cost) and `get_workspace_patterns`
(hot files, recurring issues) — batch them in one invocation. Do not re-register the MCP
server without asking the user.

### "What is IN the context" is answered ONLY by `agentlenspro ctxmap`, and its numbers are EXACT

The session JSONL records neither the system prompt, nor tool schemas, nor the injected context
block — so grepping a transcript to ask "does a subagent get CLAUDE.md?" measures nothing and
answers confidently wrong (it did, twice, in both directions). The captured raw body is the ground
truth, and `ctxmap` decomposes it with **measured** counts, not estimates: every element's cost is a
difference between two `count_tokens` calls, and the residual (`exact total − Σ elements`) is printed
so completeness is checked rather than claimed (0 on both verified requests). `--estimate` opts out
into the local estimator, which reads **~29% low** on this content (161,685 vs 226,910 measured;
2.56 chars/token) — never quote an estimated ctxmap number as a token count.
Do NOT try to pair a request to its response to get a total: nothing on disk links them (uuid vs
`req_<id>`), `previous_message_id` needs a successor call that 0 of 3 sampled requests had, and one
`session_id` carries concurrent interleaved streams. `count_tokens` makes pairing unnecessary; the
response's `usage` is still the only source for how the input was *billed* (the 5m/1h split).
Measured surprises worth knowing: a lean 4-tool subagent's context is 96.8% one injected user block,
of which CLAUDE.md is 64,868 tokens (28.6%), while the whole tool surface is 2.2%; and the `Agent`
tool's `agent-listing` catalog costs **65,177 tokens** in a full session.
Evidence: `reports/ctxmap/20260730_145401+0200-exact-token-decomposition.md`.

### "What does this agent cost to KEEP running" is answered ONLY by `agentlenspro ctxvis`

`ctxmap` compares agents at STARTUP. The number that decides the bill is whether a turn's prefix
survives byte-exact into the next turn: a prefix that holds is re-read at 0.1×, a prefix that broke
pays the write rate on everything from the break onward — so a lean agent that breaks its prefix
every turn costs more than a fat agent that never does. `/agentlenspro-visualize-context <agent>`
spawns the agent for real and measures turns 1 and 2; the subject is ALWAYS spawned (a new agent has
nothing on disk to read) while Explore/Plan/general-purpose are cached baselines revalidated against
the subject's own fresh capture.

Two rules that are load-bearing and were each learned the expensive way. **Selection needs a nonce
AND a position test**: a subagent shares its parent's `session_id`, and the parent's own requests
carry the nonce too (it emitted the `Agent` tool_use and receives the tool_result) and are larger and
more numerous — so "the body contains the nonce" selects exactly the wrong captures with full
confidence. A subagent's injected prompt is `messages[0]`; the parent's copy never is. **What
survives a change is the last `cache_control` breakpoint STRICTLY BEFORE it, not the change's own
position** — a byte-identical prefix sitting before the first breakpoint is still re-written in full.
Measured: Claude Code appends `cc_prev_req=` to `system[0]` on a subagent's turn 2, the breakpoints
sit at `system[1]`/`system[2]`, and all 89 identical tool schemas were re-written (`cache_read 0`,
84,158 written, $0.53). Predicting from the divergence point alone claimed 67,964 would survive; only
the cross-check against billed `usage` revealed it, which is why the verdict always prints both and
reports a disagreement rather than the flattering number. **That finding is ONE verified pair — its
preconditions look general across a 120-request sample, but "every subagent turn goes cold" is NOT
established** (the aggregate needed request↔response pairing, which is measured-dead here; the
nearest-after heuristic mispaired subagent requests with main-conversation responses and reported an
impossible 189,753-token median `cache_read` against ~85k requests).
Evidence: `reports/ctxvis/20260730_173855+0200-prefix-break-and-turn2-cost.md`.

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

`esbuild.js` builds **four** separate targets for these. The server↔dashboard boundary is a **message-shaped protocol** (`media/src/App.tsx` message handler, fed in standalone by an inline shim that proxies `/api/*` endpoints on `standalone/server.ts`); the two sides share shapes by importing **`src/shared/`** — the runtime-neutral directory (no Node imports, no DOM APIs) that holds the card/timeline/telemetry types and the pure engines. `media/src/types.ts` declares ONLY webview-specific message/UI types and re-exports the shared ones; it must never re-declare them (see the shared-module gotcha below). Evidence: `scripts/check-no-mirrors.js`, the executable guard for exactly this invariant.

### Dual ingestion → SQLite (`SessionRepository` is the single read point)

Two independent sources converge on `DatabaseWriter`:

- **OTLP/HTTP (network):** agents POST to `OtlpCollector` (port 4318) → `SessionStore` (5-minute rolling span window) → `spanSummarizer` → write.
- **Local logs (disk):** `LogReader` parses JSONL from `~/.claude`, `~/.codex`, `~/.copilot`, and OpenCode's SQLite db → write.

When both capture the same session: **for Claude sessions the log transcript wins on collision (OTEL is a lossy lower bound — span-store eviction + collector downtime); OTEL wins only where no transcript exists. Every other source keeps OTEL-wins.** The rule lives in ONE place — `src/feedMergePolicy.ts` — consumed by the standalone merge, the repository merge/dedup, and the DB write guard; never re-encode the preference inline. `SessionRepository` is the one place reads happen — it merges the persisted SQLite DB with the live in-memory span window. Per-agent parsing is isolated in `src/summarizers/{claude,codex,copilot}.ts`; storage in `src/database/` (`schema.ts`, `writer.ts`, `reader.ts`, `migration.ts`, `retention.ts`).

## Gotchas

- **NEVER write a user config file with `fs.writeFile`/`JSON.parse`-fallback.** Every mutation of `~/.claude/settings.json`, `~/.codex/config.toml`, or VS Code `settings.json` MUST go through `safeConfigEdit` (`src/safeConfigEdit.ts` → `scripts/safe_config_edit.py`): a verified transaction (refuse-unparseable, verify-diff, atomic backup+rename, cross-process lock, bounded retries). A direct writer with a "start fresh on parse failure" path wiped a user's entire 57.8KB settings.json on 2026-07-07 (commit 1a661a9 removed it — do not reintroduce the pattern).

- **One source of truth in `src/shared/` — never mirror it into `media/src/`.** The runtime-neutral modules (`pricing.ts`, `summarizerTypes.ts`, `telemetryTypes.ts`, `cacheBreak.ts`, `keepWarm.ts`, `tokenBuckets.ts`, `fallbackCounters.ts`, `residentCost.ts`, `spawnRollup.ts`, `tokensByCause.ts`) are imported by BOTH the host and the webview; they must stay free of Node imports and DOM APIs. The old hand-synced copies drifted (the webview's cacheBreak had lost FAST_MODE detection; the two pricing tables had diverged into different interfaces), so `scripts/check-no-mirrors.js` (`pnpm run check-mirrors`, run by `compile` and `package`) FAILS the build if any file under `media/src/` re-declares a symbol `src/shared/` exports — import or re-export instead. Rates change in ONE place: `src/shared/pricing.ts` (bump `PRICING_LAST_UPDATED`; `PRICING_SOURCES.md` has the authoritative per-provider rate URLs). Evidence: the guard itself, `scripts/check-no-mirrors.js` (currently `OK — 120 shared exports, no mirrors under media/src`) — it had been wired into NO build path until 2026-08-16, so for its whole life this sentence described a guard that never ran; an executable check is the only evidence that cannot go stale, which is why this no longer cites a report.
- **`sql.js` is not bundled.** The standalone server resolves it from `node_modules` at runtime (`require.resolve('sql.js')` + `locateFile` for its WASM, `standalone/server.ts`) to read OpenCode's SQLite database; when it is unavailable, OpenCode ingestion falls back to the per-message JSON files.
- **`@duckdb/node-api` is not bundled either — and a FAILED esbuild leaves the STALE bundle in place.** Native `.node` addons cannot be bundled, so the package is `external` in both node targets of `esbuild.js` and resolves from `node_modules` at runtime (it is a declared runtime dependency). The trap (commit 36c87c8): when esbuild fails it does NOT touch the outfile, so `standalone/*.js` keeps its old mtime and *looks* current — the store code sat un-shipped for a day this way while tsc+mocha gates (which run from `out/`, never esbuild) stayed green. **A change is deployed only after `node esbuild.js` succeeds AND `agentlenspro server restart` — verify with a grep for a new symbol in the bundle when in doubt.**
- **Unit tests mock the `vscode` module** via `src/test/setup.js` → `src/test/__mocks__/vscode.js` (so mocha runs without VS Code). Tests needing the real VS Code API belong in `pnpm test` (vscode-test) instead.
- **`.githooks/{post-merge,post-rewrite}`** rebuild bundles after pull/rebase to keep `standalone/*.js` in sync with source, but they are **not auto-enabled** — opt in with `git config core.hooksPath .githooks`.
- **Fixture JSON is gitignored** (`demo/fixtures/*.json`, `export_*.json`). Run `node scripts/redact-spans.js` before committing any fixture — they contain real telemetry/PII.
- **`.claude/settings.json` is PROJECT scope and tracked** (only `settings.local.json` is ignored). It registers one `PreToolUse(Bash)` deny: `scripts/deny-playwright-init-agents.js`, which refuses playwright's agent-generator subcommand because it writes `.claude/agents/`, `.github/agents/`, a `copilot-setup-steps.yml` workflow, and `.mcp.json` — files an agent then loads as instructions. Installing playwright writes nothing (`scripts: {}`); the command is the only trigger, so the invocation is the only thing worth guarding. Matching is token-based (a substring version blocked `git add` of the guard's own filename); `node scripts/test-deny-playwright-init-agents.js` is the 15-case matrix.

## No identities in anything tracked, shipped, OR POSTED — enforced, not remembered

Two enforcement points, because the first one has no reach over the second surface.

**Files** — `pnpm run check-identities` (`scripts/check-no-identities.js`, run by `compile`,
`package`, CI, and the publish workflow) fails the build on a personal email address or a home path
with a real username in any tracked or shipped file.

**Outbound posts** — `scripts/deny-identity-leak-to-github.js`, a PreToolUse(Bash) hook, denies a
`gh` command that PUBLISHES prose (issue/pr/release/gist/discussion create|comment|edit|review) when
the text carries an identity; it reads `--body-file`/`-F` from disk, because that is the shape the
real incident took. `pnpm run check-guards` runs its 30-case matrix from `compile`/`package`.

**Never write an `@name` outside a code span** — the owner's iron rule, `~/.claude/rules/github-mentions.md`.
In rendered prose it PAGES that account, and the handles agents reach for are already taken: two
role-name handles paged real strangers across 9 issues. Two consequences that are not obvious and
both cost real pages — **a raw address pages its DOMAIN** (GitHub reads it as a username, so
`x@example.com` pages `@example` and the noreply identity pages `@users`), and **`@lru_cache` pages
`@lru`** (a username cannot contain `_`, so the valid prefix is linkified). Backticks are the
universal fix; nothing is exempt, not even the sanctioned self-id line. The guard therefore measures
everything on code-STRIPPED prose, so the correct way to write any of it still passes — a guard that
reddens on correct writing gets deleted. Note `~/.claude/rules/prrd-design-rules.md` still recommends
a self-id line with a bare `@owner`; use the backticked form.
Evidence: on 2026-08-02 agents pasted account tables into **three PUBLIC issue comments**
(AgentlensPro#8, ai-maestro#95, ai-maestro#102), publishing three real addresses; the file check
neither did nor could fire, because it scans FILES and a comment is not one. All three were redacted
and the guard was verified to deny the actual leaked body. A fourth hit — a synthetic placeholder
address in a redaction-feature table in ghe-marketplace#1 — was left alone: verifying each hit before
editing is what keeps a sweep from mangling someone's documentation over a placeholder. (Writing
that placeholder out here would itself trip `check-identities`, which is the doctrine working.) **Skills carry a stricter bar: they must be UNIVERSAL** — installed on
other people's machines, so a real session id or account uuid there is one machine's noise shipped to
everyone. Ids in a skill must be visibly fake (≤2 distinct characters: `aaaaaaaa`, `bbbb2222`).

The check is **shape-based, never a list of the values that leaked** — a guard keyed on today's
account goes blind the moment a different one is used, which is how the second incident gets through
while the check still reports green. Allowlists live in the script, each entry with its reason.

When the concrete value genuinely matters ("on THIS machine the config names account X"), it belongs
in LOCAL memory (`~/.claude/projects/<slug>/memory/`), outside the repo; keep the machine-agnostic
shape in the repo. Evidence: 31 occurrences across 15 files on 2026-08-02, including three real
addresses in the published skill — `skills/` is in `files`, so the next publish would have shipped
them. Verified to fail against the pre-fix tree (31 findings); published 2.19.0/2.20.0 tarballs were
confirmed clean.

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

- **EXACTLY ONE server may own a data directory — and changing ports does NOT isolate an instance.**
  `MCP_PORT`/`UI_PORT`/`OTLP_PORT` isolate the *listeners*; both processes still append to the same
  span store, log-tail offsets and session cards. To run a second instance you MUST give it its own
  **`DATA_DIR`** (and `HOME`), which is what every test in `src/test/` already does. The guard in
  `standalone/server.ts` is keyed on the data dir and refuses a second claimant whatever its ports
  (atomic `wx`, stale-lock takeover, ownership-checked release). Evidence:
  `reports/window-capacity-investigation/20260726_195540+0200-inferred-vs-actual-capacity.md`.
- **Check WHICH agentlenspro you are about to test.** `agentlenspro` may be a real global npm install
  (`/opt/homebrew/lib/node_modules/agentlenspro`, a published version) rather than an `npm link` to
  this repo — in which case `node esbuild.js` + `agentlenspro server restart` does **not** deploy your
  change, and measuring "the live server" silently measures the published bundle. `ls -ld
  $(readlink -f $(which agentlenspro))` tells you which; verify a new symbol is in the bundle the
  *running pid* is executing (`ps -eo pid,command` snapshot, then grep the file it names).

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

**4. What RESETS the cache prefix → forces a full cold WRITE on the next turn (1.25× at the 5m
tier, **2×** at the 1h tier — see doctrine 2).** Avoid mid-session unless necessary. **Four of these
are CONDITIONAL, and the condition IS the fact**: stating them unconditionally made every plugin
reload and every MCP blip look like a guaranteed full-prefix rewrite.

- **Unconditional:** a `/model` switch — including every `opusplan` plan-mode toggle and every
  **automatic safety-classifier fallback**, which invalidates with no user action at all; a
  reasoning-**effort** change; turning **fast mode** on (costs once per conversation — turning it
  off and back on afterwards is free); `/compact`; and a Claude Code **upgrade** (worst case:
  resuming a long session after one — "the most expensive request you send"). One caveat on the
  effort/thinking row: **setting a parameter explicitly to its default is equivalent to omitting
  it** and does NOT invalidate — and no page enumerates the per-model defaults, so an
  absent→explicit transition is undecidable from a captured body. `agentlenspro` therefore names
  `EFFORT_PARAM_CHANGED` / `THINKING_CONFIG_CHANGED` / `TOOL_CHOICE_CHANGED` only between two
  DIFFERENT explicit values (two explicit values cannot both be the default) and leaves the
  ambiguous case unnamed rather than guessing.
- **CONDITIONAL — MCP connect/disconnect** invalidates *only when that server's tools load into the
  prefix*. With tool search on (the default) they are **deferred**, and a server "connecting,
  disconnecting, or changing its tool list only appends new content and doesn't disturb anything
  already cached." Involuntary churn counts: a stdio process exiting, an HTTP session expiring, an
  auto-reconnect, or a pushed dynamic tool update.
- **CONDITIONAL — `/reload-plugins`** resets *only* when a reloaded plugin supplies an MCP server
  whose tools load into the prefix. "Skills, commands, agents, hooks, LSP servers, monitors, and
  themes **never** invalidate the cache." Since v2.1.163 the command refuses such a reload unless
  forced: "When the reload would change which MCP tools are loaded and invalidate the prompt cache,
  the command warns and skips unless you pass `--force`."
- **CONDITIONAL — a tool `deny`** resets only in the **tool-name position** (a bare name, `Bash(*)`,
  or a tool-name glob). Scoped rules like `Bash(rm *)` and all allow/ask rules are cache-safe, and an
  `mcp__*` glob is free while those tools are deferred (they were never in the prefix).
- **UNDOCUMENTED — `/reload-skills` and `/login`.** Searched every cache page: neither appears in any
  invalidation list. We ship `SKILLS_RELOADED` and `ACCOUNT_SWITCHED`; treat both as **INFERRED**,
  not doc-backed.
- **Cache-SAFE, and worth knowing:** `/clear` resets the transcript floor (a deliberate, GOOD reset).
  **`/rewind` hits the EARLIER cache entry** — it truncates back to a prefix already cached and kept
  warm by every turn since, so it is warm even past the nominal TTL, which makes it the cheap way to
  abandon a detour. **`/cd` is engineered cache-safe**: "the new directory's `CLAUDE.md` is appended
  as a message instead of rebuilding the system prompt." Also free: editing files, editing CLAUDE.md
  mid-session (it does not apply until `/clear`/`/compact`/restart), changing output style or
  permission mode, invoking skills/commands, `/recap`, and spawning a subagent.
- **A worktree is a DIFFERENT working directory ⇒ a different prefix** — the system prompt embeds
  cwd, platform, shell, OS and memory paths, so two worktrees of one repo never share a cache. And
  sequential sessions share a prefix only when the startup **git-status snapshot** matches (branch +
  recent commits are in the system prompt).

**Two documented ways to get NO cache at all, neither of which raises an error.** (a) The prompt is
under the model's **minimum cacheable length** — 512 tokens for Opus 5 / Fable 5 / Mythos 5, 1,024 for
Opus 4.8 and the Sonnet 5 family, 2,048 for Opus 4.7 and Haiku 3.5, 4,096 for Opus 4.6/4.5 and Haiku
4.5. That is an **8× spread, so a threshold keyed on one model id is wrong for the rest**; below it,
both usage counters come back 0 and the call quietly pays the full input rate. (b) The request carries
**no `cache_control` marker at all** — `DISABLE_PROMPT_CACHING*`, or simply a caller that does not
cache a class of calls (measured on this machine on CC ≤2.1.220: 4 of 1,377 captured requests, all
small Haiku utility calls; CC 2.1.221 moved auto-mode permission checks onto the cached conversation
prefix, so expect this class to shrink — evidence:
`reports/cc-alignment/20260814_125212+0200-cc-2.1.217-232-gap-analysis.md`). And one way to lose a cache you *did* write: **the lookback window is 20 blocks**, so a
conversation that grows ≥20 blocks past its last write walks past its own entry and re-writes
everything with `cache_read: 0` — the discriminator against ordinary growth, which still reads.
`agentlenspro` names these `BELOW_MIN_CACHEABLE`, `CACHING_DISABLED` and `LOOKBACK_OVERFLOW`
(TRDD-B9ERTBZ9). Evidence: `reports/cache-invalidation-research/20260804_142700+0200-prompt-caching-docs.md`
§2.5 + A-13/A-14 — whose §4.1 also records that two fetches of that page returned two different
minimum lists, so re-verify a row against the live page before trusting it for a model you have not
measured.

A small per-turn `cache_creation` is just normal suffix writing; only a **full-prefix-sized** spike
is a true cold rewrite.

**Reading an IMAGE does NOT reset the prefix — MEASURED 2026-08-04, no longer merely
uncorroborated.** 8 × 1568² images read one per turn: `cache_creation` stayed flat at exactly
**3,252 tokens** (the image's own size) while `cache_read` grew by exactly **+3,252** each turn —
seven consecutive appends, zero invalidations. The API doc's "Images | messages ✘ | adding/removing
images anywhere in the prompt" row describes **mutating or removing an image already inside the
prefix**, not appending one; Anthropic's own `cache_miss_reason` enum carries no image cause and
defines `messages_changed` as an earlier entry "altered, reordered, or removed **rather than
appended to**". Per-image cost is `(W×H)/750` — 3,278 predicted vs **3,252 measured** (0.8%); there
is **no ~1,600 cap** at this size. An image is expensive as a RESIDENT block (doctrine 7 /
`src/shared/residentCost.ts`), not as a prefix break. Evidence:
`reports/image-cache-test/20260804_144500+0200-image-append-cache-measurement.md` (supersedes the
premise-check at `reports/cache-guard/20260728_201256+0200-image-cache-premise-check.md`, whose
"not corroborated" verdict was correct but which argued from the absence of an image cause in our
own enum — evidence about our instrumentation, not about API behaviour).

**5. Fork agents PRESERVE the cache; fresh subagents DON'T.** A **fork** inherits the parent's
context and reads+renews the PARENT's cache entry → warm 0.1× reads. A **fresh subagent** starts
a NEW prefix → a cold WRITE (1.25×) up front, plus a 5m TTL. So when a fan-out needs the parent's
context, **fork** it; spawning N fresh subagents off a fat parent pays the whole fat prefix as a
cold write N times — this is the **FORK_STORM** burn pattern (the dominant real-world window-eater).
Two CC-version conditions on that N× claim: **≥2.1.229 staggers WORKFLOW same-prefix siblings** so
the first pays the write and the rest read it (`CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS=0` disables)
— the N× cost survives only for parallel Agent-tool forks in one message, a disabled stagger, or an
older CC; and **≥2.1.232 makes fork spawning the default**, a fork inheriting the conversation AND
its prompt cache (2.1.224 also removed the 200-subagent-per-session cap — nothing here keys on it).
Evidence: `reports/cc-alignment/20260814_125212+0200-cc-2.1.217-232-gap-analysis.md`.

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
- An un-evicted image/blob re-sent every turn is a real resident cost, but the old figure here —
  "one 8-image paste ≈ 525k tokens/turn, ~$425" — was **wrong by ~20×** and is retracted: a 1568²
  image measures **3,252 tokens**, so eight are ~26k/turn (~$0.013/turn of opus-5 cache-read). The
  525k was the whole resident context, misattributed to the images. Still worth evicting on a long
  run (26k re-read across 100 turns is 2.6M cache-read tokens) — but analyze images in a subagent
  rather than reaching for `/compact`, which is itself a cold rewrite and usually the costlier fix.
- To answer "what's burning NOW", read the **live** window (`--risk`, 5-min `get_burn_status`)
  weighted by cost; to answer "what burned the window", read `investigate_burn` (already weighted).
  Do not answer a "now" question from a 5h aggregate, or a cost question from a byte signal.
- For "**how full is the window really**", read `get_subscription_usage` — Anthropic's own 5h/7d
  percentages (what `/usage` shows). Everything else here INFERS the cap from observed rate-limit
  hits. Its `usageCreditsEnabled` is also the live TTL-regime oracle (credits off = 1h TTL = 2× writes).
- For "**did that turn miss the cache**", read `get_cache_event_log` — one row per call, sourced from
  the OTEL span store (whose `api_request` events carry `session.id` directly, so a compaction's own
  summarization call is attributed instead of being invisible) with the API's own `cache_miss_reason`.
- To **FALSIFY a cost claim** — any alert, hook, or your own hypothesis asserting a cold write —
  `agentlenspro statusline-history cache`. It needs no OTEL and no API call: it reads the status-line
  payload's own per-turn `current_usage` split, so `write%` near 0 is a warm re-read and near 100 a
  real prefix rewrite. Cost is printed as a **5m/1h bracket** because the payload does not carry the
  TTL tier; a single figure there would be a guess. Use it before acting on any burn warning — one
  such warning claimed a ~520k cache-miss write every turn while the measured turns were 0.75% write,
  and its recommended remedy (`/compact`) is itself a cold rewrite costing ~27× a warm turn. Sibling
  view `peaks` shows the harness's cumulative-cost delta with its **sampling gap**: a delta spanning
  an idle stretch is an INTERVAL total, not one turn's cost. Validated three independent ways —
  computed 1h cost equals the harness's own `cost_usd` to 4 decimals (and the 5m column matches
  nothing), and the feed agrees with OTEL within 1–5% on every bucket over an hour.
  Evidence: `reports/statusline-cache-verification/20260801_232422+0200-cache-view-validation.md`.

Diagnostics encode this as the TTL-regime matrix (TRDD-VY1IUVUM); the full model with measured
costs: `.claude/project/memory/cache-ttl-model.md`.
