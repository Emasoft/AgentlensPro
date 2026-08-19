---
trdd-id: DMWOBWFH
title: Rewrite the server core in Rust with optimized SQL — TypeScript remains only for the UI
column: dev
created: 2026-08-18T17:00:52+0200
updated: 2026-08-19T20:20:00+0200
current-owner: AgentlensPro session
task-type: refactor
severity: HIGH
priority: 1
effort: XL
labels: [performance, rust, architecture, migration]
approval-tier: 3
relevant-files: [standalone/server.ts, src/segmentedSpanStore.ts, src/logReader.ts, src/store, src/otelCallEvents.ts]
release-via: publish
---

# Rust core rewrite — GOAL SET BY THE USER (2026-08-18)

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-18 (v2)

- **P1 COMPLETE and LIVE.** `agentlens-spanstore` reads the real segment format with a rayon
  parallel walk; `alscan` CLI; the TS server EXECS it for every call-events scan on this machine.
- **Wiring (src/rustScan.ts + otelCallIndex.ts head):** two explicit opt-in channels — env
  `AGENTLENS_ALSCAN=/path` (per-process, wins, routes unconditionally) and the durable install
  `~/.agentlens/bin/alscan` (`dataPath('bin','alscan')` — presence IS the opt-in; applies ONLY
  when spansDir is not overridden, so fixture-driven tests keep testing the TS path on machines
  that have the binary). A failed exec THROWS — no silent TS fallback once opted in. Deployed:
  binary installed, bundle rebuilt, server restarted, and the live server was OBSERVED exec'ing
  `~/.agentlens/bin/alscan ~/.agentlens/spans --since 0 --until … --json` (child of the server pid).
- **Tests:** `rust-core/…/tests/parity.rs` (4 golden fixtures: string-int OTLP values incl.
  full attr set query_source/speed/effort/agent.name, time precedence, gz≡plain, mid-compression
  dedupe, windowing, corrupt tail) + `src/test/rustScan.test.ts` (cross-engine deepStrictEqual
  vs the TS scan on a fixture store — field-for-field, and the routing test; 🐌-gated on the
  local cargo build, PENDING on CI which has no Rust). Suite 2403 passing.
- **Benchmarks (real 5.5M-span store, 31 segments, 240,729 events)** — table in the body below.
  Headline: 32.7s single-core TS → 1.1s at 667% CPU (14 threads) ≈ 29× wall.
- **PARITY PROVEN on the real store (17:08):** key-normalized diff of 240,482 co-visible events —
  zero real divergence (23 only-ts were post-run live growth). Diff trap: serde_json alphabetizes
  keys vs JSON.stringify insertion order — always key-normalize both sides before comm.
- **P2 IN PROGRESS — the Claude transcript parser is PORTED and PARITY-PROVEN.** Crate
  `agentlens-logscan` (+ `allogscan` bin): faithful port of `_claudeOnEntry`/`_buildCard`/
  `_buildSubAgentCards`/timelineRetention — usage dedup per message.id, UTF-16 length parity in
  the retention accounting (JS .length is UTF-16 units, NOT bytes — utf16_len/utf16_slice, never
  str::len), bounded collections with insertion-order eviction (IndexMap.shift_remove), Rc-shared
  timeline entries so late tool_results mutate evicted entries harmlessly, `<synthetic>` model
  guard, single-tool_result toolUseResult attribution gate, worktree/subagents parent linkage.
  ONE-SOURCE-OF-TRUTH SPLIT (deliberate, keep it): Rust emits `blendTurns`/`genFiles`/
  `lastTimestampMs`; the TS wrapper `src/rustLogScan.ts::finishRustTranscript` owns accountId
  (live registry), speedBlendedCostUsd (pricing.ts is the ONE table — never grow a Rust rates
  mirror), attachGeneratedFiles (fs heuristics), hot-age strip (Date.now).
  **PARITY: fixture tests (mixed-speed, caveat/api, async Agent + sync Task, astral chars) AND a
  99/99 real-corpus sweep — 3 newest transcripts of EVERY project on this machine, deepStrictEqual
  on the JSON wire shape, zero mismatches.** Boot-scan measure: 13,110 files → 12,928 cards in
  5.6s at 462% CPU (`allogscan --dir ~/.claude/projects`).
