---
title: SPEC - effects handling for the alcore DuckDB-index redesign (Effects Handling Tasks)
status: draft
unit: EHT
created: 2026-10-03
inputs: design/specs/duckplan/SPEC-operation-catalog.md (OCAT), reports/DUCKPLAN/20261003_171551+0200-operation-contracts.md (R), the repo at HEAD 94125a8d
---

# Effects handling: everything the DuckDB-index redesign forces to change

Scope of the parent change: the in-RAM summary (`summary_engine.rs`), card map (`card_store.rs` + `cards.duckdb`), log-vs-OTEL merge (`feed_merge.rs`) and span window (`span_window.rs`) are replaced by one `index.duckdb` with paged SQL functions; the dashboard becomes paged; `cards.duckdb`, the `log-sessions`/`log-offsets` snapshot+delta sidecars and `forensics.db` retire. Operation-level work (126 ops, cards C01-C38, FND-00..FND-11) is owned by OCAT. This spec lists the rest: every other artifact that references a retiring piece or consumes a changing contract. Each item is an Effects Handling Task member; the parent cannot reach `complete` until every EHT card below is terminal (TRDD rule: EHT blocks parent `complete`).

Conventions. Paths are repo-relative. `file:line` was read at HEAD 94125a8d and drifts: re-grep before editing. `rc` = `rust-core/crates/agentlens-core`. Fate words: DELETE (file removed after its gate), RE-POINT (kept, now reads the new source), REWRITE (prose or contract text changes), KEEP-VERIFY (no change expected; proof that it still holds), DECIDE (needs a decision recorded in the card). INFERRED marks my judgement, not a fact read from a file. Nothing is deleted before the soak gate in section 17; RULE 0 applies to every DELETE (commit first, `safe-delete` for anything not git-restorable).

EHT cards (15): EHT-01 doctrine docs; EHT-02 skills and agents; EHT-03 `server status` and `setup` self-checks; EHT-04 CLI verbs that parse responses; EHT-05 dashboard client plumbing; EHT-06 alcore module retirement; EHT-07 Rust tests; EHT-08 TS oracles and TS tests; EHT-09 guards, build, CI, packaging; EHT-10 `forensics.db` retirement; EHT-11 on-disk migration of old sidecars; EHT-12 config knobs; EHT-13 PROJECT memory corrections; EHT-14 TRDD board supersession; EHT-15 soak and rollback gate.

## 1. EHT-01 - doctrine documents (CLAUDE.md, ARCHITECTURE.md, README.md, CHANGELOG.md)

| id | location | what changes | proof |
|---|---|---|---|
| I01 | CLAUDE.md:138 heading "Dual ingestion -> `CoreState` (in-memory card map is the single read point)" | REWRITE: single read point becomes `index.duckdb` SQL functions; `CoreState` no longer owns a card map or span window | `grep -n "in-memory card map" CLAUDE.md` returns nothing |
| I02 | CLAUDE.md:140-143 (OTLP path `ingest_post`/`ingest_parsed` "turn spans into cards"; log path "restores `DurableState`, runs a boot sweep") | REWRITE: spans and transcript lines are inserted into `otel_span` / `raw_line` (FND-02, FND-05); no `DurableState` restore, the boot path is "open index, resume at stored byte offsets" | `grep -n "DurableState" CLAUDE.md` returns only historical lines |
| I03 | CLAUDE.md:145 (feed-collision paragraph; cites `feed_merge.rs` `preferred_data_source`, `merge_otel_and_log_sessions`, `gen-feed-merge-expected.mjs`) | REWRITE: the rule (log wins for Claude, OTEL elsewhere) stays; its home becomes the FND-06 merge function; the oracle sentence changes when I112 lands | `grep -n "feed_merge.rs" CLAUDE.md` returns nothing, or only the oracle sentence while the TS twin lives |
| I04 | CLAUDE.md:127-137 (three runtime contexts; sentence "the server itself is `alcore`") and :147 Gotchas (no gotcha covers `index.duckdb`) | REWRITE + ADD: one Gotcha "index.duckdb is the only read path; a stale bundle/binary trap" modelled on the existing codesign and stale-bundle gotchas | doctrine sentence cites a report path under `reports/` (CLAUDE.md rule on doctrine evidence) |
| I05 | CLAUDE.md:231-262 (DISTRIBUTION vs DEVELOPMENT; `alcore` 52.6 -> 17.0 MB gzip, `alstore` 39.9 -> 11.8 MB, "~121.5 MB / ~384 MB per install") | REWRITE the measured sizes if the DuckDB feature set or binary set changes (I71); otherwise KEEP-VERIFY with a fresh `gzip -9` measurement | numbers match `ls -l bin-native/darwin-arm64` after the release build |
| I06 | CLAUDE.md:266-272 Operations bullet "EXACTLY ONE server may own a data directory" (names "span store, log-tail offsets and session cards") and the `pid_lock.rs` citation | REWRITE: the listed shared state is now span store + `index.duckdb`; DuckDB itself takes a file lock, so state whether `pid_lock.rs` stays the guard or becomes the second guard | two-server test `src/test/serverSingleInstance.test.ts` green and cited |
| I07 | CLAUDE.md:266-300 Operations (deploy: `codesign -s - --force`, restart) | KEEP-VERIFY; ADD the rollback recipe from section 17 (INFERRED location) | recipe re-run once on a scratch data dir |
| I08 | CLAUDE.md:520-end Wikimem index block (marker "do not modify") | none by hand; the digest regenerates after I118-I128 (memory pages) | digest changes on the janitor's next pass |
| I09 | ARCHITECTURE.md:296-298 (`src/feedMergePolicy.ts` decides collisions; provenance stamps P7, `tokensSource`) | REWRITE to the FND-06 function; keep the P7 stamp contract (D10 decides `merged`) | grep `feedMergePolicy` in ARCHITECTURE.md = historical only |
| I10 | ARCHITECTURE.md:349-365 "Standalone span store - segmented" incl. :362 "Memory is a time window ... `AGENTLENS_SUMMARY_WINDOW_HOURS` ... halves under heap pressure" and :364 retention knobs | REWRITE: no in-memory span window; the 24 h figure is the FND-06 merge predicate (I90) | no sentence claims a resident span array |
| I11 | ARCHITECTURE.md:405-422 "Body store ... Why fileless DuckDB" (":416 A persistent `.duckdb` file rewrites row-groups internally - measured 5 MB of device writes for one 881 KB turn") | REWRITE + DECIDE: the redesign introduces a persistent `index.duckdb`; the doctrine must say why that is acceptable (write-rate measurement of the index file) or this paragraph becomes false. Same tension as I118 | a measured write-rate for `index.duckdb` is quoted with its report path |
| I12 | ARCHITECTURE.md:486-497 (`log-sessions.json`/`log-offsets.json` delta-log section, `src/store/deltaLog.ts`) and :506 (`summarizeSpans()` "called on the live rolling span window") | REWRITE (delta log retires, summarizer becomes ingest transform); mark as historical | grep `log-offsets` in ARCHITECTURE.md = historical only |
| I13 | ARCHITECTURE.md:115-139, :682-690, :849-885 (SessionRepository, `rangedSessions`, DB snapshot reload) | KEEP-VERIFY: already stale from the TS-server era (OHZGLDNG covers CLAUDE.md only); do NOT widen this change, file as a proposal | none; recorded in EHT-14 |
| I14 | README.md:89 (`server status` "pid, uptime, memory, span store, disk writes"), :100-105 ("rolling span window", "in-memory span") | REWRITE to match I30-I33 output | sample `server status` pasted from a real run |
| I15 | README.md:310-317 Data retention table row `summaryWindowHours` "in-memory rolling summary window (disk keeps everything)" | REWRITE or DELETE the row per I90 decision | `agentlenspro config` output and README table agree |
| I16 | README.md:334-346 (bodies, `store/` fileless DuckDB) | KEEP-VERIFY (`alstore` store is not touched) | none |
| I17 | README.md (dashboard section: sessions list, Export tab :417-424) | REWRITE where the "all sessions" list becomes paged (D6) | screenshot or text of the paged list |
| I18 | CHANGELOG.md `## [Unreleased]` (line 7) | ADD entries: breaking contract changes D1-D10 of OCAT section 4 (usage keyed by LAST row, workflow files get parents, `journal.jsonl` skipped, timelines uncapped, paged summary), retired files, new `sessions` verb, version bump in package.json (currently 2.34.0, "same PR" rule) | `pnpm run compile` green; entry per D-row |
| I19 | CHANGELOG.md:85-96, :562, :2264, :2631 (historical mentions of `cards.duckdb`, `DurableState::restore`, `timelineTruncatedCount`, delta log, `forensics.db`) | KEEP (history); never rewrite | none |

