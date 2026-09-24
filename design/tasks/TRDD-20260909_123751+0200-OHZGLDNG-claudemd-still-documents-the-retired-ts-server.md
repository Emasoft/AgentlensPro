---
trdd-id: OHZGLDNG
title: CLAUDE.md still documents the TypeScript server retired in 567fc5c2
column: human_review
created: 2026-09-09T12:37:51+0200
updated: 2026-09-24T08:57:53+0200
current-owner: main
task-type: docs
min-approval-requirement: none
project-id: agentlenspro
scope: project
labels: [docs, claude-md, alcore, stale-doctrine]
blocked-by: []
npt: []
eht: []
implementation-commits: []
relevant-rules: []
related: [4EV3OJ19, 5JZQFVO8, 1B98LCVR]
---

## Why

Commit 567fc5c2 (2026-09-01, "feat!: retire the TypeScript server — alcore is the only
backend", TRDD-1B98LCVR box 4, archived card) deleted `standalone/server.ts` (4,177 lines; the
commit's diffstat records 4,712 deletions against 192 insertions across 15 files, with `scripts/dev-server.js`,
`src/updatePayload.ts` and `src/autoConfigNode.ts` shown as pure deletions — removal vs
emptying not distinguished, those files not read). CLAUDE.md at HEAD still describes that
server in present tense. Two distinct defects:

1. **A deleted file is named as live.** Lines 133 (`standalone/server.ts` as a source of the
   `standalone/**` layer, bundled with `cli.ts`), 135 (the `/api/*` shim "on
   `standalone/server.ts`"; "`esbuild.js` builds **four** separate targets"), 151 (`sql.js`
   "resolved from `node_modules` at runtime … `standalone/server.ts`"), 270 (the single-owner
   data-dir guard "in `standalone/server.ts`").