- **P2b WIRED AND MEASURED.** `_scanClaude` fans never-seen (cold) files to ONE `allogscan
  --files-from` exec (argv would exceed ARG_MAX at 13k paths); live tails stay TS-incremental;
  fileState seeded from the binary's `fileSizeBytes` with a stale-mtime poison when the file grew
  mid-scan (conservative-safe: mismatch → reparse). The binary hot-age-strips cold parent
  timelines itself (`--strip-older-than-ms`) — the unstripped corpus NDJSON measured **1.2GB**
  (ENOBUFS through any pipe); stripped it pipes fine, and it is the same TRDD-66IXMIGN parse-time
  strip the TS parser applies (child cards keep their ≤1-entry timelines, parent only, and the
  stripped card carries `timelineRetainedBytes: 0` exactly as TS stripTimeline leaves it).
  Real-corpus cold boot through the REAL `_scanClaude`: **12,932 sessions + 4,241 child cards in
  6.7s** (binary 4.1s on 14 threads) vs **27.0s single-core TS** — identical result counts both
  engines. NOTE: ordinary server restarts take the "Fast restart — skipping cold rescan" path
  (persisted offsets import into fileState), so the Rust path fires exactly on the expensive
  case: true cold boots — fresh installs, offset-store loss, the original incident class.
- **P2c: CODEX PORTED AND PARITY-PROVEN.** `codex.rs` (openai-shaped buckets — cached ⊂ input
  shed at construction; reasoning folds into output; lastTimestamp advances only on event_msg;
  LATEST cumulative total_token_usage wins). `allogscan --codex` selects the grammar;
  `_scanCodex` wired with the same cold-fan-out + `_recordRustColdScan` shared tail (one copy of
  the fileState-seeding contract). Parity: fixture + **7/7 real codex transcripts** deepStrictEqual.