## 2. EHT-02 - skills and agents

Search: `grep -rnE "forensics|run_diagnostics_sql|compare_configs|summaryWindow|server status|get_recent_sessions|coverage" skills agents`. `agents/` (3 files: `agentlens-tldr-worker.md`, `lean-worker.md`, `micro-worker.md`) has zero hits (read): KEEP-VERIFY.

| id | location | what changes | proof |
|---|---|---|---|
| I20 | skills/agentlenspro-diagnostics/references/tool-cheat-sheet.md:31 "Ad-hoc analytics over the fact DB" (`run_diagnostics_sql --preset`) and :30 (`compare_configs`) | REWRITE: the fact DB is now native views (C25, Q46-Q47); presets and output must be re-run, `ensure_fresh_index` write-on-read disappears (D7) | each preset example re-run against the new binary; output pasted or schema-checked |
| I21 | tool-cheat-sheet.md:33 "get_recent_sessions (ranked by LAST ACTIVITY ...)" | REWRITE: row counts change by D3/D4 (workflow subagent files get parents; `journal.jsonl`, `*.orphaned-*.jsonl` skipped); keep the quirks list (Q1 substring match, Q2-Q4 drop `workspace`) | example outputs re-run |
| I22 | tool-cheat-sheet.md:32 and SKILL.md `run_transcript_sql` (Q31; `transcripts` view replaces the `read_ndjson_auto` glob, C18) | KEEP-VERIFY: view name and columns must be identical | the shipped preset list runs unchanged |
| I23 | skills/agentlenspro-diagnostics/references/operations.md:72 knobs list `summaryWindowHours (24)` | REWRITE per I90 | list equals `agentlenspro config` output |
| I24 | skills/agentlenspro-diagnostics/references/commands-and-options.md:47-51 (truncation `_truncated`, `run_diagnostics_sql --format`) | KEEP-VERIFY | `agentlenspro help run_diagnostics_sql` flags match |
| I25 | skills/agentlenspro-diagnostics/references/worked-examples.md:71-72, :94 (`coverage.blind`, `dirsScanned`, `pricedMessages`/`attributedMessages`) | REWRITE where D8 changes `coverage` blocks (20 s budgets and 20/25/50 pools removed: Q12, Q21, Q25-Q28) | field names in examples exist in a real response |
| I26 | skills/agentlenspro-diagnostics/references/taxonomy.md:31, windows-and-ledger.md:27, budget.md:51, watch.md:22, guard-and-gate.md:104 (`gate` counters in `/api/server-stats`) | KEEP-VERIFY: Q9/Q10/Q13/Q15/Q18 and the H3 `gate` key keep their shape | skill examples re-run; H3 `gate` key present |
| I27 | skills/agentlenspro-diagnostics/SKILL.md (tool inventory description, line 22; surface list for the CLI verbs) | ADD the `sessions` verb (EHT-04, I45) and any renamed field | `agentlenspro list --desc` and the skill list agree |
| I28 | skills/agentlenspro-cache-guard/SKILL.md:104-108 (`get_cache_event_log`, `get_subscription_usage`) | KEEP-VERIFY: Q45 is pinned to a fixed tz/env in goldens (R 7.3F-G), Q53 is external | example commands exit 0 |
| I29 | skills/agentlenspro-visualize-context, agentlenspro-scan-and-fix, verification-before-completion (no alcore call found in grep) | KEEP-VERIFY | grep stays empty |

After any skill edit: `agentlenspro --install-skill` (CLAUDE.md: the in-repo skill does not update the installed copy).

## 3. EHT-03 - `server status`, `setup` self-checks, data-dir steps (src/cli)