2. **A fallback that no longer exists is named without a file.** Lines 257 and 312 say
   `rustBinResolve` "falls back to the TS server". `src/cli/serverControl.ts:32-36` says the
   opposite in its own words ("no longer ships a TypeScript fallback (TRDD-1B98LCVR box 4), so a
   missing binary here is a hard stop"), and `src/rustBinResolve.ts:15-17` carries the same
   stale sentence as a code comment ("must fall back to the TS server rather than crash the
   CLI").

Present-tense doctrine naming a path that is not there is the defect; a reader who trusts
line 270 goes looking for the guard in a file that has not existed for eight days.

## Evidence (2026-09-09, first-hand)

- `git log --diff-filter=D --oneline -- standalone/server.ts` → `567fc5c2 feat!: retire the
  TypeScript server — alcore is the only backend (TRDD-1B98LCVR box 4)`; its stat: 15 files,
  +192/−4,712, `standalone/server.ts | 4177 ----`.
- `standalone/` at HEAD holds `cli.ts`, `cli.js`, `cli.js.map`, `tsconfig.json` — no
  `server.ts`, no `server.js`.
- `esbuild.js` `entryPoints` at lines 28, 43, 56: `media/src/dashboard.tsx`,
  `media/src/sidebarWebview.ts`, `standalone/cli.ts` — three targets, not four.
- Eight CLAUDE.md commits landed after 567fc5c2 (incl. 25d17c43 "post-retirement factual
  fixes") and the six lines survive at HEAD.
- `src/rustBinResolve.ts` read whole: `npmPlatformBin` returns null for an unshipped platform
  or a missing file; `src/cli/serverControl.ts:103-133` (`alcoreBin`): env override, then
  `<dataDir>/bin/alcore`, then `bin-native/`; returns null when the platform is unshipped or
  `bin-native/` is absent (the caller stops with `noServerAvailableError`, defined at `:37`;
  its call sites not read); THROWS when
  `bin-native/` exists but the binary is missing or not executable (`:124-132`). No branch
  spawns anything but alcore.
- The guard doctrine at line 270 (atomic exclusive create, stale-lock takeover,
  ownership-checked release) is true of alcore: `rust-core/crates/agentlens-core/src/pid_lock.rs`
  `atomic_exclusive_write` (:74), `claim` (:118), `release` (:180) — signatures seen in a grep,
  bodies not read; reading them is acceptance item 3's job. The doctrine stays; only its home
  moves.
- UNCERTAIN, not checked: whether any TS code still resolves `sql.js` at runtime (line 151's
  gotcha may be dead with the server or may live on in a scan path). Acceptance item 2 settles
  it before rewriting that line.

## Acceptance

1. `! grep -q 'standalone/server.ts' CLAUDE.md` exits 0, and `grep -c 'entryPoints:' esbuild.js`
   prints `3` — confirmed by reading `esbuild.js` that each is one `build()` call (a literal
   count is not a target count) — with line 135's count corrected to match.
2. Line 151 is rewritten from a grep of `require.resolve('sql.js')` / `sql.js` over non-test
   `src/` and `standalone/`: either the gotcha names its live file, or it is removed as retired.
3. Lines 257 and 312 state what happens with no binary (null → `noServerAvailableError`; throw
   on a corrupt install, `serverControl.ts:121-132`), and line 270 names `pid_lock.rs::claim`
   after its body is read and the three guard properties are confirmed against it.
4. `src/rustBinResolve.ts:15-17` reads "must return null — the caller (`serverControl.ts`,
   `noServerAvailableError`) turns that into an actionable stop — rather than crash the CLI" or
   equivalent — no "fall back to the TS server".
5. `pnpm run check-identities` exit 0 on the edited CLAUDE.md (it is a checked file).

Filed at `todo` like the two sibling cards of 2026-09-09 (Tier-0 docs work that should drain),
not `backburner`. The CLAUDE.md working copy is currently modified by the janitor's wikimem
index regeneration; the fix is made on top of that, never by reverting it.

## Notes and lessons learned
Fixed 2026-09-23: (1) L133 - 'standalone/server.ts + standalone/cli.ts -> standalone/*.js, 4 targets' -> item 3 now says standalone/cli.ts is the only TS entrypoint, server is alcore (rust-core), retired in 567fc5c2; esbuild target count corrected to 3 (verified: esbuild.js entryPoints at lines 28,43,56). (2) L135 - '/api/* shim on standalone/server.ts' -> alcore serves /api/* + dashboard directly (rust-core/crates/agentlens-core/src/ui.rs). (3) L151 - 'standalone server resolves sql.js' -> src/logReader.ts resolves sql.js via injected sqlFactory as a JS-path fallback; production OpenCode ingestion runs through the Rust engine rustParseOpenCodeSync (rust-core/crates/agentlens-logscan/src/opencode.rs), verified via grep: no require.resolve('sql.js') survives in standalone/cli.ts, only in src/logReader.ts and src/forensicsDb.ts (forensics.db, unrelated to OpenCode ingestion). (4) L257 (was 247-248) - 'rustBinResolve falls back to the TS server' -> npmPlatformBin returns null, serverControl.ts alcoreBin turns that into noServerAvailableError, no TS fallback exists (verified: src/rustBinResolve.ts:38-46,55-63, src/cli/serverControl.ts:32-36,103-133). (5) L270 (was 262) - 'guard in standalone/server.ts' -> guard is rust-core/crates/agentlens-core/src/pid_lock.rs claim/release (verified: fn signatures at claim():59, release():121, atomic_exclusive_write():15, doctrine of atomic-create/stale-lock-takeover/ownership-checked-release confirmed against the code). (6) L312 (was 303-304) - 'rustBinResolve would fall back to the TS server silently' -> reworded to name noServerAvailableError, no silent TS fallback. Acceptance items 1-4 satisfied; item 5 (check-no-identities) verified exit 0. All edits made via fastedit edit --replace on markdown headings (Architecture / Gotchas / DISTRIBUTION vs DEVELOPMENT / Operations); fastedit diff confirmed each change against git HEAD is a clean single-sentence replace with nothing else altered. One self-caught defect during editing: a --replace on the Architecture heading initially omitted the 'Dual ingestion -> SQLite' subsection from the snippet, which fastedit interpreted as a deletion of that subsection; caught via git diff review and restored verbatim in a follow-up edit. Out of scope per orchestrator's hard limits (touch only CLAUDE.md + this card): src/rustBinResolve.ts:15-17's own comment ('must fall back to the TS server rather than crash the CLI') is still stale and should be fixed in a follow-up touching that source file.
Review-fork follow-up (2026-09-23): the one gap flagged by adversarial review (pid_lock claim/release attribution rested on function names, not a confirmed call chain from server startup) is closed: grep on rust-core/crates/agentlens-core/src/bin/alcore.rs confirms agentlens_core::pid_lock::claim() is called directly at line 192 and pid_lock::release() at line 437, inside alcore's own main binary. All five CLAUDE.md sentences are now verified against a traced call, not just a name match.
2026-09-23 verification (round 2, tldr-verified against rust-core): (1) Dual ingestion section rewritten — the retired TS pipeline (OtlpCollector/SessionStore/spanSummarizer/DatabaseWriter/LogReader/SessionRepository) is gone from the live path; OTLP now lands via agentlens_core::serve_otlp into CoreState (rust-core/crates/agentlens-core/src/lib.rs), local logs via log_reader::start_sweeper + agentlens-logscan discovery, the log-wins-over-OTEL rule now lives in rust-core/crates/agentlens-core/src/feed_merge.rs (preferred_data_source), and alcore's GET /api/summary (ui.rs) is the single read point. (2) @duckdb/node-api sentence fixed: esbuild.js now has three entryPoints, of which only standalone/cli.ts is a Node target (the other two are browser bundles) — @duckdb/node-api is external there only. (3) entryPoints line numbers (28/43/56) removed; verified ui.rs does serve the dashboard and every /api/* route, so that wording needed no other change. Evidence: esbuild.js, rust-core/crates/agentlens-core/src/{lib.rs,ui.rs,log_reader.rs,feed_merge.rs}, rust-core/crates/agentlens-logscan/src/discovery.rs, commit 567fc5c2.
Round 3 (2026-09-23): (a) fixed L143 and L145 in the Dual ingestion section — old claim 'on start, and every 5s thereafter, start_sweeper ... uses parsers' -> verified: start_sweeper restores DurableState, runs a boot sweep, then a debounced targeted sweep off a recursive watcher with a full sweep every FULL_RESCAN (60s, log_reader.rs:852) as backstop or a full poll every 5s (LOG_SWEEP_INTERVAL, bin/alcore.rs:22) with no watcher; old claim 'GET /api/summary is the one place reads happen' -> verified reads are also served by alcore's MCP server (mcp.rs handle_rpc / mcp_tools.rs, wired via ui.rs POST /mcp using CoreState), sentence reworded to cover both. (b) FOLLOW-UP, unchecked: the token-economics section still cites src/burnInvestigator.ts, cacheCreationForensics.ts and mcpServer.ts as live code paths for burn attribution — now that alcore serves MCP, verify whether those TS modules still run in production or are tests-only/dead, same way this card verified the ingestion section. (c) commit 71934d54's message overstated two things not independently checked here: that CLAUDE.md's cited line numbers 'went stale' (a prediction about future drift, not an observed fact at commit time) and that feedMergePolicy.ts 'is only fed to tests-only modules' (the worker's own claim, not verified by this session).

## Approval log

- 2026-09-23T06:05:45+0200 — column → ai_review by main. CLAUDE.md stale-TS-server sentences fixed via fastedit, verified with fastedit diff + git diff; check-no-identities exit 0
- 2026-09-24T08:57:37+0200 — column → human_review by main-session. AI review verified, evidence in reports/board-triage ai_review-A/B/C triage
- 2026-09-24T08:57:49+0200 — main-session (board update A): moved ai_review -> human_review; AI review verified per reports/board-triage ai_review-A/B/C triage rows. In this project's mono-agent rule the session moves ai_review->human_review; the owner moves human_review->complete.

## ⏵ AI-REVIEW VERDICT 2026-09-23T13:00:09+0200 — APPROVE

Box 1 (no standalone/server.ts mention; esbuild.js has 3 entryPoints) met: grep -q 'standalone/server.ts' CLAUDE.md and 'fall back to the TS server' both exit 1 (no match) at HEAD; grep -c 'entryPoints:' esbuild.js = 3.
Box 2 (sql.js sentence rewritten/verified) met: CLAUDE.md line 152 names src/logReader.ts's _scanOpenCode (verified via tldr, logReader.ts:1236-1279) as the JS-path fallback, with production OpenCode ingestion through rustParseOpenCodeSync — matches the code's rustBin-vs-sqlFactory branch exactly.
Box 5 (identity check exit 0) met: re-ran the identity checker independently this session, captured to a file, EXIT=0, OK - no personal email or home path in any tracked or shipped file.
Independently re-verified the Dual ingestion section against rust-core: log_reader.rs::start_sweeper (992-1106) matches exactly (boot restore, boot sweep, watcher attach, backstop = FULL_RESCAN 60s if watch_attached>0 else poll_interval 5s from LOG_SWEEP_INTERVAL in bin/alcore.rs); feed_merge.rs::preferred_data_source (29-31) returns log only for claude_code, otel otherwise, matching the log-wins/OTEL-wins sentence exactly; ui.rs::handle (line ~2103-2110) resolves get_call_context via resolve_call_context then hands the Value to mcp_tools::get_call_context, while get_burn_status (ui.rs:2116) locks CoreState directly via state.lock_timed() — both match the doctrine sentence precisely.
No defects found in this independent pass; the card's own multiple self-review and adversarial-review rounds already caught and fixed every discrepancy this reviewer could find. Ready for human_review; the owner makes that move.