- **P2d: COPILOT PORTED (all 3 shapes) — P2 log-scan phase COMPLETE except opencode.**
  `copilot.rs`: CLI events.jsonl (session id = the DIRECTORY name; tokens from
  session.shutdown modelMetrics, never currentTokens; XML-block user-text skipper), the VS Code
  delta log (kind 0/1/2; three completionTokens formats, kind=1 wins; workspace via sibling
  workspace.json file:/// percent-decode), and the legacy JSON snapshot (no tokens by design).
  Flags `--copilot-cli|--copilot-vscode|--copilot-vscode-json`; all three scan paths wired with
  the shared `_recordRustColdScan` contract. Parity: fixture deepStrictEqual on all 3 shapes
  (this machine has zero real copilot sessions — 0 CLI, 0 chatSessions — so fixtures are the
  available proof). **opencode (SQLite) deliberately WAITS for P3 duckdb-rs** — porting the
  sql.js+WAL-merge reader twice would be waste when P3 gives a real DB engine.
- **P3 STARTED — the span-store WRITER is ported and round-trip-proven.**
  `agentlens-spanstore::writer::SpanStoreWriter`: day-keyed buffered appends (100k disk-failure
  failsafe, loud oldest-drop), one appendFile per touched day at flush, `index.json` kept
  atomically (tmp+fsync+rename), loadOrRebuildIndex reconciliation (byte-size disagreement →
  streamed recount; adopted/vanished segments), and compressSealedSegments with the FULL
  verify-before-delete contract — resume-an-interrupted-compress included. Verification is
  engine-agnostic (streamed gunzip-compare), so flate2-vs-zlib output differences cannot break
  it. 4 round-trip tests: written→scanned back time-ordered, crash-index reconcile, seal+read
  the gz+LOUD late-append with dedupe-on-read, today-never-compresses.
  NOTE for the ingest slice: a TS-side "reads a Rust-WRITTEN store" test lands with the P3
  ingest binary (the writer needs a CLI surface first; the format is the reader's own NDJSON).
- **P3b DONE — the OTLP transform is ported and cross-engine-identical.** `agentlens-ingest`:
  processTraces/processLogs/processMetrics as PURE functions (side effects return as data:
  account pairs, body pointers, dropped events; gen_ai injects via a caller callback so the
  buffer's consume-on-inject stays exact), plus the CodexSessionNormalizer and gen_ai formatter
  ports and the shared gate sets. `alingest` CLI for parity/debug. Parity: 3 TS cross-engine
  tests drive the REAL OtlpCollector privates against a mock store and deepStrictEqual the
  addSpan payloads — traces, the full logs gauntlet (rich session.id-first keying + re-prefix,
  tool_result event.timestamp timing, codex per-prompt grouping + synthetic parent, drops,
  body pointers, account harvest), and the gen_ai two-sided inject; 2 Rust unit tests pin the
  stateful halves. Suite 2414 passing.
- **P3c CORE DONE — the bodies→DuckDB store is ported (duckdb-rs bundled) and CROSS-ENGINE
  compatible.** `agentlens-store`: sections.rs (byte-exact sectionizer — Rust scans BYTES so
  UTF-8 identity is by construction), db (fileless :memory: instance, same DDL, temp_directory=''
  fail-loud, immutable zstd Parquet parts with collision-free epoch+pid+seq names +
  refuse-to-overwrite, union_by_name + UNION ALL BY NAME), ingest_body (GATE 1 reconstruct-
  before-write, GATE 2 dedup via the known-sha reload), reconstruct_body (end-to-end sha proof),
  verify_bodies_in_store (bytes/row/ts±2000ms bulk gate). `alstore ingest|reconstruct|verify`
  CLI. **PROVEN: a TS-written store reconstructs byte-identically through Rust AND vice versa,
  on a REAL captured body; Rust verify gate passes on the TS-written store.** 5 Rust tests +
  2 TS cross-engine tests.
- **P3c COMPLETE (commit 9190dc4).** `pass.rs` ports ingestPass.ts with the full delete-gate
  ordering (ingest→FLUSH→fsync barrier→chunked verify→delete), the 512MB throttle, skip-name
  reclaim, stranded-ts parking + relocation (mtime preserved) + 3-strike breaker, per-chunk
  verify isolation. `alstore pass` persists skip/stranded state in `<storeDir>/.pass-state.json`
  across invocations. 4 pass tests + 2 round-trip + 3 sectionizer + 2 TS cross-engine — all green.
- **P3d COMPLETE (commit e85f481) — every log source now parses in Rust.** `opencode.rs` in
  agentlens-logscan via rusqlite (bundled): rusqlite opens the LIVE db read-only with NATIVE WAL
  handling, REPLACING the TS byte-copy + hand-rolled `_mergeWal` on the Rust path (the TS
  `_mergeWal` stays only inside the TS fallback engine). `allogscan --opencode <db>` emits one
  NDJSON session line per root session; `rustParseOpenCodeSync` (rustLogScan.ts) + the
  `_scanOpenCode` wiring use the same two opt-in channels (env unconditional; installed binary
  only when OPENCODE_DATA_DIR is unset); a binary failure degrades through the SAME catch as a
  TS db error (JSON fallback). TimelineEntry grew action/toolInput/errorMessage (+ turn is now
  Option) with entryCost parity; `cap_timeline` ports TS capTimeline. `last_timestamp_ms` is
  DELIBERATELY 0 on opencode transcripts — the TS opencode path applies no hot-age strip, and 0
  disarms finishRustTranscript's boundary strip (parity law, do not "fix"). PARITY: fixture db
  (root-filter, zero-token filter, model NULL, last-user-text wins, equal-ts llm-before-tool
  stable order, callID-null spanId, ''-output truthiness, error parts, astral chars) AND the
  REAL 160MB db — native WAL read deepStrictEqual to the TS merge; capTimeline eviction pinned.
  GOTCHA (cost a debug cycle): the real-db TS parse must run in a CHILD process
  (src/test/helpers/opencodeParseChild.ts) — sql.js WASM memory never shrinks, and in-process it
  pushed mocha past the 4096MB rssPressure HWM, which flips compressSealedSegments into its
  defensive skip and fails 8 UNRELATED tests (7 gz + the HWM default). Suite 2420 passing, 0
  failing. Deployed: bundle rebuilt, `~/.agentlens/bin/allogscan` replaced, server restarted
  (verified `rustParseOpenCodeSync` in the running bundle).
- **P4a DONE — the wire surface is FROZEN and inventoried.** Report (gitignored):
  `reports/p4-wire-freeze/20260818_200921+0200-frozen-wire-surface.md` — 46 HTTP routes
  (40 UI + 3 OTLP + 3 MCP), 53 MCP tools, the per-request preamble ORDER (base-path strip →
  CORS → CSRF gate → viewer-role → admission), heavyGuard's 7 routes, the SSE frame shapes, the
  `/api/server-stats` key order, the OTLP always-200 contract, the data-dir lock takeover
  matrix, shutdown/watchdog observables. Anchors spot-verified first-hand: line counts exact
  (server.ts 4669 / mcpServer.ts 4018), TOOLS@410, IS_CANONICAL@1292, otlpServer@4413,
  pid lock@184; the 54th `name:` grep hit is serverInfo@3380, so 53 tools is correct.
  The freeze list IS the P4 spec — P4 parity law: /api/* + MCP wire shapes FROZEN, dashboard
  works unmodified.
- **P4b DONE, DEPLOYED and OBSERVED LIVE — the server execs `alstore pass`; the TS in-process
  ingestPass remains only as the no-binary fallback branch.** `src/rustStorePass.ts` (same two
  opt-in channels as alscan/allogscan; failed exec THROWS into archiveOtelBodies' catch; exit 75
  = flock-busy → benign skip-tick) + the `archiveOtelBodies` branch in standalone/server.ts.
  Live: spool backlog (thousands of files) drained to the live window, reclaimedDurable path
  proven (1,234 skip-reclaims in one pass), `.pass-state.json` persisting.
  **The first live deploy was a RUNAWAY (17min per 512MB pass at ~185% CPU) — three full-scan
  classes, all fixed and each measured:** (1) per-body `body_exists`/named `count(*)` queries —
  every `all_of` re-binds the full parquet file LIST (4,215 files, ~seconds/query) → in-memory
  `body_ids`/`bodies_named` sets, seeded at open, mutated in append_body_row (the `known`
  pattern); (2) verify's per-32-chunk reconstruct — each part/blob query decompresses an ENTIRE
  parquet corpus (zone maps useless: insertion-ordered shas) → ONE part + ≤1 blob query per
  verify CALL, a pass-scoped SpanCache (filled ONLY from store results — proof preserved), and
  byte-bounded settle groups (SETTLE_GROUP_BYTES 128MB replaced SETTLE_READ_CHUNK 32); (3) the
  bodies-corpus row query per chunk → native `body_durable` mirror: loaded at open, appended at
  flush by READING BACK the just-written parquet (the read-back IS the encoding proof;
  durability stays the fsync barrier), `all_of("body")` never touches parquet again.
  **Measured: 1033s → 38s for the same 512MB/1,018-body workload (27×).** Profiled with
  `/usr/bin/sample` — never theorize this again: the hot stacks were zstd decompress + file
  opens, not query planning.
  **Concurrency (observed, not hypothetical): a SIGKILLed/raced server ORPHANS its pass child
  and the next server starts another — two live passes on one store on 2026-08-18.** Fix:
  `acquire_pass_lock` (fs2 kernel flock on `<storeDir>/.pass.lock`, auto-released on ANY death,
  taken BEFORE the store open; Busy≠Io — a fresh store dir must not read as "busy"). Data was
  never at risk (delete gate verifies-from-durable-first), only CPU.
  Tests: 5 Rust pass tests (incl. flock exclusivity) + rustStorePass.test.ts (routing,
  fail-fast, cross-engine drain parity field-for-field, and the load-bearing claim that an OPEN
  TS store handle sees Rust-written parts — parquetScan re-lists per query).
- **P4c DONE — `agentlens-core` crate + the OTLP listener behind the frozen contract.**
  `alcore serve --data-dir D [--otlp-port N, default 4319 — 4318 stays TS until cutover
  (IS_CANONICAL keys on it)]`. hyper+tokio (NOT axum: the freeze's overflow semantics are
  "socket destroyed, NO response", which the raw service reproduces by returning Err — axum
  must always produce a response). Contract per report §2, all socket-level-tested (raw
  TcpStream clients, 6 tests): probe matches the RAW url exactly (query string falls through),
  non-POST bare-200 without Content-Type, POST path-first routing + classify fallback,
  parse-failure/protobuf still 200, metrics accepted+discarded, >64MB kills the connection
  responseless. Wired: process_traces/process_logs → SpanStoreWriter, flush-per-payload
  (internal cadence, not wire-frozen) + exit flush. Live-verified end to end (curl probe, POST,
  span in `spans/<day>.ndjson`, SIGINT flush). Workspace 32/32.
  Fixture gotcha that cost a cycle: process_traces GATES on traceId+spanId+name — a span
  without ids silently yields []; and the writer day-keys on the span's own startTime
  (1755504000000000000 ns = 2025-08-18, not the attr's ISO).
  NOT in this slice (deliberate): admission-control 503s, the gen_ai two-sided inject (needs
  the live span window — `|_,_,_| false` for now), account/body registries, dropped-event sink.
- **NEXT ACTION (one step): P4d — port the in-memory span window + summarizer** (SessionStore
  5-min rolling window + src/spanSummarizer.ts) into agentlens-core: it is the engine behind
  /api/summary, the SSE update frames, AND the gen_ai injection target — the prerequisite for
  every UI-surface route. Cross-engine parity: deepStrictEqual the summarizer output on a real
  captured span window vs the TS engine.
  SIZED (2026-08-19): the true surface is ~3,350 lines — sessionStore.ts 187 (trivial: window
  trim, coarse counters, injectSpanAttribute = the gen_ai target) + spanSummarizer.ts 283
  (synth-root logic for in-progress Claude/Copilot traces, bg-span mapping, efficiency rollup)
  fan into summarizers/claude.ts 620, codex.ts 506, copilot.ts 289, helpers.ts 340,
  loopDetector.ts 309, shared/summarizerTypes.ts 729 (the WIRE shape), shared/tokenBuckets.ts
  81. **P4d.1 DONE (commit cdfa379): helpers.rs ported with Node-verified parity pins** — every
  risky expectation (String/Number coercions, BigInt truncation + parseInt fallback, toFixed,
  the literal "Lundefined-undefined") was computed in Node first, 7/7 pinned. Two documented
  divergences: char-boundary byte caps (TS slices UTF-16 units) and {:.1} vs toFixed rounding.
  **DESIGN DECISION (keep it): the builders emit `serde_json::Value` objects mirroring the TS
  object literals directly — NO typed-struct port of summarizerTypes.ts.** Parity by
  construction: conditional keys mirror `...(x ? {x} : {})` inline, preserve_order keeps
  insertion order, and the cross-engine diff key-normalizes anyway. summarizerTypes.ts stays
  the documentation of the shape, not a Rust artifact.
  **P4d.2 DONE (commit 1c3be97): buckets.rs + copilot.rs ported, TS-oracle parity EXACT.**
  THE HARNESS PATTERN TO REUSE FOR EVERY BUILDER: the parity oracle is the COMPILED TS builder
  itself — a fixture runs through `out/test/summarizers/<x>.js` via a
  `tests/fixtures/gen-<x>-expected.mjs` generator (JSON round-trip drops undefined exactly as
  the wire does), and the Rust port must Value-equal the result (key-order-insensitive). It
  caught `cacheHitRate: 0.0` vs JS's `0` on first run. Regenerate expectations after any TS
  builder change: `pnpm run compile-tests && node <generator>`. Port mechanics that carry over:
  `num()` (integral-bare JSON numbers), `truthy()` (JS if-guards), conditional key inserts
  mirror `undefined` drops, Vec-backed insertion-order maps, `js_slice` byte caps.
  **P4d.3 DONE (commit 85e65d2): claude.rs ported (builder + session.id slice merge), TS-oracle
  parity EXACT; workspace 44/44.** retention.rs carries the capTimeline/entryCost slice of
  timelineRetention.ts (UTF-16 entryCost — JS .length is code units; env knobs fail-fast,
  memoized); num/iso_from_ms/truthy + the span accessors moved copilot.rs → helpers.rs (shared,
  no duplication). `callBodyRegistry.accountFor` is an `account_for` caller callback
  (`&dyn Fn(&str) -> Option<String>`, the P3b precedent) — harness passes `|_| None` because the
  oracle's fresh-Node registry is empty. Gotchas pinned by the fixture: the TOOL branch's
  `filesSearched.add(args.pattern || …)` inserts the RAW value un-stringified (every other add
  site String()s) — JsSet keys on JSON serialization to match SameValueZero; JSON.parse('null')
  + property access THROWS in TS (its catch treats the raw string as the path) — the port guards
  `is_null()` on every parsed-args site; the merged literal writes `accountId:`/`filesChangedNote:
  undefined`, DELETING the base slice's key (shift_remove, not skip).
  **P4d.4 DONE (commit 5b660b2): codex.rs ported (batch grouper + builder), TS-oracle parity
  EXACT; workspace 45/45. Two REAL fixes fell out:** (1) helpers'
  is_codex_prompt_span_name had DRIFTED from the TS list (codex.turn/user_turn vs the real
  user_message/session_start) — now delegates to agentlens_ingest::is_codex_prompt_event_name
  (no crate cycle; the "cycle" the P4d.1 comment feared never existed); (2) **serde_json's
  DEFAULT float parse is best-effort** and read a fixture's 0.18181818181818182 one ulp off —
  `float_roundtrip` is now pinned in agentlens-core's Cargo.toml; every TS-oracle fixture
  comparison silently depends on it (claude's fixture had passed by luck). Grouper mechanics
  pinned: activePromptTraceId is Option<String> (JS undefined===undefined must MATCH the next
  traceId-less span); group key becomes the card's traceId; the shell-command file regex spells
  JS \w as ASCII classes (Rust \w is Unicode).
  **P4d.5 DONE (commit b754cfe): loop_detector.rs ported (all 5 detectors + inferTaskComplexity),
  TS-oracle parity EXACT; workspace 46/46.** Every user-facing string is pinned by the fixture;
  toLocaleString = en-US grouping (a different ICU default fails the fixture loudly);
  request lengths in UTF-16 units.
  **P4d.6 DONE (commit ab9cd4a): summarizer.rs ports summarizeSpans (grouping, both synth-root
  passes, builders, loop signals, bg association, efficiency), TS-oracle parity EXACT on the
  empty literal AND a cross-source fixture; workspace 47/47.** Deviation on record: the synth
  passes' never-Equal string comparator would be a non-total order (Rust sort_by may panic) —
  str::cmp used; only equal-startTime tie order could differ.
  **P4d.7 DONE (commit 03089ee): session_store.rs ports the 5-min window + coarse summary +
  injectSpanAttribute (the gen_ai attach target), clock as a `now_ms` parameter, TS-oracle
  parity with a PINNED Date.now; workspace 48/48. THE WHOLE P4d PORT CHAIN IS NOW IN RUST:**
  helpers → buckets → retention → copilot/claude/codex builders → loop detector →
  summarizeSpans → SessionStore.
- **P4d.8 DONE (commit 6ae68b2) — P4d COMPLETE, end-to-end proven on REAL data.** `alsummarize`
  bin + src/test/rustSummarize.test.ts (fixture + a 20,000-span tail of the live store,
  deepStrictEqual both engines; 🐌-gated). **The real-window replay immediately falsified the
  P4d.1 byte-cap shortcut** — js_slice now counts UTF-16 code units exactly (every long
  userRequest with an em-dash had truncated short); LESSON: a fixture-blessed "accepted
  divergence" is not accepted until a real-corpus replay agrees. Gates: cargo 48/48, both e2e
  tests green, tsc + eslint clean. The full-suite bodyStore dedup-ratio failure is the
  pre-existing data-drift flake, carded as [[TRDD-R2VF2I53]].
- **P4e DONE (commit 6e2f8de) — alcore's UI listener serves `GET /api/summary`.** `ui.rs`:
  `alcore serve --ui-port` (default 3001; 3000 stays TS until cutover), CoreState carries the
  SessionStore fed by every ingested span; the route returns summarize_spans(window) through
  strip_session_detail. Preamble reproduced: CORS echo (same-origin/loopback only, never `*`),
  CSRF 403, viewer-role gate (no embed key loaded ⇒ any present header is `invalid` → 403 — the
  embedAuth "key is null" rule verbatim; HMAC roles land with the embed-key slice), bare 404.
  4 socket tests + live curl verification. Workspace 52/52. **Scope on record:** OTEL-only
  summary (log-session merge = feedMergePolicy + spawn collapse pending the log-scan wiring);
  admission control + base-path strip deferred, documented in the module head.
- **P4f.1 DONE (commit 131c17f) — PRICING IS A GENERATED ARTIFACT, NOT A MIRROR.** The SSE
  payload needs `currentSession.costUsd` = calcTokenCostUsd; the law "pricing.ts is the ONE
  table" is honored by `scripts/export-pricing.js` → `rust-core/.../pricing.json` (embedded via
  include_str!) + `pnpm run check-pricing-export` (wired into compile/package) failing the build
  when stale. Only the LOGIC is ported (`pricing.rs`: normalize, exact→longest-prefix lookup,
  scheduled change on the CALL's timestamp, 1h-rate derivation, >200K tiering). Parity: 321
  oracle cases BIT-EXACT. Workspace 54/54. DISCIPLINE: after ANY pricing.ts edit run
  `node scripts/export-pricing.js` then regenerate pricing-expected.json.
- **P4f.2 DONE (commit de3055f) — SSE `/events` live on alcore with the 4 s coalesced update
  push.** The three inline payload derivations moved VERBATIM out of server.ts into
  `src/updatePayload.ts` (the oracle seam; server.ts imports them) and are ported in
  `update_payload.rs` + buildUpdatePayload frame assembly; `ui.rs` gained the SseHub
  (tokio broadcast → per-client queue), `run_push_loop` (tick every PUSH_COALESCE_MS, rebuild
  only when `CoreState.data_version` moved), and the `/events` route (ANY method, chunked like
  Node). Parity: update_payload_parity (fixture + crafted summary pinning burnRate/priced
  costUsd/multi-day/''-startTime + empty literals) and a real-socket SSE test (ping → connect
  frame → OTLP POST → pushed frame in-window). Workspace 56/56; tsc/eslint/esbuild green.
  GOTCHA: both engines stream `Transfer-Encoding: chunked`; the freeze's "first bytes `:\n\n`"
  is the DECODED stream — raw-socket tests must de-chunk.
  Not in this slice (later, need other subsystems): sessionChanged (log-scan wiring), burnStatus
  (burn investigator), alert frames, collectorGaps (collector lifecycle), admission 503s.
- **P4g DONE (commit 33b0933) — the feed-collision doctrine is in Rust and every served surface
  merges OTEL⊕log.** `feed_merge.rs` ports feedMergePolicy.ts (preferred source, P7 stamps,
  api_request graft, P8 placeholder↔transcript link); `CoreState.log_sessions` +
  `put_log_session` (bumps data_version) + `session_summary()` (= computeSessionSummary:
  merge → link → newest-first) now feed /api/summary, the SSE connect frame and the coalesced
  push. Parity: every branch on crafted cards + a socket test of the merged wire. 58/58.
- **P5a DONE (commit 79141b5) — log-file discovery per source** in
  `agentlens_logscan::discovery` (Env-parameterized roots, every override shape incl. the
  OPENCODE_DATA_DIR filtered/unfiltered asymmetry, sibling + stat gates, TS scan order). 4
  fixture-tree tests; real-machine census 13,504 claude / 7 codex / 0 copilot / 1 opencode =
  identical to a TS-equivalent walk (`cargo run -p agentlens-logscan --example disc_census`).
- **P5b DONE (commit d266b1c) — the cold boot log scan is a LIBRARY call inside alcore.**
  `agentlens-core/src/log_reader.rs`: `cold_scan(&Env, now_ms)` = discover_all → rayon
  parse (opencode dbs sequential) → `finish_transcript` (= finishRustTranscript: blended cost
  over blend_turns as the LAST key, parent-only hot-age strip via the new
  `retention::timeline_hot_age_ms()`, f64 counters → bare integers so one number shape is
  served); `CoreState::run_cold_log_scan` puts every card + the global timeline tier
  (`demote_cold_timelines`, AGENTLENS_TIMELINE_HOT_CARDS=50). `alcore serve` runs it before
  the listeners bind; `--no-log-scan` opts out. `log_sessions` is an IndexMap now. Parity:
  `tests/log_reader_parity.rs` — TS-oracle fixture (`gen-log-reader-expected.mjs` builds the
  committed `fixtures/logs-home/` tree, parses it through allogscan, runs the compiled
  `finishRustTranscript` at a HOT and a COLD now) → 7 cards from 5 files Value-equal, plus the
  card-map wiring + tier tests. 65/65. Live: 13,519 files → 17,699 cards in 21.7s (14
  threads); `/api/summary` 13,569 sessions in ~1s; vs the live TS server 13,486 log cards
  field-identical on the 13 compared keys, 63 differ only by live growth between snapshots.
  Measured and RECORDED, not fixed here: (a) the parse engine is the cost — allogscan on the
  same 13.5k files is 23.9s with a 3GB peak RSS and only a 2.5× speedup on 14 threads (cold
  files build a timeline that the strip then throws away — skip timeline retention when the
  file mtime is already older than the hot age; alcore RSS 1.2GB after boot); (b)
  `session_summary` re-clones/merges/sorts 13.5k cards per request (~1s) — TS memoizes the
  derived views by dataVersion, the Rust side should too before cutover; (c) 28 agent-id
  collisions on this machine (the same subagent id under TWO parents → two transcript files
  → the sessionId-keyed map keeps whichever scan order puts last; TS has the same ambiguity
  with mtime order); (d) the TS server carries 2,934 cards whose files no longer exist
  (restored from its persisted card file) — a fresh-boot Rust scan cannot; P5e persistence is
  where parity on that surface lives. Deferred in the finish step, each with a note in
  log_reader.rs head: accountId, generated-files attach, statusline overlay, OpenCode JSON
  fallback on db error.
- **P5d DONE (commit 97d2c95) — incremental tail + the fileState/offset gate.**
  `log_reader::LogTailer` (= LogReader.fileState + accumCache + _incrementalParse): per-file
  `{bytes_read, mtime_ms, ino, size}`, stat-gated sweep, Claude/Codex through the accumulator
  path (resume iff cached accumulator + same inode + not shrunk, else from 0 which caches it),
  Copilot whole re-read (256MB cap), OpenCode db+wal 2-stat gate, partial trailing line never
  consumed, LRU 24 accumulators. `start_sweeper` = ONE thread (the accumulators hold Rc
  entries → !Send): boot sweep synchronous, then every 5s (TS's no-watcher fallback cadence).
  Tests: tailed card Value-equal to a from-0 parse after every growth step, read-kind counters
  pin tail vs from-0, partial-line carry, shrink → from 0. Live: this session's card advanced
  within one sweep. 66/66.
- **NEXT ACTION (one step): P5e — persisted offsets + cards for a fast restart** (server.ts
  TRDD-PJC8N1HO: `exportFileState`/`importFileState` + the persisted-card file, the
  `restoredFromDisk` branch that SKIPS the cold rescan, `stripCardForPersist`, the 30s durable
  save + the save-on-scan). Read the TS persistence format first (the file under the data dir
  and its ino/size validation on import) and write the SAME format so a cutover restart reads
  either engine's file. Then P5c (accountId registry, generated-files attach), a notify-based
  watcher (60s backstop), `/api/server-stats`, and the perf notes under P5b (skip timeline
  retention for cold files; memoize the stripped summary by data_version).
- Gotchas encoded: OTLP intValue arrives as number OR string; dedupe covers mid-compression dual
  segments; corrupt tail lines skip; the TS OtelCallEvent carries speed/effort/agentName —
  a --parity-json requestId/ts/sessionId diff does NOT prove full field parity (the
  cross-engine deepStrictEqual test does).
- Companion mitigations SHIPPED separately ([[TRDD-7I5805QM]], v2.29.0): call-events sidecar
  index (still the no-binary path), get_cache_event_log default 24h, DuckDB threads
  machine-scaled (4 → 12 here).

USER directive, verbatim intent: "Goal set: rewrite all in optimized rust and sql. I need the
agentlenspro server to be blazing fast. Leave typescript only for the ui." Tier-3 approval is the
directive itself; this card records the goal and the migration order. Not to be re-litigated.

## Why (measured, not assumed)

Every observed 100%-of-one-core incident traced to single-threaded TypeScript hot loops, not to
DuckDB: the 5.5M-span store walk (fixed for its recurring case by [[TRDD-7I5805QM]]), the
21k-file log-session boot scan, JSONL parsing at ingest. Node cannot parallelize these without
worker-thread plumbing that Rust gets natively (rayon, memory-mapped IO, zero-copy JSON). DuckDB
was on 4 threads (fixed — now machine-scaled).

## Target architecture

- **`agentlens-core` (Rust binary)**: OTLP/HTTP ingest (4318), segmented span store (same on-disk
  NDJSON/gz format — drop-in over existing data), log readers (claude/codex/copilot/opencode),
  the call-events index, ingest→DuckDB bodies pipeline (duckdb-rs), HTTP/JSON API (the existing
  `/api/*` message protocol, unchanged shapes from `src/shared/`), MCP server (4316).
- **TypeScript keeps**: `media/src/**` (Preact dashboard — unchanged), the thin CLI shell may
  remain TS initially (it is not hot) and port last.
- **Parity law**: the wire protocol (`/api/*` + MCP tool schemas) and the on-disk formats are the
  compatibility boundary — the dashboard and existing data must work unmodified against either
  core. `src/shared/` types become the generated/mirrored schema contract.

## Phases (each independently shippable, benchmarked, behind `agentlenspro server --engine`)

1. **P1 — span store + call-events scan in Rust** (the proven hottest path): read/write parity
   over the existing segment format, parallel segment walk, criterion benchmarks vs the TS scan
   on a copy of the real 5.5M-span store. Ship as a sidecar the TS server can exec for scans.
2. **P2 — log-session boot scan** (21k files): parallel parse, same SessionSummaryCard JSON out.
3. **P3 — OTLP ingest + bodies→DuckDB pipeline** (duckdb-rs; SQL owns aggregation — no JS-side
   materialization anywhere a SQL GROUP BY can answer).
4. **P4 — HTTP/API + MCP surface** in Rust; TS server retired; CLI port; the `--engine` flag dies.
- Acceptance per phase: byte/shape parity tests against the TS implementation on real data,
  benchmark table (cold/warm, 1-thread vs N), full existing unit-suite green against the mixed
  engine, deployed + soaked on this machine before the next phase starts.
- Per the standing phased-execution rule: report at each phase boundary before starting the next.

## P1 benchmark table (real store: 5.5M spans, 31 segments, 240,729 api_requests — 2026-08-18)

| Path | Wall | CPU | Notes |
| --- | --- | --- | --- |
| TS scan, all history (pre-index, the incident) | 32.7s | ~100% one core | per call, minutes of pegged core under load |
| TS + sidecar index, all history ([[TRDD-7I5805QM]]) | 3.9s | one core | sealed days cached, live day parsed per call |
| **Rust `alscan`, all history** | **1.1s** | **667% (14 threads)** | whole store, cold sidecar-free |
| End-to-end `get_cache_event_log` window 0 (live server → alscan) | 3.5s | — | includes bodies scan + MCP round-trip |
| End-to-end `get_cache_event_log` default 24h | 0.69s | — | segment day-selection skips sealed history |

## Acceptance (whole card)

- [ ] No `/api/*` or MCP consumer changed; dashboard unmodified; existing data dirs readable.
- [ ] Every previously-measured single-core incident class has a benchmark proving multi-core or
      indexed behavior in the Rust core.
- [ ] TypeScript remaining in the repo serves only the UI (and, temporarily, the CLI shell).

## Approval log

- 2026-08-18T17:00:52+0200 — Card authored at `todo` under the USER's explicit goal directive.
  Immediate mitigations already landed separately: [[TRDD-7I5805QM]] (call-events index + DuckDB
  machine-scaled threads; all-history 32.7s-per-call → 3.9s indexed).

## Notes and lessons learned