| id | location | what changes | proof |
|---|---|---|---|
| I30 | src/cli/serverControl.ts:640-662 `ServerStats` type: `spans.{inMemory,windowMs,cap,fileLines,fileBytes,store}`, `logSessions`, `persistence.{offsetsBytes,offsetsWrites,cardsBytes,cardsWrites,files.{spans,cards,offsets}}` | RE-POINT: H3 (C28, "store/spans counters re-pointed", OCAT INFERRED) must either keep these keys with new meaning or the type changes; the `server-stats.rs` emitter (`rc/src/server_stats.rs:485-486, 510-512, 523, 527, 538`) and this type change in the same commit | `src/test/serverEndpoints.test.ts:49,267-280` and `rc/tests/server_stats.rs` green; `tsc` green |
| I31 | serverControl.ts:773-779 (`spans:  N in memory (Xm window) ... store`) and :779 (`disk writes ... cards/offsets`) | REWRITE the status lines: no "in memory" span window; report `index.duckdb` size and last checkpoint instead | real `agentlenspro server status` output pasted in the card |
| I32 | serverControl.ts:799 `data:   ... (spans X, cards Y, offsets Z)` | REWRITE: `cards`/`offsets` file sizes retire; show `index` | same |
| I33 | serverControl.ts:515, :570, :695-703 (`/api/server-stats` probe for `pid`/`dataDir`; "RUNNING but does not serve /api/server-stats (older build?)") | KEEP-VERIFY: `pid`, `dataDir`, `ports`, `bodies` keys must survive; the data-dir-first identity check (TRDD-BSDR4TRM) depends on them | `src/test/apiStatusClassify.test.ts`, `serverSingleInstance.test.ts` green |
| I34 | src/cli/setup.ts:195-209 `StatsShape` (`spans.store.totalSpans`, `spans.inMemory`, `hookEvents.receivedSinceBoot`), used at :1167, :1226, :1283, :1324, :1386, :1396 | RE-POINT to whatever H3 reports; `hookEvents.receivedSinceBoot` moves with NS-3 (FND-08, `hook_event` table) and must keep counting for the hook round-trip proof | `src/test/setupVerb.test.ts` green |
| I35 | setup.ts:795-806 `storeSpanCount` (counts NDJSON lines in `<dataDir>/spans`; data-preservation assertion post >= pre) | DECIDE (FND-05): if span segments stop being the durable record, the assertion must count the new durable store or it passes vacuously; keep the "only ENOENT may answer 0" rule | mutation check: delete a segment, step must FAIL |
| I36 | setup.ts:809-860 `stepData` (`forensics.db` quick_check, corrupt -> `.corrupt-<ts>` aside) and :29 `import { loadSqlJs } from '../forensicsDb'` | DELETE the forensics branch (EHT-10); ADD an `index.duckdb` integrity step with the same never-wipe rule (move aside, never delete) | `setupVerb.test.ts:211-216, :281-285` replaced by an `index.duckdb` corrupt-file test |
| I37 | setup.ts:1360-1385 round-trip: synthetic span visible in `get_recent_sessions {limit:50, verbosity:'full'}` within 10 s | KEEP-VERIFY: Q1 ordering (last activity) and the new ingest latency (rows visible after commit, not after a 25 ms rebuild) must still satisfy a 10 s window; OTLP spans must reach `otel_span` and Q1 | self-test passes on a cold index |
| I38 | setup.ts:1420-1486 `checkCompositionLine` / `memoryCheckFromLog` (parses `alcore: composition:` from `server.log`, regexes `mi live`, `mi free-in-page`, `mi committed`; "expected until Phase D (streaming restore) lands") and `COMPOSITION_STALE_MS` :1445 | REWRITE with the line emitter `rc/src/chores.rs:535-576, 618-715` (`composition_line` fields `window.spans`, `summary-cache`, `stripped-cache`, `card rows`, `derived slack` disappear; `mi` suffix must survive or the check goes SKIP forever). Remove the Phase-D text. A setup check that returns SKIP forever is a dead instrument | `src/test/setupSelfChecks.test.ts:8,43,57-84` updated; one real line from the new binary parses to PASS/INFO |
| I39 | `rc/src/bin/alcore.rs:247-248` startup log prints `window.spans.len()` and `configured_ms` | REWRITE: print index path, size, rows | boot log line read |
| I40 | src/cli/storeAdmin.ts:61-66 `liveStoreWriters` regex (`alcore\s+serve`, `alstore\s+(pass|unpark)`) and :142 server-up probe | KEEP-VERIFY: `index.duckdb` writer is the `alcore serve` arm already matched; the staged store rewrite must also refuse while the index is open | `storeAdmin` refusal test green |
| I41 | src/cli/cliCore.ts:62 comment "data directory (span store, logs, pidfile, forensics.db)", :217 `tools/list`, :245 `callTool` | REWRITE the comment; KEEP-VERIFY `tools/list` against `rc/assets/mcp-tools.json` | grep `forensics.db` in src/cli returns nothing |

## 4. EHT-04 - CLI verbs that parse responses

The CLI reads live schemas (`tools/list`), so a changed argument list needs no edit there; a changed OUTPUT field does.

| id | location | consumes | what changes | proof |
|---|---|---|---|---|
| I42 | src/cli/budgetCli.ts:270 | Q18 `get_window_eta` | KEEP-VERIFY (C10 golden); fields used are listed in the card | `src/test/budgetCli.test.ts`, `budgetWindowAgreement.test.ts` green |
| I43 | src/cli/attribution.ts:107 | Q13 `get_burn_status` | KEEP-VERIFY (burn weights ignore the 1h tier by design, R key finding 3) | attribution test green |
| I44 | src/cli/watchCli.ts:122-124, :321, :348 | Q9, Q18, Q13, Q31 (`run_transcript_sql` with caller SQL over `transcripts`) | KEEP-VERIFY; the `transcripts` view contract (C18) | watch feeds return the same keys |
| I45 | src/cli/main.ts:111 (verb list), new `src/cli/sessionsCli.ts` (INFERRED name) | `GET /api/cards/page` (H32a) | ADD the `agentlenspro sessions [--limit N] [--cursor C] [--json]` verb (parent TRDD 9VX3WTGU Amendment 2); must use the port-guard URL helper (`src/cli/portSelect.ts`) | new test through the bare command name; `agentlenspro sessions --help` exit 0 |
| I46 | src/cli/cacheExpiredCli.ts:252 | Q21 `check_cache_expiry` (lean mode) | KEEP-VERIFY incl. the `unknown` verdict; the 20 s budget disappears (D8) so `unknown` caused by the budget must not be asserted anywhere | `src/test/cacheExpiry.test.ts`, `cacheExpiredAuthoritative.test.ts` |
| I47 | src/cli/cacheStateCli.ts, lastCompactCli.ts, statuslineHistoryCli.ts (:380 comment), statuslineCapture.ts:46-99 | statusline store and hook files, not alcore queries (grep: no `callTool`) | KEEP-VERIFY; FND-11 keeps the statusline store outside DuckDB by default (NS-6) | statusline tests green |
| I48 | src/cli/diagnosticsCli.ts:240-244 alias table (`reload-cost`, `skill-cost`, `plugin-versions`), :263-269 (H22 burn-risk, Q17), :310, :339 (H5/H6 hook-config), :657-676 (H7 clear, H29/H30 bodies), :732-786 (generic tool dispatch, `batch`) | Q28, Q29, Q51, H22, H5, H6, H7, H29, H30 | KEEP-VERIFY; H22 has NO route test today (OCAT C09 adds one) | `agentlenspro burn-risk` exit 0 on a fresh index |
| I49 | src/cli/heartbeatCostCli.ts:68, allAccountsCli.ts + main.ts:254 (`get_account_status`), ctxmapCli.ts, ctxvisCli.ts | Q43, Q16 (`all:true` stays -32601), ctx tools are capture-based | KEEP-VERIFY | their tests green |
| I50 | src/cli/hookHandlers.ts:441, :475 and statuslineCapture.ts:68 | H10, H23, H9 | KEEP-VERIFY: write contracts unchanged; hook revive (`alcoreBin`, :364-396) must still start a binary that opens an index created by a different version | `src/test/hookScripts.test.ts` green on a temp data dir |
| I51 | standalone/cli.ts (entry) / standalone/cli.js (generated) | none in source; the bundle embeds src/cli | REBUILD: `node esbuild.js` then `agentlenspro server restart`; a failed esbuild leaves the stale bundle (CLAUDE.md Gotchas) | grep a new symbol in `standalone/cli.js` |

## 5. EHT-05 - dashboard client plumbing (media/)

Views are owned by OCAT (V0-V14, cards C01, C03, C06, C08, C12, C13, C16, C27, C28, C31, C34, C38). This card owns the cross-cutting plumbing every view shares, which breaks when `sessions[]` stops being a full list.

| id | location | what changes | proof |
|---|---|---|---|
| I52 | media/index.html:83, :91-92 (`__latestSessions__` from `update.sessionSummary.sessions`), :86 build id, :540 sidebar init | REWRITE: the shell inlines a page, not every card (S4, S5, S6; D6) | shell test with non-empty summary (OCAT C35) |
| I53 | media/index.html:370-387 (poll fallback `fetch('/api/summary')` every 2 s; `EventSource('/events')`) | RE-POINT to the paged list; polling a full list on a paged server is the exact cost the redesign removes | Safari-private-mode path exercised or documented |
| I54 | media/index.html:186-190 (H7 clear), :204 (H14), :315, :333, :350 (shim endpoints timeline/composition/history) | KEEP-VERIFY (C03, C12, C13, C31, C32) | smoke test |
| I55 | media/src/App.tsx:342, :375-392 (`msg.sessionSummary`, `checkAutomations(sessionSummary.value?.sessions ...)`), :407 (`burnStatus`), :412 (`sessionChanged`) | REWRITE the `update` handler for page+cursor semantics; F4 `sessionChanged` is never emitted (C38 decision) | smoke test; no handler for a frame nobody sends, or the producer exists |
| I56 | media/src/state.ts:134 (`sessionSummary` signal, `__INITIAL_SESSION_SUMMARY__`), :385-432 (`sessionChanged` merge), :520-531 (derived lists `agentFilteredSessions`...), :240, :280, :316, :348 (fetch helpers) | REWRITE: derived state over a page; every filter that scans "all sessions" (workspace dropdown, agent pill, range) becomes a server query or is declared page-local | grep `sessionSummary.value?.sessions` lists every remaining whole-list reader and each has a decision |
| I57 | files that read the whole list (grep `sessionSummary|\.sessions`): media/src/{App,state,utils,types,CopyBranchButton}.ts(x), tabs/{Agents,Analytics,CacheTab,ContextTab,Cost,Help,Import,Insights,SessionCharts,Sessions,Traces}.tsx | each gets a line in its owning op card (C01, C03, C16, C31, C34, C38) saying page-local or server-side | per-file checklist in EHT-05 card |
| I58 | media/src/utils.ts:418-436 (`tokensSource` chip, `coverageNote`), :482, :598 (`efficiency.toolDefWaste`); media/src/types.ts:80 | DECIDE with D10: `merged` stamp kept or dropped; `efficiency` now comes from `otel_span_attr` (H2, NS-8) | chip renders for `log`, `otel` (and `merged` if kept) |
| I59 | src/shared/summarizerTypes.ts:12, :99, :129 (comments and fields tied to `feedMergePolicy`, "Running cost of the retained entries' heavy text fields (maintained by timelineRetention)"), `timelineTruncatedCount` | REWRITE: D5 retires timeline demotion/truncation fields | `pnpm run check-types` green; `grep timelineTruncated src/shared media/src` empty |
| I60 | src/shared/ modules checked by `scripts/check-no-mirrors.js` (`pricing`, `summarizerTypes`, `telemetryTypes`, `cacheBreak`, `keepWarm`, `tokenBuckets`, `fallbackCounters`, `residentCost`, `spawnRollup`, `tokensByCause`) | DECIDE per R 7.1 decision 5: if V4/V7 stop computing client-side (server `sql_spawn_rollup`, `sql_daily_stats`), the shared module becomes a parity oracle only; if the client keeps computing from a page, it keeps importing | `pnpm run check-mirrors` prints OK with the new export count |
| I61 | media/src/sidebarWebview.ts:352 (F1 consumer), App.tsx:375-406 | KEEP-VERIFY the F1 frame keys after `sql_sidebar` (C34) | `update_payload_parity.rs` golden |
| I62 | src/test/browser/dashboardSmoke.test.ts:105-119, :280-290 (seeds transcripts, polls `/api/summary` `sessions[]`) | RE-POINT to the paged endpoint; this test is the ONLY parity for all 15 views (OCAT section 1.4) so it must grow, not just move | test green headless, screenshot in light and dark to `reports/screenshots/` |
| I63 | media/dashboard.js, media/sidebar.js (generated, shipped in `files`) | REBUILD after every media/src change; check-dist-contents | `node esbuild.js` exit 0 and symbol grep |

## 6. EHT-06 - alcore module retirement (rust-core/crates/agentlens-core/src)

Fates are INFERRED from the parent design and gated by the section 17 soak. Reference counts are `grep` hits across `src/*.rs` + `src/bin/*.rs`.

| id | file | refs | fate | what depends on it (file:line) | proof |
|---|---|---|---|---|---|
| I64 | summary_engine.rs (398 lines) | lib.rs 13, ui.rs 2; `lib.rs:159-161` (`prev`, `engine`), :365-366 | DELETE after C01 golden | `summary_now` (ui.rs:320), `summary_snapshot` (ui.rs:308, :458) | `grep -rn summary_engine rust-core/crates --include='*.rs'` empty |
| I65 | feed_merge.rs (281) | summary_engine 8, lib.rs 3, ui.rs 1 (`ui.rs:959 graft_otel_attribution`) | KEEP until FND-06 matches `feed-merge-expected.json`, then DELETE; `graft_otel_attribution` moves into C03 `sql_session_timeline` | `tests/feed_merge_parity.rs` | same grep empty |
| I66 | card_store.rs (813) | log_reader.rs 27, lib.rs 12, ui.rs 9, summary_engine 3, server_stats.rs:523, import_card.rs:85, chores.rs:642, session_summary_sql 1 | DELETE; `CARD_DB_FILE` const (:63) retires with `cards.duckdb` | restore/save in log_reader, import path H13 (`import_card.rs`), card pages (`ui.rs:2128` "cards route") | grep empty; H13 golden (C31) |
| I67 | span_window.rs (239) | lib.rs 26, chores.rs 6 (:621-628 sampling for the composition line), ui.rs 4 (spans clones at ui.rs:533, :1048, :1127 feeding `compute_sidebar_payload`), server_stats.rs:510-512, bin/alcore.rs:247-248, mcp_tools.rs 3, forensics_sql.rs 1, forensics_compare.rs 1, all_accounts.rs 1 (several are the word "window", re-read before concluding) | DELETE; consumers of `st.window.spans` re-point to `otel_span` queries | `last_received_at_ms` (parent Phase E) becomes `max(otel_span.received_at)` | `tldr references` on `SpanWindow` empty |
| I68 | derived_cache.rs (219; `VersionedCache`) | lib.rs 6 (`summary_cache`, `stripped_cache` :238-239), ui.rs 1 (:472-478), tests/pressure_ladder.rs | DELETE with the caches; the pressure ladder (`pressure_stage`, `rss_guard::pressure_fracs`) must be re-read: its stage-1/2 action is "clear derived caches" and has nothing to clear | `tests/pressure_ladder.rs` re-pointed to the new stage actions | ladder test green |
| I69 | delta_log.rs (233) | log_reader.rs 5 (:819-820 `log-sessions`, `log-offsets`), server_stats.rs:485-486 (`disk_bytes`), lib.rs 1 | DELETE; persisted offsets move into the index (FND-02 "ingest by byte offset") | boot with an old data dir (I93) | grep `DeltaLog` empty |
| I70 | session_summary_sql.rs (428; built-but-unwired, TRDD-FSMISF5K) | lib.rs 2, span_window.rs 1 | DELETE (superseded by C01 `sql_summary_sessions`); its test `tests/session_summary_sql.rs` becomes the first golden for C01 until then | field-by-field diff vs `summarize_spans` | grep empty |
| I71 | `rc/Cargo.toml` and `rust-core/crates/agentlens-store/Cargo.toml:9` (`duckdb = { version = "1.10505.0", features = ["bundled"] }`) | features today: `bundled` only | DECIDE: Rust-implemented SQL functions (pricing at `now`, merge) need `vscalar`/`vtab`; measure alcore size before/after (today 55.5 MB uncompressed in bin-native/darwin-arm64) and update I05 | `ls -l` and `gzip -9 -c` numbers in the card |
| I72 | update_payload.rs (284; `compute_sidebar_payload`, `compute_analytics_data`) | ui.rs 5, lib.rs 1 | RE-POINT (C34): becomes a shaper over SQL output or its derivations move to `sql_sidebar`/`sql_daily_stats`; keep quirks (`latestSession` = OLDEST card, `totalTokens` input-only, `costUsd` 0) | `tests/update_payload_parity.rs` |
| I73 | log_reader.rs (1694): `restore()` :940, delta-log wiring :812-820, version gate `log-delta-version.json`, `put_log_session` card map, `run_cold_log_scan`, `start_sweeper`, comments citing `cards.duckdb` (:692, :934, :1041, :1149) | RE-POINT: discovery and parse stay; persistence, restore and the 60 s `FULL_RESCAN` backstop change; the restore/ORDERING contract (:1149, TRDD-9VX3WTGU) retires with `cards.duckdb` reuse (commit 94125a8d) | `tests/log_reader_parity.rs` (1182 lines) re-pointed, see I78 |
| I74 | lib.rs: `CoreState` fields `cards` (:210), `window` (:171), `summary_cache`/`stripped_cache` (:238-239), `prev`/`engine` (:159-161), `demote_cold_timelines` (lib.rs 4, card_store.rs 5, log_reader.rs 2), boot site :622-642 (`cards.duckdb`, span window replay) | DELETE/REWRITE with I64-I70; `demote_cold_timelines` retires with D5 | `cargo build` + `cargo clippy -D warnings` (ci.yml:296) |
| I75 | server_stats.rs:485-486, :510-512, :523, :527, :538 | REWRITE with I30 | `tests/server_stats.rs` |
| I76 | chores.rs:535-576 (`composition_line`, 9 parameters), :618-715 (`composition_tick`), tests :1227-1287 | REWRITE with I38; the sampled "window est" has no meaning | `cargo test composition` |
| I77 | `rc/src/retention_config.rs:22-29` (`SUMMARY_WINDOW_HOURS` knob), span_window.rs:80-84 `summary_window_ms` | see EHT-12 | |

## 7. EHT-07 - Rust tests (rust-core/crates/agentlens-core/tests): obsolete vs re-pointed

Rule: a test whose subject module is deleted is DELETE; a test that pins an operation's output stays and is RE-POINT to the SQL implementation (it is the golden, OCAT FND-00 `tiny` suite). A deleted test leaves its fixture only if another test reads it.

| id | tests | fate | reason |
|---|---|---|---|
| I78 | log_reader_parity.rs (1182 lines; header "card map wiring: run_cold_log_scan -> put_log_session -> global timeline tier") | RE-POINT: keep the parse-and-finish half (oracle `finishRustTranscript`, fixtures/log-reader-expected.json); DELETE the card-map and timeline-tier half (D5) | split the file |
| I79 | summary_engine.rs, summary_alloc.rs, summary_shared_copies.rs (TRDD-9VX3WTGU phase C allocation and Arc-copy counters) | DELETE | subject deleted (I64); allocation-per-rebuild has no rebuild |
| I80 | span_window.rs, span_window_memory_guard.rs, received_at_stamp.rs (uses `span_window`) | DELETE the window tests; RE-POINT `received_at_stamp.rs` to `otel_span.received_at` (FND-05) | `received_at` stamping is a contract, the window is not |
| I81 | card_store.rs, card_store_file.rs, card_reuse.rs (330 lines, `cards.duckdb` meta gate from commit 94125a8d) | DELETE | subject deleted (I66) |
| I82 | card_routes.rs, card_pagination.rs (OCAT C02: "must stay green") | RE-POINT; they become the C02 golden; `card_pagination.rs` references `feed_merge` (must NOT change: `/api/cards/*` has no merge stamps) | cursor `ms:seq`, 400 messages, `nextCursor` |
| I83 | delta_log.rs + fixtures/delta-log, delta-log-expected.json, gen-delta-log-expected.mjs | DELETE | subject deleted (I69) |
| I84 | feed_merge_parity.rs + fixtures/feed-merge-expected.json | RE-POINT to the FND-06 function (it is the stated oracle), DELETE with I65 only after soak | |
| I85 | update_payload_parity.rs, summarize_parity.rs, claude_parity.rs, codex_parity.rs, copilot_parity.rs (summarizers are the OTEL-to-card transform) | RE-POINT (C01, C34); the summarizers stay as ingest transforms unless FND-05 replaces them (DECIDE) | |
| I86 | pressure_ladder.rs (imports `derived_cache::VersionedCache`, `CoreState`), rss_hard_cap.rs (hard cap exit(1), default 2048 MB, still a tripwire), mi_live_bytes.rs | pressure_ladder RE-POINT; rss_hard_cap and mi_live_bytes KEEP-VERIFY | cap stays as the safety net |
| I87 | ui.rs tests: :95, :215 (summary), :252 (shell), :390-392, :484 (import), :558, :635, :719, :845, :939, :1161, :1237, :1276, :1341-1565, :2078-2235 (OCAT lists each) | RE-POINT per op card; the ones asserting "all cards in `/api/summary`" (e.g. :2235 key order) change by D6 | `cargo test -p agentlens-core --test ui` |
| I88 | server_stats.rs, chores.rs unit tests (:1227-1287), chore_heavy_slot.rs, `rc/../agentlens-store/tests/memory_limit_scope.rs` (card 256 MB + one 1 GB heavy slot budget comment at chores.rs:321) | RE-POINT: the heavy-DuckDB slot budget arithmetic changes with the index memory_limit (TRDD-DKBGT7MQ) | tests assert the new budget |
| I89 | Goldens for the 126 operations (FND-00) and `forensics*`, `ccforensics_parity.rs` | KEEP (they ARE the acceptance); forensics ones see EHT-10 | golden diff zero |

## 8. EHT-12 - config knobs and environment variables

| id | location | what changes | proof |
|---|---|---|---|
| I90 | `rc/src/retention_config.rs:22-29`, src/retentionConfig.ts:14, :33 (`summaryWindowHours`, `AGENTLENS_SUMMARY_WINDOW_HOURS`, "in-memory rolling summary window"), src/cli/configCli.ts, src/test/retentionConfig.test.ts:69-114, README.md:317, skills operations.md:72 | DECIDE: the knob either dies (no window) or becomes the FND-06 24 h merge predicate; either way its description and every place above change together; a knob with no reader is a lie | `agentlenspro config` lists it or not, consistently across all five places |
| I91 | `AGENTLENS_TIMELINE_MAX_ENTRIES`, `_MAX_BYTES`, `_HOT_AGE_HOURS` (src/timelineRetention.ts:14-39; `rc/../agentlens-logscan/src/lib.rs:42-43` defaults 2000 / 2 MiB), CHANGELOG.md:562 | DELETE with D5 (timelines uncapped); logscan crate defaults and parity `tests/log_reader_parity.rs` cold-now case go with it | grep `TIMELINE_MAX` empty outside CHANGELOG |
| I92 | `AGENTLENS_RSS_HARD_CAP_MB` (default 2048), pressure fractions `AGENTLENS_PRESSURE_STAGE{1,2,3}_FRAC`, `AGENTLENS_DUCKDB_MEMORY_LIMIT` (src/statuslineStore.ts:296, src/store/bodiesEvidence.ts:77) | KEEP-VERIFY; add the index connection's own memory limit as a new knob only if needed | knob table lists it |

## 9. EHT-11 - on-disk migration of the old sidecars (first boot of the new binary)

Measured in the live data dir at spec time: `cards.duckdb` 575 MB (+`.wal` 1 MB, `.tmp`), `log-sessions.snapshot.ndjson` 72 MB + `.delta.ndjson` 1.4 MB, `log-offsets.snapshot.ndjson` 7 MB + `.delta.ndjson` 1.2 MB, `log-delta-version.json` 7 B. Source-of-truth transcripts (`~/.claude/projects`) and `spans/` stay.

| id | what | decision | proof |
|---|---|---|---|
| I93 | first boot with no `index.duckdb` but old sidecars present | DECIDE: build the index from transcripts + spans (a cold scan; `log-scan-performance` page: ~26k files, stat-bound) and DO NOT read the old sidecars (their offsets describe a different store) | boot on a copy of the real data dir; time and RSS recorded under the 2048 MB cap |
| I94 | what happens to the old files | The new binary neither reads, writes nor deletes them (rollback needs them intact, section 17). A later explicit step moves them to `.trashcan/` via `safe-delete` with the user's approval (RULE 0: outside git, user data) | file mtimes unchanged after a 24 h run of the new binary |
| I95 | `agentlenspro setup` and `server status` | REPORT the leftover files and their size; never remove (setup's existing never-wipe rule, setup.ts:17-19) | setup output lists them |
| I96 | `account-state.ndjson`, `hook-events/`, `collector-lifecycle.json`, `statusline/` (inputs of FND-08..FND-11) | DECIDE: new tables are additive; dual-write (old file keeps being written) until the soak passes so the old binary has current data after a rollback (INFERRED) | after rollback drill the old binary shows today's account state |
| I97 | `forensics.db` (none present at spec time; created by the TS-era indexer) | see EHT-10 | |
| I98 | Docker: Dockerfile:62 `HEALTHCHECK wget http://localhost:3000/` (hits `GET /`, H42a) and the data volume layout | KEEP-VERIFY: shell must answer while the index is still building (C35, "boot is not a failure") | container health after cold boot |

## 10. EHT-10 - `forensics.db` retirement

Live code (`rc/src/forensics_db.rs` 507, `forensics_scan.rs` 737, `forensics_index.rs` 305, `forensics_sql.rs` 679, `forensics_compare.rs` 616; TS twins src/forensicsDb.ts, forensicsIndex.ts, forensicsSql.ts, forensicsCompare.ts; refs in ui.rs 10, lib.rs 5:90-94) is owned functionally by C25 (Q46-Q47 native views). Retirement effects:

| id | location | what changes | proof |
|---|---|---|---|
| I99 | the five rc modules above + `rusqlite` dependency (`rc/Cargo.toml:38-46`, `bundled`, `functions`; sha1 digest dep at :47) | DELETE after C25 goldens; drop `rusqlite` from the dependency graph only if `agentlens-logscan` (OpenCode SQLite read, P4) does not share it: the comment at Cargo.toml:38 says versions are unified, so check before removing | `cargo tree -i rusqlite` |
| I100 | src/forensicsDb.ts, forensicsIndex.ts, forensicsSql.ts, forensicsCompare.ts and src/mcpServer.ts:90-96 imports; src/transcriptSql.ts:15, :23 imports `assertReadOnlySelect` from `./forensicsSql` | DELETE only what no `gen-*.mjs` requires (memory page ts-dead-code-vs-rust-parity-oracles: a module absent from every bundle can still be a live oracle); MOVE `assertReadOnlySelect` to its own module if `transcriptSql` stays live | `tldr impact assertReadOnlySelect src` |
| I101 | scripts/migrate-forensics-to-parquet.mjs, scripts/verify-forensics-parquet-parity.mjs, scripts/build-forensics-views.mjs (opens a store; counted by the opener cap, no ALLOW entry) | DELETE (their own headers say "dies with the source database") | check-duckdb-only exemptions drop (I104-I105) |
| I102 | src/test/forensicsIndex.test.ts, forensicsAnalytics.test.ts, forensicsIndexPricingTs.test.ts, setupVerb.test.ts:211-216 / :281-285 (corrupt forensics.db case); rc tests forensicsdb_parity, forensicsindex_parity, forensicsindexer_parity, forensicsscan_parity, forensicssql_parity, forensicscompare_parity, ccforensics_parity (KEEP: Q38-Q40 use `api_call`, not forensics.db), plus their `gen-forensics*.mjs` and `fixtures/forensics*` | DELETE the forensics.db ones once C25's goldens (all presets) pass; RE-POINT `forensicssql_parity` and `forensicscompare_parity` (OCAT C25: "must stay green") | |
| I103 | CHANGELOG.md:2631 and memory page agentlenspro-ops-lessons-deploy-and-install.md:42 mention `forensics.db` | KEEP history; lesson on the page | |

## 11. EHT-09 - guards, build, CI, packaging

| id | location | what changes | proof |
|---|---|---|---|
| I104 | scripts/check-duckdb-only.js:60-105 `ALLOW` (P2 entries for forensicsDb/Index, five rc forensics modules, six forensics tests/generators, two scripts: lines 62-66, 76-82, 88, 99, 105) | DELETE every entry whose file is deleted (the guard prints "stale entry" otherwise) | `node scripts/check-duckdb-only.js` exit 0 |
| I105 | check-duckdb-only.js:134 `MAX_EXEMPTIONS = 27`, :207 `MAX_NON_TEST_OPENERS = 22`, :210 `MAX_TEST_OPENERS = 8`, :154 `OPENERS` regex (`Connection::open|duckdb::Connection`, `DuckDBInstance.create`) | LOWER the three numbers to the measured counts after the deletions; the cap's own doctrine says "toward 1" - ONE opener of `index.duckdb` is the point of the redesign, and a second Rust file opening the index (e.g. a bench or a test helper) trips it. Run the script before and after, quote counts in the commit | script prints `store openers: N/M` with N dropped |
| I106 | scripts/check-no-mirrors.js (`src/shared` exports vs `media/src`) | KEEP-VERIFY; re-count after I59-I60 (currently "OK - 120 shared exports") | `pnpm run check-mirrors` |
| I107 | scripts/check-dist-contents.js, scripts/verify-bin-native.js (`BINARIES = ['alcore','alstore','alscan','allogscan']`), .github/workflows/publish.yml:122-139, :366-438 ("expected 16" bin-native files = 4 platforms x 4 binaries), ci.yml:93, :229 | KEEP-VERIFY: no new binary is planned (the index lives in alcore); if one is added the count 16 changes in three places (script, publish.yml assertion, README/CLAUDE size text) | publish dry-run listing |
| I108 | `package.json` `files` allowlist (lines 39-53: `bin-native/`, `skills/`, `agents/`, media bundles) | KEEP-VERIFY: no new shipped file; `package.json` `compile` script chain (:56) includes `check-duckdb-only` | `pnpm run compile` |
| I109 | .github/workflows/ci.yml:217-299 (cargo cache, `cargo clippy -D warnings`, `cargo test --workspace`) | KEEP-VERIFY; cold build time grows if the DuckDB feature set grows (comment :252-256); `NDKKOABG` (rust-core CI) is in `human_review` | CI green |
| I110 | scripts/bench/alcore-ingest-flood.mjs:519-540, :683 (reads `/api/server-stats` + `/api/debug/log-scan-stats` `derivedCaches.summary.misses`), alcore_core_utilization.py:179-249 (waits on `/api/summary`), alcore-footprint-sampler.sh | RE-POINT: `derivedCaches.summary` and the `/api/summary` readiness probe vanish; readiness must be a route that answers while the index builds | bench smoke run |
| I111 | scripts/safe_config_edit.py, deny-unscoped-measurement.js and its test (they matched `snapshot`, not the retiring pieces) | none (false positives of my grep) | |

## 12. EHT-08 - TS oracles, `gen-*.mjs`, TS tests

Memory page ts-dead-code-vs-rust-parity-oracles: 46 TS modules that look dead are `require`d by `gen-*.mjs` generators. Deleting a Rust module orphans its TS twin only when no other generator requires `out/test/<module>.js`.

| id | TS module / test | twin | fate |
|---|---|---|---|
| I112 | src/feedMergePolicy.ts, src/test/feedMergePolicy.test.ts, feedMergePolicy.graft.test.ts, gen-feed-merge-expected.mjs | I65 | DELETE with I65 (soak) |
| I113 | src/store/deltaLog.ts (24 hits), src/test/deltaLog.test.ts, deltaLogVerify.test.ts, gen-delta-log-expected.mjs | I69 | DELETE |
| I114 | src/timelineRetention.ts, src/test/timelineRetention.test.ts, imports in src/logReader.ts:40, rustLogScan.ts:21, summarizers/claude.ts:10, src/test/rustOpenCode.test.ts:11,159-165 (`timelineTruncatedCount`) | D5 | DELETE or trim to what the OpenCode path still needs |
| I115 | src/derivedCache.ts, the TS `updatePayload` twin named in `rc/tests/update_payload_parity.rs` (src/updatePayload.ts is absent at HEAD: confirm which compiled module `gen-update-payload-expected.mjs` loads) + gen-update-payload-expected.mjs, gen-summarize-expected.mjs, gen-log-reader-expected.mjs | I68, I72, I73 | per twin fate |
| I116 | src/test/setupSelfChecks.test.ts, setupVerb.test.ts, admissionIntegration.test.ts:85, :100 (uses `/api/summary` as the shed route), serverEndpoints.test.ts:49,267-280, standaloneCors.test.ts:99-117, parkedBodies.test.ts:110, helpers/freePort.ts:108,:221 (default readiness path `/api/server-stats`) | EHT-03, I52 | RE-POINT; `admissionIntegration` needs a different heavy route once `/api/summary` is paged |
| I117 | `pnpm run compile-tests` (tsconfig.test.json to `out/test/`) after any TS change, before regenerating any fixture | memory page lesson: a byte-stable regenerate is meaningless without a fresh compile | fixture regenerate preceded by `npx tsc -p tsconfig.test.json` |

## 13. EHT-13 - PROJECT memory pages (`.claude/project/memory/`) that describe the old model

They get correction lessons through memgrep verbs (supersede, never delete; `memgrep validate && memgrep lint` after each edit; description line extended with the symptom words of the new model). Commit after each write.

| id | page | line(s) | old claim to correct |
|---|---|---|---|
| I118 | ssd-write-economics.md | :20, :41-55 | fileless-DuckDB-to-Parquet loop as the only low-write design; a persistent `index.duckdb` needs a measured write rate or this page contradicts the new architecture |
| I119 | always-on-ingestion-model.md | :20-22, :70, :75 | "persisted byte offsets" live in `log-offsets`; `/api/summary` is the probe route |
| I120 | agentlenspro-ops-lessons-deploy-and-install.md | :42, :229-235 | data-dir inventory (`log-sessions.json`, `log-offsets.json`, `forensics.db`); "span store, log-tail offsets and session cards" shared state; deploy recipe if I71 changes build |
| I121 | agentlenspro-ops-lessons-concurrency-and-event-loop.md | :161 | `compositions_in_scope` held the state lock because `build_session_summary` ran inside the guard (no summary engine now) |
| I122 | agentlenspro-ops-lessons-store-durability-and-memory.md | :21-41 | window/`forEachInRange` memory lessons assume a resident window |
| I123 | otlp-ingest-topology.md | :10, :50-56 | `/api/summary` grouping by `summarizers/codex.ts` (four copies of prompt grouping) |
| I124 | ts-dead-code-vs-rust-parity-oracles.md | whole page | oracle list shrinks when twins are deleted; add the rule "goldens from the current alcore (FND-00) replace TS oracles for operations" |
| I125 | vmmap-ioaccelerator-is-the-mimalloc-heap.md, log-scan-performance.md | | memory composition and boot-scan costs measured on the old model (re-measure after) |
| I126 | hook-events-pipeline.md, statusline-capture-and-store.md | | NS-3 ring to `hook_event`, NS-6 decision (FND-08, FND-11) |
| I127 | agentlenspro-publish-pipeline.md, dashboard-tree-render-topology.md | | release recipe if binary set changes; render topology of the timeline when paged |
| I128 | NEW pages | | one for the index architecture (hub), one for the migration/rollback recipe; wire both ends of every link |

## 14. EHT-14 - TRDD cards superseded or edited

Grep `design/tasks/` for `summary_engine|feed_merge|card_store|span_window|cards.duckdb|session_summary_sql|derived_cache|delta_log|forensics.db|forensics_db` (columns read from frontmatter at spec time). Each card gets a per-card judgement (governance rule: no scripted mass repair), through `trddgrep`.

| id | card | column | hits | action |
|---|---|---|---|---|
| I129 | 9VX3WTGU alcore stays within the 2048 MB cap - phased memory redesign | dev | 22 | SUPERSEDE phases C (incremental summary rebuild), F (incremental `save_cards`), D (streaming boot restore), E (window shrink), G (SSE/ingest/MCP allocation hardening) by this design; KEEP phases 0, A (pressure ladder, re-pointed I68), B (DuckDB limit/spill); keep Amendment 1 (dashboard pagination, owner quote) as the origin of D6; Amendment 2 (`sessions` verb) is I45; step 2 (94125a8d `cards.duckdb` reuse) is rolled back with I66 |
| I130 | 7YPQWKPG DuckDB is the memory and alcore keeps no resident data model | dev | 5 | parent or sibling of this design: link, do not duplicate |
| I131 | KBM09XHB Nothing is stored in RAM - every answer a short or paginated DuckDB result | todo | 2 | same intent: merge or supersede by the parent |
| I132 | FSMISF5K Per-session summaries are DuckDB queries over the segments; span window deleted | dev | 7 | same intent as C01/FND-05; supersede or fold |
| I133 | XTFDRTH2 Session cards live in a DuckDB table upserted on ingest | human_review | 14 | the card store this design deletes: supersede after the parent lands |
| I134 | TOIM26HP session-card DuckDB store is a file under the data dir | dev | 12 | supersede (the file retires) |
| I135 | YILE6N3T span window reports 5 minutes but holds 24 h | human_review | 6 | supersede (no window) |
| I136 | Q9WD3K5R DuckDB is the gateway - delete the layers between callers and it | todo | 21 | owner of the opener-cap target (I105): link |
| I137 | DKBGT7MQ eight DuckDB instances each carry their own buffer-pool limit (19.25 GB) | todo | 9 | one index connection changes the arithmetic: link, re-measure |
| I138 | 2R36W8Q1 (summary cache keyed on a version that moves faster than a rebuild), 5JZQFVO8 (card store 256 MB pool overflow crash-loop), TWDGR75R (card-store OOM poisons the core lock), JJLI6GEH (DuckDB OOM in boot card restore), 2JOIAH2G (composition line; crash loops under the RSS cap), 563B8WYH (2 GB cap crash loop), WKLD508O (culprit log instead of exceeding the cap), 768NEX6E (bodies pass cost; 7 GB resident), GR6WHHK5 (boot load evicts codex spans: receivedAt after append), UTFVMVT8 (composition routes hold the state lock), DX8PYPLO, IRNHEN4Z (api_calls part compaction), CAJ5RCP9 (cache-event history), ORGJ0E3G (transcript cost bills 5m rate), CUCLHFBA (unpriced-session flag never ported) | various | 1-5 each | per-card judgement: root cause removed by the design (supersede) vs survives (re-point). GR6WHHK5 maps to FND-05 `received_at`; ORGJ0E3G to FND-03 `cache_create_1h` |
| I139 | OHZGLDNG CLAUDE.md still documents the TypeScript server retired in 567fc5c2 | human_review | 3 | overlaps EHT-01: close first, or fold I01-I07 into one pass to avoid two rewrites of the same paragraphs |
| I140 | NDKKOABG rust-core never built or tested by CI | human_review | 3 | blocks I109; link |

## 15. Contract-delta propagation (OCAT section 4, D1-D10; owner EHT-01)

CONTRACT-DELTA.md (seed = OCAT section 4) is the single list of by-design output changes. Every consumer above that quotes a number or a field is checked against it: I21, I25 (skills), I14-I18 (docs), I42-I50 (CLI), I55-I58 (dashboard), I62 (smoke). Proof: each D-row has the three files where a human could have copied the old behaviour grepped and either fixed or ticked.

| id | delta | consumers that need an explicit check |
|---|---|---|
| I141 | D1, D2 (usage by last row, global dedupe) | skills cost examples, README cost figures, `budget.md`, dashboard Cost/Analytics, `agentlenspro budget` |
| I142 | D3, D4 (workflow subagent parents, `journal.jsonl` / `*.orphaned-*.jsonl` skipped) | session counts in `server status`, README, skill `get_recent_sessions` examples, `sessionCount` in F1 |
| I143 | D5 (timelines uncapped) | I59, I91, `src/test/rustOpenCode.test.ts:159-165` |
| I144 | D6 (paged summary) | I52-I57, I62, I110, I116 |
| I145 | D7 (no write on read), D8 (budgets removed), D9, D10 | I36 (`ensure_fresh_index`), I25, I46, I58 |

## 16. Item count

Items I01-I152 in 15 EHT cards: EHT-01 24 (I01-I19 and I141-I145), EHT-02 10, EHT-03 12, EHT-04 10, EHT-05 12, EHT-06 14, EHT-07 12, EHT-08 6, EHT-09 8, EHT-10 5, EHT-11 6, EHT-12 3, EHT-13 11, EHT-14 12, EHT-15 7. Cards that are mostly KEEP-VERIFY (cheap, but each still needs its proof run): EHT-02, EHT-04.

## 17. EHT-15 - soak gate and rollback list

Nothing in this section may be deleted, overwritten or migrated until the soak passes. Soak criteria are defined by the parent TRDD (9VX3WTGU soak gates, "RSS under the cap, no crash-loop, golden diff zero"); this spec adds only the artifacts that must still exist and the recipe.

| id | must stay until the soak passes | why |
|---|---|---|
| I146 | previous alcore binary: `bin-native/<platform>/alcore.prev*` and the dated copies (`alcore.prev-20260924`, `alcore.oct01.bak`, `alcore.pre-5JZQFVO8`; gitignored, local only) and the last published npm version before the redesign | rollback target; copy before the new binary replaces `alcore`; re-sign after any copy (`codesign -s - --force`, CLAUDE.md Operations) or it dies with exit 137 |
| I147 | `cards.duckdb` (+`.wal`, `.tmp`), `log-sessions.{snapshot,delta}.ndjson`, `log-offsets.{snapshot,delta}.ndjson`, `log-delta-version.json` in the data dir (I93-I94) | the old binary restores from them; the new one must not touch them |
| I148 | `spans/` segments and the transcript corpus | source of truth for the index rebuild and for the old binary |
| I149 | `account-state.ndjson`, `hook-events/`, `collector-lifecycle.json`, `statusline/`, dual-written (I96) | rollback with current data |
| I150 | the FND-00 harness, `tiny` and `full` golden captures, `rc/tests/fixtures/*-expected.json` and TS oracles (I112-I115) | acceptance evidence; deleted last |
| I151 | the old Rust modules (I64-I70) and their tests (I79-I83) | kept compiling behind a switch OR kept in git history only: DECIDE; a binary built from the commit before the redesign is the rollback artifact, so tag it |
| I152 | CHANGELOG, doctrine and skill text describing the old behaviour in git history | `git show <tag>:CLAUDE.md` is the record |

Rollback recipe (INFERRED, to be rehearsed once on a scratch data dir): `agentlenspro server stop --stay-down` (sets the hook-revive brake, `src/cli/storeAdmin.ts` shows why) -> restore the saved `alcore` and `codesign -s - --force` -> remove nothing from the data dir -> `agentlenspro server start` -> `agentlenspro setup --dry-run` -> `agentlenspro server status`. The old binary then finds its sidecars stale (the new binary never wrote them) and catches up from the transcripts; ingestion is lossless because transcripts are append-only. Proof: the drill on a copy of the real data dir shows session count within the D3/D4 delta of the new binary.

After the soak: move the I147 files to `.trashcan/` with `safe-delete` only on the user's explicit approval (RULE 0: user data, outside git); then delete modules I64-I70, tests I79-I83, TS twins I112-I115, scripts I101, lower the guard numbers I105, and re-run `pnpm run compile` and `cargo test --workspace`.
