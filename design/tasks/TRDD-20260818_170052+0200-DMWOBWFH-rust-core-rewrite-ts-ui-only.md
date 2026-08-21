---
trdd-id: DMWOBWFH
title: Rewrite the server core in Rust with optimized SQL — TypeScript remains only for the UI
column: dev
created: 2026-08-18T17:00:52+0200
updated: 2026-08-21T05:03:22+0200
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
- **P5e DONE (commit eaec1b4) — persisted offsets + cards, byte-compatible with the TS delta
  logs.** `delta_log.rs` (= src/store/deltaLog.ts: snapshot+delta NDJSON, zero-byte unchanged
  save, verified compaction, torn-tail tolerance) + `log_reader::DurableState` (= the server.ts
  restore/save: `log-sessions`/`log-offsets` logs + `log-delta-version.json`, stripped cards,
  ino/size-checked offset import, 60s/5min cadences, flush on stop). LOG_INGEST_VERSION=7 is
  pinned to src/collectorState.ts by a test that reads the TS source. Cross-engine PROVEN on
  this machine: alcore booted on a copy of the live TS server's logs → 22,272 cards + 13,528
  offsets restored, 7 changed files swept in 379ms; Rust→Rust restart 2 files in 167ms.
  Gotcha that cost a cycle: `stat.mtimeMs` must be Node's exact `sec*1e3 + nsec/1e6` float —
  `as_secs_f64()*1000` differs in the last ulp and re-parsed 3,345 unchanged files. 72/72.
  NOT ported (cutover-irrelevant or later): the legacy whole-file `log-sessions.json` /
  `log-offsets.json` migration (this machine migrated long ago; a fresh install has none), the
  `persistStats` counters (land with `/api/server-stats`), the collector-lifecycle file.
- **P4h DONE (commit 41eda20) — CORRECTION: the served summary window is the standalone
  server's 24h `spans` array, not the 5-minute SessionStore.** `sessionStore.ts` (P4d.7's
  port) is the VS-Code-era otlpCollector's window — the standalone server never uses it;
  server.ts summarizes over `spans` = `spanStore.loadRange(now − summaryWindowHours, ∞)` at
  boot (default 24h, config.json/env, 5-min floor), appended by ingest, pruned by the span's
  own timestamp on the 5s flush tick. Ported as `SpanStoreWriter::load_range` (+`stats`) and
  `span_window::SpanWindow`; `CoreState::open(data_dir)` boot-loads it; `prune_window` on the
  tick. Live over a copy of the real store: 55,830 spans / 24h → 123 OTEL sessions; the 2
  comparable TS OTEL cards identical. 74/74. **SUPERSEDED — do NOT carry forward:** "P4d —
  SessionStore 5-min rolling window is the engine behind /api/summary" (P4d STATE entry above)
  — true of the collector class, false of the served surface. `session_store.rs` is now unused
  by CoreState (kept for its parity test; delete it when the TS VS-Code path goes, or sooner if
  nothing ports `injectSpanAttribute` through it — the standalone gen_ai injection is the
  store OVERLAY, segmentedSpanStore.applyOverlay, which is NOT ported yet). NOT ported: the
  V8 heap/rss-pressure halving of effectiveWindowMs (a Rust-native guard belongs with the
  resource monitor).
- **P4i DONE (commit 3109086) — `GET /api/server-stats` behind the frozen §1.4 key order.**
  `server_stats.rs` (+ `retention_config.rs`: the ONE env > config.json > default knob resolver,
  now also behind the summary window). Measured: pid, package.json version (compile-time embed),
  startedAt/uptime, bound ports + canonical, dataDir, rss (proc_pidinfo / /proc), window + store
  + pendingAppends, logSessions, persistence counters (span flushes via the ONE
  `CoreState::flush_spans`; offsets/cards in DurableState saves), delta-log disk sizes,
  hook-event/log-event bucket usage, body-archive usage, hook-spool count, hook runtime config
  (`hook-config.json`), resource sample (loadavg/statvfs/cpus). **NOT PORTED (TS idle values,
  each marked `NOT PORTED:` in the file):** V8 heap (0/0), hook/log-event/statusline sinks,
  admission, gate counters, OTLP log-event gate map, fallback counters, spool (null).
  `windowMs == configuredWindowMs` (no heap-pressure halving). Tests: `tests/server_stats.rs`
  (§1.4 order transcribed literally, JS number shapes, fixtures, counters move). Live vs the
  running TS server: ordered key shape identical for all 108 entries except the spool (TS has a
  spool mount here; Rust null). 76/76. Gotcha: `loadavg`/`statvfs`/`proc_pidinfo` need the
  direct `libc` dep (already in the lock via tokio).
- **P5f DONE (commit 5d1451f) — the notify-based log watcher + debounced targeted sweep, 60s
  full backstop.** `discovery::watch_dirs` (getWatchDirs), `discovery::LogRoots::classify`
  (_agentKeyForPath), `discover_opencode`; `LogTailer::sweep_paths` (_scanPaths) and the ONE
  per-file gate `process_file` shared with the full sweep; `start_sweeper` attaches one
  recursive `notify` watcher per root BEFORE the boot sweep, coalesces events per 300ms burst,
  runs the targeted sweep, and the full sweep every `FULL_RESCAN` (60s) — or every 5s when 0
  watchers attached (TS fallback). Unnamed event / watcher error ⇒ next sweep promoted to full.
  **Gotcha (cost a failing test):** FSEvents reports the CANONICAL path (`/private/var/…`) while
  discovery spells the configured root (`/var/…`) — events are rebased onto the configured
  spelling in `attach_watchers`, or the classifier disowns every event. Proof: parity test (card
  advances in ~0.9s with the backstop pinned at 1h) + live over 13,540 files: this session's
  card advanced within 4s of the write; steady-state CPU ≈1%. 77/77.
- **P4j DONE (commit 8fdbd95) — small frozen routes: rows 1, 10, 11, 16, 22, 25.** embed-status
  (keyless: standalone/null/false + Vary; embed key NOT PORTED), hook-config GET/POST (the TS
  `hookRuntime` let is `CoreState.hook_runtime`; save = merge/coerce/junk-gateMode-keeps-current/
  tmp+rename; server-stats `gate` reads it), `/action clearAll` (`CoreState::clear_spans` →
  `SpanStoreWriter::clear` unlinks segments+index), `/api/clear` (`clear_all` → `Msg::Clear` to
  the sweeper via `SweeperControl`; tailer forgets, FULL sweep from 0), log-scan-stats
  (`CoreState.log_scan` cumulative counters; derived caches/scratch listing NOT PORTED → zeros).
  Tests over a real socket + the watcher test extended with clear→full-resweep. 78/78.
- **P4k DONE (commit d7fc039) — `POST /api/import` (row 3).** `import_card.rs`: the private
  server.ts builder transcribed key for key (no executable oracle — it is not exported; the
  expected card is a literal in `tests/ui.rs`), the drop/skip/import accounting, both 400
  shapes, 64MB cap. 79/79.
- **P5g DONE (commit ba1053e) — the P5b perf notes.** (a) `derived_cache.rs` (VersionedCache,
  Arc-shared) behind `build_session_summary`/`build_stripped_summary`; `/api/summary`, the SSE
  connect frame and the push all memoized by data_version; log-scan-stats derivedCaches real.
  (b) **CORRECTION of the P5b perf note:** the boot-scan peak was the WHOLE-FILE `fs::read` in
  the parsers (14 workers × their entire file; 30 files >50MB on this machine), not the
  timelines — measured 4.13GB default vs 3.04GB with minimal caps. `for_each_json_line` streams
  (one line buffer): allogscan 4.13GB → 1.77GB peak, same wall time; alcore boot peak 1.30GB,
  post-boot RSS 651MB (was 1.5GB); card-by-card diff of the live snapshot vs the pre-change one
  = growth + hot-tier churn only. **SUPERSEDED — do NOT carry forward:** "skip timeline
  retention for cold files" (~25% at best, derivation-parity risk; dropped). 79/79.
- **P5c DONE (commit 87de364) — accountId registry + generated-files attach.**
  `account_registry.rs` (CallBodyRegistry's account half, fed by process_logs account_pairs in
  ingest_post; ingest_scanned stamps `accountId` LAST iff the sessionId is known) +
  `generated_files.rs` (resolver, realpath-deduped tmp roots, bounded BFS indexer, mtime-gated
  listing cache — scratchListing on log-scan-stats now real — and attachGeneratedFiles in
  finish_transcript, parent only, after the hot-age strip ≡ TS order). The ORACLE now covers
  generatedFiles (generator DEFERRED shrank to accountId; expected JSON regenerated, gains the
  deterministic missing ref). NOT ported: the body-POINTER half (record/resolveRequest — the
  call-context drill). 81/81.
- **P5h DONE (commit 4371920) — session_store.rs deleted** (+ its parity test and 3 fixtures;
  all recoverable at 03089ee). Zero references remain; 80/80.
- **P4l DONE (commit 529b5c6) — the store's gen_ai read-time OVERLAY.** inject_span_attribute /
  apply_overlay on SpanStoreWriter (always-true, cap 500, in-memory only, applied at load_range,
  cleared by clear()); ingest_post's logs closure is real (was `|_,_,_| false`). Verified both
  arrival orders; the LIVE window copy stays bare in BOTH engines (read-time-only — the property
  behind TS's /api/debug/span-attr); persisted lines untouched. 81/81.
- **P4m DONE (commit 5a042e8) — the hook-event store + lifecycle mapping (rows 6–8).**
  `hook_events.rs` = ndjsonBuckets (append-only daily buckets) + hookEventStore (verbatim
  records, newest-first bounded reads) + lifecycleEvents (the pure mapping; STOP/SESSION_END
  default-excluded). POST/GET /api/hook-events + GET /api/lifecycle-events;
  persistStats.hookEventWrites/Bytes + hookEvents.receivedSinceBoot + totalBytesWritten real.
  NOT PORTED (module header): the spool drain + durability verify, StopFailure calibration, the
  recent-events ring, the statusline STORE (routed:"statusline" answers frozen, sample drops).
  82/82.
- **P4n DONE (commit 767dfd9) — write-prompts-file + branch-dump (rows 17–18).** Fire-and-forget
  journal (always 200 empty) + the gated dump writer (existing-project-dir gate, sanitized
  single-segment names, resolved-parent assert, malformed ids skipped, whole-handler 500 on
  parse). Gotcha caught in-flight: `ls <glob>` litter check lied (unmatched glob lists the CWD —
  the standing rule); `find` proved zero litter. 83/83.
- **P4o DONE (commit a17fe11) — /api/debug/requests + the request ring (row 26).**
  `request_log.rs` (500-row ring + rotating `requests.log`, rssMb real per row, heap the honest
  no-V8 zeros); every UI/API response recorded at construction (SSE row = the connect frame,
  noted). 84/84.
- **P4p DONE (commit df84cf8) — the debug seams** (codex-store-groups; span-attr `{found,value}`
  through a fresh windowed read — P4l's overlay observable over the wire). 85/85.
- **P4q DONE (commit 1f59b9c) — GET /api/timeline/<id> + /api/collector-gaps (rows 29–30), and
  the collector lifecycle is PORTED (not the idle-[] shortcut).** `collector_lifecycle.rs` =
  collectorState.ts' lifecycle half (Value-kept runs — the TS loader preserves unknown keys and
  filters per-run; typed serde would do neither); alcore boot start marker + 30s heartbeat +
  graceful-stop marker; BOTH SSE frame sites now pass real gaps (build_update_payload always had
  the field). Timeline = resolveSessionCard: summary lookup → reparse-on-demand
  (`log_reader::reparse_session` — route-side fresh parse; the tailer is deliberately untouched:
  sweeper-thread Rc/!Send, and its offset state stays valid for a fully-consumed file) → the
  TRDD-5GFSFX0Q graft off the new `CoreState.otel_attribution` side-map (rebuilt inside the
  memoized summary compute, same data_version; graft AFTER put_log_session so the stored card
  stays pure). PARITY NOTE kept on record: the parse-time hot-age strip applies to the reparse
  in BOTH engines — a >24h-idle session drills to an empty timeline in TS too; do not "fix" it
  on the Rust side alone. `CoreState.log_env` is a field so tests point discovery at a fixture
  home without racing the process env. NOT PORTED: statuslineReader.overlay on the reparsed
  card (statusline store, P4m note); the lifecycleCorrupt fallback counter. 91/91 (85 + 3
  lifecycle unit + 3 socket tests), clippy delta zero, live-curl'd both routes on a scratch dir.
- **P4r SIZED (2026-08-20): the burn subsystem fans wider than its 3 routes.** Row 24
  /api/burn-status = enrichBurnStatus(computeBurnStatus(gatherBurn(), burnConfig, now,
  currentTtlContext())): burnMonitor.ts 1093 (pure) + gatherBurn/consumption plumbing
  (server.ts:1472–1680) + ttlContext.ts 118 (reads accountInfo + env) + labelBurnStatusAccounts
  (mcpServer.ts) + residentBlobs (compositionIndex — its OWN subsystem, defer/nullable). Row 12
  /api/burn-risk = burnGuard.ts 302 + bodiesActivity.ts 377 + causingToolCall.ts 246 +
  lastBurnStatus (the 4s tick cache). Row 13 /api/agent-gate = agentGate.ts 598 +
  shared/imageReads 25. Sub-slicing like P4d.
  **P4r.1 DONE (commit 8e5d231): burn/cache_ttl.rs + burn/keep_warm.rs, TS-oracle parity EXACT**
  (gen-keepwarm-expected.mjs, 16 cases + 5 kind cards — all regime branches, cold/warm/neither,
  the falsifier incl. off-matrix >1h survival, unsorted timelines, dropped bad timestamps).
  Reports emit as Value literals; regime is a typed struct with to_value(). 92/92.
- **P4r.2 DONE (commit 0233a4b): burn/monitor.rs ports the WHOLE burnMonitor.ts, TS-oracle
  parity EXACT** (gen-burnmonitor-expected.mjs: 6 config cases, the 8-event merged stream, two
  full computeBurnStatus runs — all 4 alert rules + pooled-observed suppression + cost-based
  capacityExceeded — 5 session-status selectors, premature-end snapshot; deep-diff test names
  the first diverging path). TWO HELPER LAWS pinned the hard way: **js_to_fixed_num is exact
  toFixed via m×2^e integer rounding** — the ×10^f float shortcut misrounds (1.86805@4) and
  Rust {:.f} breaks ties to EVEN where JS goes AWAY (0.125@2); and **js_math_round =
  (x+0.5).floor()**, not f64::round (negative halves). to_locale_en moved to helpers (shared
  with loop_detector). 93/93.
- **P4r.3 DONE (commit 162f153): ttlContext + accountInfo + GET /api/burn-status (row 24) +
  the 4s burn tick.** `burn/ttl_context.rs` (stripe_subscription CONTAINS-match; usage-credits
  = opt-in AND pct≥100; overrides from process env ⊕ settings.json env block),
  `burn/account_info.rs` (identity from ~/.claude.json; keychain plan opt-in + once-per-process
  OnceLock latch — the no-reprompt safety is process-global; parse_subscription_type the
  token-free choke-point), `burn/runtime.rs` (BurnRuntime: config + lastBurnStatus + 60s slow
  cache; enrich = labels ⊕ currentAccount ⊕ residentBlobs). PARITY QUIRK KEPT: accountLabelFor's
  loose `== null` labels the unknown bucket with the CURRENT account. CoreState.live_burn_status
  (statusline billing NOT PORTED — empty); ui.rs row-24 route (200 always) + run_burn_tick (4s;
  macNotify + account-state sampler NOT PORTED); alcore spawns it. Oracle
  gen-ttlaccount-expected.mjs + a socket test on a scrubbed env + fixture home (labels,
  currentAccount, residentBlobs [], no token-shaped field). Live: route + a burnStatus SSE
  frame within one tick. 95/95.
- **P4r.4 DONE (commit 58e64ed): bodiesActivity + causingToolCall + GET /api/burn-risk (row
  12).** `burn/bodies_activity.rs` (write-once names make readdir-only-unseen EXACT; the bounded
  6KB head/tail attribution via hand scanners; the previous_message_id chain; the per-SOURCE
  thrash rule with BOTH field-fix invariants — the unattributed pool can never flip `active`
  (TRDD-THRGX41P), and a different-model suspect is filtered while unknown-model stays).
  `burn/causing_tool_call.rs` — **DELIBERATE ENGINE DIVERGENCE, documented in the module head:
  the TS needs DuckDB only because JS cannot parse ~2GB transcripts; Rust streams NDJSON
  natively, so `duckdb-unavailable` ceases to exist as a reason.** Torn-line disclosure kept and
  keyed on `type` not `timestamp` (the TS measurement: timestamp missing from 16.9% of 482,993
  real records). `burn/guard.rs` = checkBurnRisk (6 rows, each stating its quiet measurement) +
  attachRiskCausingCalls + defaultBodiesDir (spool-first). Oracle BUILDS a committed fixture
  tree both engines read; Rust deep-equals tracker report, warm-since, sender formatting, usage
  extraction, the 6-active risk report, causing calls, composition, slugs. 96/96, zero new
  clippy, burn-risk curl'd live.
- **P4r.5 DONE (commit ea4ee58): POST /api/agent-gate (row 13) — the burn subsystem is
  COMPLETE.** `burn/agent_gate.rs` ports agentGate.ts + imageReads.ts + the server glue
  (env thresholds, resolveCallerTtlKind, buildGateState, the advisory dedupe map); the route in
  ui.rs is FAIL-OPEN verbatim (allow → 204; the three 200 hookSpecificOutput shapes; every
  error → 204; 1MB overflow destroys the socket). **Port design worth reusing: the gate STATE
  is a serde_json Value mirroring the TS literal, evaluators read it with JS access semantics —
  so ONE committed 60-case list (agentgate-expected.json) drives BOTH engines, reason strings
  byte-exact.** Transcript fixtures carry PINNED mtimes in the JSON (git clobbers mtimes; the
  Rust test re-pins via std FileTimes before reading). Landed with it: the in-memory
  recentHookEvents ring (boot-seeded, 600→500 cap), real gate counters on PersistStats (both
  server-stats sites — were hardcoded 0), the bodies poll folded into the 4s burn tick
  (buildGateState stays read-only on the hot path — TRDD-9CNHP8CN), advisory_issued + prune on
  CoreState. Kept verbatim: keep-warm pinger NEVER denied (USER order 2026-07-11); THRASH
  denies forks / warns fresh (TRDD-THRGX41P); SendMessage denies need positive DEAD evidence;
  own-project matches session BEFORE cwd (worktree fan-outs). 98/98, zero new clippy, live
  alcore smoke (204/204/200-deny + counters).
- **P4s DONE (commit 77cd818): the bodies admin routes — rows 14–15.** `body_archive.rs` ports
  the WAD READER half (index load w/ torn-tail skip, random-access gunzip, windowed extract
  with restored mtimes) + exportBodiesFromStore + verifyVolumeInStore; the WRITER stays
  TS-owned (one WAD implementation is the format's own law). Purge = the TRDD-K3WDPR7M gate
  through agentlens-store's bulk verify, chunked at 128MB raw with ONE SpanCache across chunks;
  failure-reason TEXT follows the Rust store's wording (the /api/import precedent — status and
  shape are the contract, diagnostic text is not). Routes run on the blocking pool, never under
  the state lock; agentlens-core now DEPENDS ON agentlens-store (the endpoints ARE store
  operations; the pass alone stays an alstore exec). Parity cross-engine by construction: the
  committed fixture volumes are WRITTEN by the compiled bodyArchive.js, the Rust reader must
  reproduce listing+extract byte-identically (bodyarchive_parity.rs); the socket test drives
  export (combined shape, skip-existing, three 400 guards) and purge (proven July volume
  removed + .idx retained; unproven August kept, failures named). 100/100, zero new clippy,
  live smoke incl. fail-safe purge on an empty store (nothing deleted, every lump named).
- **P4t DONE (commit 6871ebf): the instruction routes — rows 19–21.** `instruction_advisor.rs`
  (pure Value-card analysis, all five generators; scope patterns use `(?-u:\b)` — the ASCII
  boundary a non-/u JS regex implies; the cost-ratio evidence rides the ported pricing table,
  already proven equal by pricing_parity) + `instruction_files.rs` (detection with the
  primary-then-alternate probe + create affordance, the dated-marker append, resolve_lexical
  for the escape guard; removeSuggestion NOT PORTED — zero consumers, verified by grep).
  Routes: both GETs PREFIX-match with the shared workspace 400 and BARE-array bodies; apply
  keeps the allowlist + escape 400 verbatim (an append path outside it is ~/.zshrc-class code
  execution). Oracle: 4 committed cases (rich set trips every generator, 7 suggestions)
  Value-equal first run; the socket test closes the whole loop (seed → suggest → apply →
  absorbed → detected). 103/103, zero new clippy, live smoke green.
- **P4u DONE (commit 27d2e49): the statusline store + POST /api/statusline-samples (row 5) —
  the FULL store port, not just the append slice.** `statusline_store.rs`: WAL-then-seal,
  flatten-with-arrays-kept, one-fsync-per-batch + front-re-buffer, live-WAL rotation,
  verify-before-delete, the inference-collapse refusal, the per-file VARCHAR session_id
  repair, guaranteed-columns template, partition slack, malformed-name purge gate, and the
  READ half (query_statusline). DuckDB via agentlens-store's new `pub use duckdb` re-export
  (one bundled build; JSON extension probe-verified). Non-ports recorded: walRows (write-only
  in TS — dead), the sealing latch (one 60s task), StatuslineUsageAgg. Wiring: flush on the 4s
  tick; SEALING on alcore's own 60s blocking-pool task sharing only Arc'd counters — never the
  state lock; boot purge; exit flush. The legacy hook-events divert now LANDS samples; the
  server-stats statusline section + statuslineSamples counter are real. Parity: the committed
  fixture store is TS-written AND TS-sealed — the Rust reader answers identical rows over the
  parquet+WAL union (UUID repair + guaranteed-NULL columns exercised); round-trip + collapse
  + purge tests; socket test. 107/107, zero new clippy, live smoke green.
- **HTTP route audit (2026-08-20, grep of freeze §1 vs ui.rs): 8 of 36 rows remain** — row 9
  `/api/cache-risk-commands`, row 31 `/api/generated-file`, and the six per-session drill-downs
  rows 32–37 (`composition|history|conversation|callcontext|composition-index|block-content`,
  all heavyGuard, all riding src/contextComposition*/contextHistory/conversation/
  rawBodyContext — ONE subsystem cluster over transcripts + raw bodies). Everything else in §1
  is live in alcore.
- **P4v DONE (commit 2c0f7f3): rows 9 + 31.** `cache_risk_commands.rs` (the transcript scan —
  NOT hook events, that was this STATE's own mistake; ConfigChange is REFUTED as a reload
  signal and the on-disk type:user command block is ground truth; string-content-only gate,
  caveat parser, /plugin verb strip, true-total + full-window byKind) and
  `generated_files::read_scratch_file` (realpath containment ported exactly — the raw-string
  regex alone would be an arbitrary-file reader for any website on this browser-reachable UI).
  Oracle: the committed transcript gauntlet Value-equal first run; socket tests incl. the
  traversal refusal. 109/109, zero new clippy, live smoke green.
- **NEXT ACTION (one step): P4w — the per-session drill-down cluster, rows 32–37.** Sized
  2026-08-20: contextCompositionIndex.ts 716 (THE SPINE — read it first),
  contextComposition.ts 276, contextHistory.ts 383, conversation.ts 354, rawBodyContext.ts
  378; all six routes heavyGuard'd, all read transcripts + raw bodies. Slice it: P4w.1 the
  index (rows 36–37, /api/composition-index/:id + /api/block-content/:id/:turn/:idx), P4w.2
  the three transcript views (rows 32–34, composition/history/conversation — each
  `{<name>:<obj>|null}`, null also on parse failure, still 200, ?parent= fallback), P4w.3
  callcontext (row 35, rawBodyContext over the bodies dir). heavyGuard itself is a NOT-PORTED
  admission deferral (no V8 heap to guard) — record per route. After P4w the HTTP §1 table is
  COMPLETE; what remains of the freeze is the MCP tool surface (§3) + preamble deferrals.
  **P4w.1 READ FINDINGS (contextCompositionIndex.ts + rawBodyContext.ts read IN FULL
  2026-08-20, pre-compaction):** the LOAD-BEARING dependency is `callBodyRegistry` — the
  in-memory pointer index (LRU 200 sessions × 400 ptrs; `record/resolveRequest/sessionIds/
  requestPointers/responseFor` + the account half) fed by the OTLP logs ingest's
  api_request_body / api_response_body events. The Rust core has ONLY its account half
  (CoreState.accounts); agentlens-ingest's process_logs already RETURNS `body_pointers` as
  data (P3b) but lib.rs::ingest_post currently uses only `account_pairs` — so P4w.1 step one
  is a `call_body_registry.rs` port + wiring those returned pointers into it. Then
  `raw_body_context.rs` (buildCallContextFromJson — pure over parsed JSON, block order
  system → toolCatalog → messages, IMAGE_BLOCK_LABEL_PREFIX contract, BLOCK_TEXT_CAP 20000
  with tokens counted on FULL text, tool_result inherits toolName via tool_use id map,
  parseUserId), then tokenEstimator's countTokens/calibrateTokens (check what of it is
  already in Rust — estimate_tokens_from_bytes exists in generated_files.rs), then the index
  (LRU 64, scope cap 25, buildCallComposition + windowSizeFor — window from the PRICING
  table + the context-1m beta UPWARD-ONLY refinement — readResponseUsage 8MB cap,
  aggregateResidents, sessionCompositionSummary with peak-call breakdown + top-15 resident
  rows + findSample) and the two routes. The five query/report methods (imageReport,
  findResidentBlobs, queryBlocks, getSession, getBlockContent) also back MCP tools — port
  them with the index, the routes only need summary + block-content.
- **P4w.1a DONE (commit 3f357ba): `call_body_registry.rs` + THE INGEST EDGE.** The pointer half
  of CallBodyRegistry (IndexMap for the JS-Map-insertion-order LRU; `shift_remove` never
  `swap_remove`; account half deliberately NOT re-ported — `account_registry` already owns it).
  **The real defect fixed: `ingest_post` consumed only `account_pairs` and DROPPED
  `body_pointers` on the floor, so every drill-down would have resolved an empty registry and
  reported "no bodies" — indistinguishable from the honest empty state.** Parity oracle: one
  scripted op/query sequence, caps 3×4 so both eviction paths INTERACT (three answers are the
  resolveRequest fallback because eviction removed the obvious match — a hand-written
  expectation gets those wrong); plus a second test driving the REAL `ingest_post` to prove the
  edge is live. 111/111, clippy 28 (baseline), identities green.
- **NEXT (P4w.1b): `raw_body_context.rs`** — `buildCallContextFromJson` (PURE over parsed JSON:
  block order system → toolCatalog → messages; `classifySystem` regexes for claudemd/rule;
  `flattenResultContent`; tool_result inherits toolName from an earlier tool_use via an id map;
  `IMAGE_BLOCK_LABEL_PREFIX = "image"` so the composition index re-classifies images WITHOUT a
  re-parse; `BLOCK_TEXT_CAP = 20000` with tokens counted on the FULL text pre-cap, `uncap`
  lifting it for a single-block drill; `MAX_RAW_BODY_BYTES = 64MB` size gate) + `parseUserId`.
  **READ FIRST, not yet read: `src/tokenEstimator.ts`** — `countTokens` and `calibrateTokens`
  (the latter called as `calibrateTokens(raw, exactContext, {minScale:0.2, maxScale:5})`) are
  its exports and the composition index's calibration depends on them exactly; `rawBodyContext.ts`
  lines ~270-378 (the messages-loop tail + `resolveCallContext`) are also still unread.
- **P4w.1b(i) DONE (commit 4c62695): `token_estimator.rs`.** countTokens + calibrateTokens
  ported; tokenEstimator.ts is now fully read and needs no revisit. **UTF-16 LAW pinned by the
  oracle** (`'a🎉b'` = 3 — an astral char is TWO code units, both `Other`; `chars()` diverges).
  calibrate's refuse-band and fold-into-FIRST-largest residual are verbatim.
  `estimate_tokens_from_bytes` is RE-EXPORTED from generated_files (layout divergence from the
  TS, stated in the module head) rather than redefined. 114/114, clippy 28, identities green.
- **P4w.1b(ii) DONE (commit eeb9f31): `raw_body_context.rs`.** `buildCallContextFromJson` +
  `parseUserId` ported. **`src/rawBodyContext.ts` is now READ IN FULL (all 378 lines)** — no
  revisit needed for the remaining wrappers, whose contracts are captured in the next bullet.
  Oracle `gen-rawbodyctx-expected.mjs` → 9 user_id + 38 body cases, all DISCRIMINATORS.
  Three contract points a plain reading gets WRONG, each now pinned by the oracle:
  (a) `JSON.stringify(tu.input ?? {})` is NULLISH — an explicit `"input": null` becomes `{}`,
  NOT the string "null"; the first cut of the port passed Value::Null straight through, which
  shifts that block's text+bytes+tokens. (b) `src?.media_type ?? 'unknown'` is nullish AND
  template-interpolated, so a non-string media_type STRINGIFIES into the label —
  `as_str().unwrap_or("unknown")` silently relabels it. (c) tokens counted on FULL text, cap
  applied AFTER, cap counts UTF-16 CODE UNITS (oracle's 20050-char multi-byte case: tokens 4266
  either way, bytes 40000 capped vs 40100 uncapped).
  **Key order is asserted EXPLICITLY, never via `assert_eq!` on two Values** — under
  `preserve_order` a `Value::Object` is an IndexMap whose `PartialEq` IGNORES order, so a value
  comparison passes on a reordered wire object and leaves the ordering contract untested. That
  trap applies to EVERY parity test in this port, not just this one.
  Non-vacuity PROVEN: mutating fix (a) back out fails at `case[24].blocks[2].bytes`.
  116/116 (+2), clippy 28 = baseline, identities green, alcore boots clean.
- **P4w.1c(i) DONE (commit f1d30c1): `build_call_context` — the FILE wrapper.** 64MB gate, every
  failure soft-returns None. **Node's `readFile(path,'utf8')` decodes LOSSILY** (invalid bytes →
  U+FFFD, parse still succeeds), so the port uses `from_utf8_lossy`; `read_to_string` would return
  None exactly where the TS returns a context, and NO fixture of valid JSON would ever catch it.
  Oracle drives both engines over the same committed fixture files under `tests/fixtures/bodies/`
  (absent / a directory / truncated mid-write / valid-JSON-but-not-an-object). The 64MB gate is
  asserted as a CONSTANT on both sides — a >64MB fixture costs more than the one `>` it proves.
  118/118, clippy 28, identities green.
- **P4w.1c(ii)a DONE (commit b1e1c04): the composition CORE.** `context_composition_index.rs` —
  `window_size_for`, `read_response_usage`, `classify`, `build_call_composition`,
  `read_block_content`, `cost_of_cache_read`. **`src/contextCompositionIndex.ts` is READ IN FULL
  (716 lines)** — the remaining half needs no re-read, its contract is in the next bullet.
  Three traps pinned by the oracle: (a) the 1M beta is PROOF but its ABSENCE proves NOTHING —
  fable with `betas: []` is still 1M **from the pricing table**; an if/else here reported a 645k
  context as 323% of 200k. (b) `typeof [] === 'object'`, so an ARRAY `usage` passes the TS guard
  and yields an ALL-ZERO usage — rejecting it returns null, a different call total. (c) the call's
  `tokenSource` is NOT `cal.source`: with exact usage but a refused calibration the blocks stay
  `estimated` while the call is `exact`. Non-vacuity proven by mutation (fails at
  `buildCallComposition[1].tokenSource`).
  **Oracle PINS TIME** (`generatedAtMs` → Rust `now_ms`): TS resolves rates at "today's rate", so
  an announced rate change would otherwise fail this test on a day nobody touched the code.
  **Fixture paths are stripped to bare filenames on BOTH sides** — `bodyRef` is absolute and would
  bake a home dir into a committed fixture (check-identities fails on that, correctly).
  123/123, clippy 28, identities green.
- **P4w.1c(ii)b DONE (commit 49c85c2): session aggregation + the LRU index.** `aggregate_residents`,
  `summarize_images`, `build_session_composition`, `session_composition_summary`, `resolve_refs`,
  `ContextCompositionIndex` (LRU). Three claims PROVEN rather than asserted: (a) the IndexMap
  tie-break is genuinely exercised — the fixture carries **3-way ties on both sort keys**, and
  `sess-rich` vs `sess-gap` order their ties DIFFERENTLY, so a HashMap port fails (a tie-free
  fixture would have proven nothing); (b) `callsTotal` counts REFS, `calls` holds only what parsed
  — asserted directly (sess-gap: 3 refs → 2 calls) so nobody "fixes" the gap that IS the coverage
  signal; (c) `model`/`accountUuid` are FIRST-wins — a last-wins mutation fails on both sess-rich
  and reg-sess. The summary oracle drives the REAL lazy path (pointers recorded into the registry
  → `request_pointers`/`response_for`), not hand-built refs. 126/126, clippy 28, identities green.
- **P4w.1c(ii)c DONE (commit 89a3734): FREEZE ROWS 36-37 LIVE.** `/api/composition-index/:id` +
  `/api/block-content/:id/:turn/:idx`, plus `CoreState.composition` (the LRU). The lock
  choreography is now STRUCTURALLY enforced by where the guards drop: resolve refs under the lock
  → RELEASE → parse on `spawn_blocking` → re-lock only to `put`. **`Number(parts[i])` mirrored
  quirk-and-all**: a MISSING segment is NaN → 400, but an EMPTY one is `0` and PASSES
  (`Number('') === 0`) — `"".parse()` would 400 a request the TS answers 200, a silent wire break
  on a frozen surface. The two not-found shapes stay DISTINCT and both stay **200** (no-pointer
  carries NO `blockIndex` key; no-block DOES) because the UI must tell them apart. `heavyGuard`
  NOT ported (V8-heap admission deferral; no V8 heap here, work already off the executor).
  127/127, clippy 28, identities green, live alcore serves both routes with no panics.
- **P4w.2a DONE (commit 736127e): `context_composition.rs` + FREEZE ROW 32 LIVE.**
  `src/contextComposition.ts` READ IN FULL. Streams the session `.jsonl` (multi-GB routine) on
  `spawn_blocking`, Env cloned out from under the lock. **The oracle caught a REAL divergence:
  Node's `path.basename` is PLATFORM-DEPENDENT — on POSIX it splits `/` ONLY, so a Windows-style
  path comes back WHOLE.** Splitting both separators looks more correct and silently relabels every
  such source; only Windows cuts backslashes. Other pinned coercions: assistant DEDUP (a re-emitted
  `message.id` must NOT advance the turn; a NO-id entry always does), `hookName ? :` is TRUTHY so an
  empty one → `hook: unknown`, the file-name chain is NULLISH so an empty `displayPath` IS used
  (the `file: ` label is correct), `addedBlocks || addedNames` falls through on empty, a 0-byte
  attachment is dropped, and the excerpt budget `max(1, Number(env) || 16)` treats ZERO as unset.
  `sources` is an IndexMap (stable-sort tie order); the `+N more sources` fold carries NO excerpt.
  132/132, clippy 28, identities green.
- **P4w.2b DONE (commit 542b240): `context_history.rs` + FREEZE ROW 33 LIVE.**
  `src/contextHistory.ts` READ IN FULL. **The CALIBRATION ASYMMETRY is the module's core decision:**
  OUTPUT blocks fully account for the turn's output → calibrate at ANY scale; INPUT blocks are only
  the NEW input, legitimately excluding the cached prefix and implicit system prompt → target is
  `input + cacheCreate` (**never cacheRead**, the reused prefix) and only inside a **[0.5, 2]** band;
  outside it they KEEP the raw estimate, because scaling would misattribute INVISIBLE tokens onto
  visible blocks. **isMeta is NOT postCompact** — the old `isCompactSummary || isMeta` branch
  mislabeled 300+ cron pings as one ~268k postCompact aggregate (TRDD-W0RRL2FZ). Also mirrored: an
  EMPTY `isCompactSummary` summary FALLS THROUGH to the isMeta branch (no `continue`), `<synthetic>`
  model ignored, duplicate `message.id` opens no new step, tool_result routes three ways.
  `hash_text` ports the 32-bit JS arithmetic but only its EQUALITY behaviour is wire-observable —
  the value never leaves the process. 136/136, clippy 28, identities green.
- **FIXTURE COUPLING — read before adding any transcript.** `list_session_file_ids` indexes the
  WHOLE shared `tests/fixtures/claude-home/` tree, so ANY slice that adds a `.jsonl` there changes
  the row-32 oracle's expected set and fails `ctxcomposition_parity`. That is a STALE ORACLE, not a
  port bug (the assertion message now says so). Fix: re-run `gen-ctxcomposition-expected.mjs`.
- **P4w.2c DONE (commit 62ee82d): `conversation.rs` + FREEZE ROW 34 LIVE.** `src/conversation.ts`
  READ IN FULL. **USAGE IS CREDITED ONCE PER `message.id`** — every streaming chunk repeats the SAME
  numbers, so per-chunk crediting silently MULTIPLIES the session's reported cost, and these totals
  feed cost attribution. Narrative pairing rules: a tool_result pairs back to the ISSUING assistant
  turn (not the user record it arrived in); an ORPHAN result stays VISIBLE on a user turn; a record
  of PURE tool_results must NOT fabricate an empty user turn (lazy open); queued attachments flush
  AHEAD of the turn's own content. `tokens` is TRUTHY-gated (0 → key OMITTED, not `tokens: 0`);
  `<synthetic>` is dropped only when usage sums to ZERO; at compact_boundary `Number(x)` must stay
  distinguishable from NaN (absent → omitted, explicit null → 0 and EMITTED); a turn past MAX_TURNS
  is returned but not kept, yet its toolUse blocks still count toward `totals.toolCalls`.
  142/142, clippy 28, identities green, live alcore serves rows 32/33/34.
- **P4w.3 DONE (commit 82281c1): FREEZE ROW 35 LIVE — the HTTP §1 TABLE IS COMPLETE.**
  **VERIFIED, not assumed:** all **36/36** §1 rows are present in `ui.rs` (parsed the freeze table
  and matched each path, `*` prefix-notation stripped). Note this proves each row is WIRED, not that
  every row is parity-tested.
  **THE ORACLE FALSIFIED A PREDICTION RECORDED IN THIS VERY BLOCK.** I expected an absent `model` to
  be APPENDED by `if (!ctx.model) ctx.model = ptr.model`, landing after `requestId`. **It does not.**
  The TS object literal always DEFINES `model` — as `undefined` when the body named none — so the
  property already exists at its LITERAL position and assignment keeps it there, before `blocks`.
  JSON hides an undefined value; it does not remove the slot. "An absent key appends" is right for
  JS in general and WRONG for a key the literal declared. Our builder omits the key, so the port
  restores it with `shift_insert` at the literal position. `requestId` is genuinely NOT in the
  literal, so it really does land last — the two keys differ for a reason.
  Three model outcomes, ONE code path: real model stays put; EMPTY-STRING model replaced IN PLACE
  (FALSY test, not nullish); no model → slot restored before `blocks`; falsy model + no pointer
  model → key DROPPED (not null, not ""). 145/145, clippy 28, identities green.
- **(superseded prediction — do NOT carry forward)** the earlier note in this block implying the
  resolved `model` key lands after `requestId`. It is wrong; see above.
- **P4x SIZED + P4x.1 DONE (commit 9bb520d): the MCP endpoint.** `src/mcpServer.ts` is **4,018
  lines / 53 tools**, and it decomposes as: **~1,200 lines of pure SCHEMA data** (`TOOLS`, lines
  410-1616), ~2,270 lines of handlers (1617-3890), and a small transport at the tail.
  **THE DECISIVE SIZING FINDING — the SDK transport does NOT need porting.** The TS wraps
  `StreamableHTTPServerTransport`, but the only shipped consumer is our own CLI
  (`src/cli/cliCore.ts`), which sends plain JSON-RPC, **explicitly accepts EITHER SSE or plain
  JSON**, and uses exactly THREE methods (`initialize`, `tools/list`, `tools/call`). So P4x is
  "53 handlers", not "reimplement Streamable-HTTP". Safe ONLY because the MCP server is deliberately
  not registered with Claude Code — if that changes, the transport becomes insufficient.
  **Schemas are GENERATED, never transcribed:** `assets/mcp-tools.json` is produced from the TS
  `TOOLS` array (now `export`ed — the only TS change, no behaviour change) and embedded with
  `include_str!`, so the frozen schema surface is byte-identical BY CONSTRUCTION. Regenerate with
  `pnpm run compile-tests && node rust-core/crates/agentlens-core/assets/gen-mcp-tools.mjs`.
  An unimplemented tool returns an explicit error NAMING it, kept DISTINCT from the unknown-tool
  error — an empty result would read as a working tool that found nothing, the worst failure mode
  for a diagnostic. 146/146, clippy 28, identities green, check-types OK.
- **P4x.2a DONE (commit 8d166f6): the FIRST MCP tool end-to-end — `get_call_context`.** Proves the
  whole chain (schema → dispatch → engine → shaper → content envelope → the CLI's own unwrap)
  before batching the other 52. **FIXED A P4x.1 DESIGN FLAW FIRST:** that slice's tool hook was
  SYNCHRONOUS, but every real tool needs blocking I/O + the CoreState lock — a sync hook could only
  satisfy both by dragging the lock across the I/O (the P4s violation). `route_rpc` now returns
  `Dispatch::Tool` as WORK; mcp.rs is protocol-only and the ROUTE owns async + locking. Paying that
  at one call site beat threading it through 53.
  **THE HANDLER PATTERN, now established — follow it for the rest:** the TS dispatch case is always
  `handleGetX(engineResult, args)` where the engine is injected and the shaper is PURE. So each tool
  = (a) an engine call the route makes, (b) a pure shaper in `mcp_tools.rs`, (c) an oracle driving
  the TS shaper DIRECTLY (export it — `TOOLS` and `handleGetCallContext` are exported already;
  export-only, no behaviour change, check-types green). Driving the pure shaper beats round-tripping
  a live MCP server.
  `resolve_call_context` is EXTRACTED in ui.rs and shared by the HTTP route AND the tool — the TS
  has ONE `resolveCallContext` behind both. Shapers RE-PROJECT (get_call_context drops
  `tokenSource` and imposes its own key order); never pass an engine object through unchanged.
  149/149, clippy 28, identities green, check-types OK.
- **P4x.2b DONE (commit 5f6f1d2): 3 more tools — `get_context_composition` / `get_context_history` /
  `get_conversation`. 4 of 53 served by Rust.** **THE ORACLE CAUGHT A REAL MISPRICING:** the TS
  `cost` closure captures **`card?.model` ONLY**, while the emitted `model` FIELD is
  `step.model ?? card.model`. Passing the merged model to the cost fn PRICES STEPS THE TS LEAVES
  UNPRICED — invisible in any fixture whose card HAS a model, which is why the oracle carries an
  explicit `whole-no-card-model` case. Three bounding rules now pinned by name: composition
  `turnCount` is the UNFILTERED total (a filtered recount reports 1 for every drill); the
  conversation range CLAMPS to `from+cap-1` (a caller cannot widen it by asking for 9999); history's
  block drill is VERBATIM (keeps `tokenSource`) while the step projection DROPS it.
  153/153, clippy 28, identities green, check-types OK.
- **P4x.2c STARTED (commit a80e38a): `get_burn_status`. 5 of 53.** No new shaper — P4r.3 had
  already ported `labelBurnStatusAccounts`. **The trap this slice pinned by name:** the tool serves
  `label_burn_status_accounts`, NOT `enrich_burn_status`. Enrich = label + `currentAccount` +
  `residentBlobs`, and those two belong to the **HTTP row-24 payload only**; reaching for enrich
  because it is "the burn status function" ships two fields the tool never had. The test asserts
  their ABSENCE on the tool payload AND their PRESENCE on `/api/burn-status`, so it fails if the
  two payloads ever converge instead of passing because both happen to lack them. The TS's
  "Burn monitor unavailable in this runtime" branch is unreachable here (the monitor is always
  present) — noted in place rather than silently dropped. 154/154, clippy 28, identities green.
- **P4x.2c (commits 6bd7f32, 8bb327b): `get_session_status` + `get_window_budget` +
  `check_burn_risk` + `get_lifecycle_events`. 9 of 53.** Pass-throughs need only a CoreState method
  (`live_session_status`; `burn_risk_report` now takes the two thresholds as Options). Pinned by
  name: the window-budget `accountId` filter is TRUTHY-checked so `''` means UNFILTERED; its
  empty-result `message` appears ONLY when a filter was actually asked for; `check_burn_risk` FLOORS
  its thresholds (2 / 10k) so a caller cannot switch a risk row off by passing 0; and
  `get_lifecycle_events` carries `dirExists` + a note because an empty `events` list reads
  identically for "quiet" and "hooks never installed" — `count` is 0 for both, so it can never be
  the discriminator. The lifecycle note text was extracted into an exported TS
  `handleGetLifecycleEvents` so the two engines share ONE copy of it.
- **⚠ P4x.2c FOUND AND FIXED A DEFECT IN EVERY TOOL PORTED BEFORE IT (commit 14bc338).**
  `mcpServer.ts` runs **`leanify(result, {verbosity, maxTokens})` at a single choke point AFTER the
  dispatch switch** — invisible from any individual tool's case — so all NINE tools were returning
  RAW engine output: a different, and materially more expensive, wire shape than the TS (a tool
  result is re-sent on every later turn of the caller's conversation). `src/leanResponse.ts` is now
  ported to `lean_response.rs` with a 26-case oracle, and the route calls
  `mcp_tools::tool_ok_lean` — ONE function, so a tool added later cannot opt out by forgetting.
  **THE LESSON: read the code AROUND the dispatch case, not just the case.** A per-tool oracle
  cannot see a transform applied after the switch, and every one of the nine parity suites was
  green throughout.
  **A TS claim measured FALSE and left standing rather than asserted:** leanResponse's "a tool can
  never blow the caller's context, no matter what the data looks like" — at a 60-token ceiling a
  degraded payload settles at 89, because the DISCLOSURE TEXT is the floor and cannot shrink itself.
  Rust reproduces it exactly, so it is a finding about the TS, not a port defect.
- **P4x.2c (commits 2277df2, 1a58db5, 6400db4): `get_account_status`, `get_block_content`, and the
  3 scoped composition tools (`get_image_report` / `find_resident_blobs` / `query_context_blocks`).
  14 of 53.** New module `account_state_timeline.rs` holds `describe_plan` / `describe_account_mode`
  / `resolve_auth_regime_label` — SHARED with the account-state sampler, so one implementation.
  `resolve_block_content`, `composition_for` and `compositions_in_scope` were EXTRACTED from the
  HTTP routes rather than copied, keeping the P4s lock choreography in one place.
  **⚠ A SECOND DEFECT FOUND THE SAME WAY (fixed in 6400db4): the row-36 route built compositions
  with NO project hint** while the TS passes `compositionProjectResolver()`. Every composition read
  `project: "unknown"`, so once the scoped tools landed on top, every PROJECT-scoped query would
  have matched nothing while answering 200 — a wrong answer shaped exactly like a correct empty one.
  Pinned by name: `resolve_scope` checks the EXACT session id BEFORE the prefix (an id is a prefix
  of itself, so reversing them widens a single-session drill silently — mutation-proved);
  `topN` CLAMPS to [1,100] at BOTH ends (0 would return an empty list reading as "nothing
  resident"); the model filter is a SUBSTRING match ("opus" is the obvious query and equality
  returns nothing, successfully); `queryBlocks`'s `filter` is REBUILT from the named fields because
  it is ECHOED BACK — handing it `args` would ship verbosity/maxTokens inside it.
  **NOT PORTED, named rather than faked:** `get_account_status(all: true)` (listAllAccounts) and the
  statusline reader, so `usageWindows.windowSource` reports calibrated/none, never `cc-rate-limits`.
- **P4x.2c (commit 3671d9c): `get_recent_sessions` + `get_workspace_patterns`. 16 of 53.** The two
  tools CLAUDE.md tells every agent to call BEFORE starting work, so they get a deliberately awkward
  fixture. Pinned: "recent" is recently ACTIVE not recently STARTED (the fixture's OLDEST-starting
  session is still running and must rank first — and the test re-runs over a REVERSED input so it
  cannot pass by accident); `active` is ABSENT when idle, never `false`; `limit` has NO low clamp so
  a negative reaches `Array.slice(0,-n)` and drops the LAST n rows (`take()` returns everything,
  `.max(0)` returns nothing — wrong in opposite directions, hence `js_head`); the cache SLI averages
  ONLY cache-measured sessions and LABELS the exclusion; an unparseable `startTime` is `|| 0` when
  RANKING but `NaN >= cutoff` = false when FILTERING — same field, two behaviours.
  `get_workspace_patterns` accepts a `workspace` arg the TS NEVER USES — mirrored, not "fixed",
  because a silent behaviour fork is worse than a visibly inert parameter.
  **Watch out:** the frozen-schema test names one still-unported tool as its "not yet implemented"
  example. Porting that tool makes the endpoint look BROKEN rather than the test look OLD — swap the
  name (now `run_transcript_sql`) when it lands.
- **P4x.2c (commit 4c3a864): `find_relevant_context` + `get_efficiency_report`. 18 of 53.** Both are
  pure over the session cards, so both landed on the EXISTING session-report oracle with the fixture
  EXTENDED (real prompt text to match; a 20-day-old session so the efficiency report's FIRST half is
  non-empty). Pinned: the task tokeniser drops words of ≤3 chars (else "the"/"for" match everything)
  and KEEPS `/ _ .` so a path stays one word; `knownTraps` is an explicit NULL when empty; the cost
  trend has a ±15% DEAD BAND and an EMPTY first half is 'no data', not an infinite increase (the
  test forces both branches from the SAME sessions by moving only the window); the agent ranking
  needs `n >= 2` and sorts ASCENDING by cost. **Deliberate non-unification:**
  `get_efficiency_report` keys its agent map on `${source}/${model || 'unknown'}` while
  `get_workspace_patterns` uses a bare `${model}` — mirrored, not unified, because unifying would
  change one tool's output.
- **⚠ MEASURED GAP: the remaining 35 tools mostly need ENGINES that are NOT PORTED.** Verified by
  grep, not assumed: `subscriptionUsage`, `cacheEventLog`, `skillAttribution`,
  `loadedPluginVersions`, `runtimeInventory`, `costRollup` have NO Rust counterpart. So P4x.2c's
  cheap phase (a shaper over a ported engine) is essentially DONE — what remains is porting engines
  first. Size each one before starting; do not assume the next tool is another thin slice.
- **P4x.2c (commit 8cf8b77): `get_instruction_suggestions`. 19 of 53.** Advisor engine was already
  ported; the shaper's contract is THREE top-level shapes ({error} / {message, suggestions: []} /
  bare array) — the middle one exists because "not enough history yet" and "nothing to suggest" are
  different facts an empty array cannot distinguish. The cache-efficiency suggestion is the SHAPER's
  own (advisor doesn't know it), gated on >= 5 CACHE-MEASURED sessions so junk rows can neither
  trigger nor suppress it. Oracle fixture workspace deliberately nonexistent so
  `readAllInstructionContent` reads '' on both engines.
- **P4x.2c (commit ceca805): `get_session_detail`. 20 of 53 — THE THIN-SHAPER PHASE IS COMPLETE.**
  The card resolution (reparse-on-demand + OTEL graft) was EXTRACTED from the row-30 route as
  `resolve_session_card`, shared by both surfaces. Pinned: `background` timeline entries are
  SKIPPED by turn growth (the fixture's background row carries 999,999 tokens so counting it cannot
  pass quietly); composition key is `${kind}::${label}` BOTH halves; async children carry
  `asyncTokensUnknown: true` (omitted on sync); `ms:` DROPS when durationMs is absent (the oracle
  caught the null version); compositionSummary/subAgents are NULL when absent, never [];
  `prompt` is FALSY-coerced (`|| null`) unlike get_recent_sessions' nullish read — two tools, two
  coercions, mirrored not unified.
- **P4x.2c (commit cc8f5d1): `get_cost_rollup`. 21 of 53.** `buildCostRollup` lives IN mcpServer.ts
  — the "costRollup has no Rust counterpart" grep looked for a FILE and missed the in-module
  function; recheck the others the same way before declaring them engine-ports. Pinned: OVERLAP
  membership (the spanning card started 30h ago, ran until 22h ago — 24h counts it, 2h does not);
  undated cards excluded AND counted; unpriced cards' TOKENS count but COST does not (never a
  silent $0). **The serialization trap of the day (second time — same class as detail's `ms`):**
  `g.workspace = s.workspace` DROPS the key when undefined while `g.parentSessionId = x ?? null`
  KEEPS it as null — the two assignment shapes in one literal serialise differently, and the oracle
  caught nulls where keys should have dropped.
- **P4x.2c (commit a52b1f1): `predict_session_cost`. 22 of 53.** In-module thin one. Pinned: the
  percentile pick is a MEMBER of the sample, not an interpolation; the type bonus RERANKS (proved by
  comparing rankings); the 10x band DOWN-WEIGHTS to 0.2, never excludes; matched:0 carries NO
  numbers and names the active type filter; zero-traffic cards excluded from every ranking; the
  headline estimates are FLAT duplicates so they survive the lean shaper.
- **P4x.2d STARTED (commit 41a2bdc): `runtimeInventory` ported + `get_runtime_inventory`. 23 of
  53.** First real ENGINE port. **A BUG I WROTE AND THE FIXTURE CAUGHT:** hand-rolling the ps row
  parse as `splitn(5, char::is_whitespace)` to avoid a Regex — ps pads columns with RUNS of spaces,
  so it split into empty fields and dropped EVERY row; the report would have returned zero
  instances on any real machine while looking healthy. Use the TS regex verbatim.
  Fixture exercises: argv0 BASENAME matching (every CC-launched process has `~/.claude/…` in its
  args, so a whole-line match multiplies the apparent footprint); a NESTED claude FOLDING into its
  parent; a ppid CYCLE (the hop cap + BFS seen-set — without them the test HANGS rather than
  fails); an orphan with an absent parent; header/blank/torn lines. Empty snapshot = valid
  zero-instance report, not an error.
  **Oracle gotcha:** `checkedAtIso` uses `new Date()`, which reads the system clock DIRECTLY —
  stubbing `Date.now` alone leaves it drifting. The generator replaces the whole `Date` constructor.
  Live smoke on the REAL process table: 22 instances, 24.7 GB tree RSS, cwd via lsof, version found.
- **P4x.2d (commit f4d4f8a): `skillAttribution` ported + `get_skill_attribution`. 24 of 53.**
  THE DEDUPE IS THE WHOLE SLICE: CC writes ONE assistant message as MANY JSONL rows (one per
  content block) repeating the FULL `usage` on each. **Measured live on this machine's real
  transcripts, 720h window: 12,833 messages / 10,187 duplicate rows — a per-row sum reads 23,020
  and inflates every figure ~1.79x.** Counted once per `message.id`; the collapsed rows are
  REPORTED (`duplicateRowsSkipped`), never hidden.
  **THREE JS-TRUTHINESS DIVERGENCES my first draft had — all found by RE-READING the TS, none by a
  test** (the same lesson as the leanify and project-hint defects): an EMPTY `attributionSkill` is
  FALSY at both the guard and the accumulate site, so `is_none()` would have minted a rollup named
  `""`; `usage ? … : 0` is TRUTHY not is-object, so a malformed non-object `usage` is still PRICED
  (at $0) and an `is_object()` filter made the coverage counters disagree exactly on corrupt
  records; an EMPTY message id is falsy and must never dedupe.
  Also pinned: the ts filter runs BEFORE the dedupe (a windowed run reports 0 skipped, not 2);
  `firstTs`/`lastTs` are OMITTED not nulled when nothing parsed; an unpriced message still counts
  as attributed; `Math.max(1, topN)` floors to 1 with NO upper clamp and absent = UNCAPPED;
  `window: 0` means NO window (truthy) yet `windowHours: 0` (nullish).
  **Two things stated as unpinnable rather than faked:** the whole-file `includes()` pre-filter is
  unobservable by construction (a file it skips has no attributed rows anyway), and the mtime skip
  cannot come from a committed fixture because git does not preserve mtimes — asserted as a Rust
  property test instead. Mutation-proved: no-dedupe fails 5 tests, `is_object()` fails 4.
- **P4x.2d (commit 8e1f8cc): `loadedPluginVersions` ported + `get_loaded_plugin_versions`. 25 of
  53.** CORE CLAIM: `loadedVersion` is the MAX observed, NOT the latest-by-timestamp — a compaction
  REPLAYS old invocations as fresh records, so record order is not chronological (18/19 measured
  non-monotone) and a latest-ts port libels a current session as a ghost. Mutation-proved: the swap
  fails 5 tests.
  **TWO MORE TRUTHINESS/PRESENCE TRAPS** (same class as the skillAttribution three): `opts.plugin &&`
  is TRUTHY at both use sites so an EMPTY filter means NO filter — `Some("")` matches nothing and
  reports a confidently empty fleet, the failure that looks like good news; and
  `opts.activeMinutes !== undefined` is a PRESENCE test so `0` is a real now-anchored window, while
  an explicit JSON `null` coerces to 0 — reproduced, not "fixed".
  Also pinned: ONLY the harness `invoked_skills` attachment is evidence (decoys in prose + a
  wrong-typed attachment); `stale:"unknown"` is not a softer `true`; scanned−evidence IS the blind
  spot; the cache's `/^\d/` filter (`walkthrough` sorts ABOVE `3.4.0`); numeric compare (1.0.9 vs
  1.0.10); four row fields assigned AFTER the literal serialize at the END.
  **MTIME PATTERN, reusable:** `lastActivityTs` is a transcript mtime and git does not preserve it —
  the generator STAMPS a fixed table and PUBLISHES it in the oracle; the Rust test stamps the same
  table READ FROM THE ORACLE (`touch -d @<epoch>`; no crate has a set-mtime API here). A second
  hardcoded copy drifts silently and the suite compares two worlds while passing.
  NAMED not faked: `compare_versions`' non-numeric branch is a BYTE compare vs the TS's ICU
  `localeCompare` — they agree on lowercase-ASCII tails, diverge on mixed case/non-ASCII.
  **Live smoke found a REAL ghost: this session runs janitor 3.3.18 while 3.3.20 is cached.**
- **P4x.2d (commit d4c3133): `spawnRollup` + `get_subagent_tree` + `get_context_growth`. 27 of 53.**
  **⚠ THE QUEUE ORDER WAS WRONG — measured, and the correction matters more than the slice.**
  "SIZE FIRST" was being applied to FILE NAMES. Real costs: `cacheEventLog.ts` = 479 **+ 800
  (`cacheCreationForensics`) + 223 (`otelCallIndex`) = 1,502**, both deps UNPORTED — mis-sized 3×;
  `subscriptionUsage` = 797 + 90 (`keychainConsent`), `accountInfo` already ported; and **10
  in-module `handle*` handlers, 10–136 ln each (~550 total), missed ENTIRELY** by a filename sort.
  That is the CLAUDE.md warning firing a THIRD time ("check for IN-MODULE functions before assuming
  a missing file means a missing engine" — previously `buildCostRollup`, `predictSessionCost`).
  **The queue below is now sized by ENGINE, not by filename.**
  Pinned: an absent/unknown `spawnKind` counts `unknown` NEVER `fresh` (mutation-proved: 4 tests);
  FLEET-COLD is measured from the RECORDED BUCKETS not the label (fixture c3 is *labelled* `fork`
  yet cold; c5 wrote 200k and READ 180k so it must NOT be cold); MODEL-MIX uses `override || model`
  (falsy-or — an `??` port flags a child that matches the parent) and is DISABLED when the parent
  model is unknown; `asyncUnreportedChildren` OMITTED when 0 (a literal 0 turns a coverage gap into
  a measurement) and keeps its literal position; Σ cost rounded ONCE; the tree always roots at the
  PARENT; the rollup runs over FULL child CARDS (the reduced `children` shape lacks the cache
  buckets every detector reads — passing it silently disables the advisor).
  Live: a real 138-turn session, peak 269,265 prompt tokens, 98% hit rate, computed peak == the
  independently persisted `peakContextPerTurn`.
- **P4x.2d (commit 8bd0ca1): `find_context_hogs` + `get_account_state_at` + `buildScanCoverage` /
  `fileBackedPool` / `readTimeline` / `resolveStateAt`. 29 of 53.** First slice off the re-sized
  queue. **THE ORACLE CAUGHT A REAL DIVERGENCE — the first this session found by a FAILING TEST
  rather than by reading.** `scope` is guarded TWICE with DIFFERENT operators that disagree on the
  whitespace case: `fileBackedPool(…, scope ? … : null, …)` is TRUTHY (`""` = no scope) while
  `scope: scope ?? 'all'` is NULLISH (`""` survives as `""`). So an all-whitespace scope filters
  NOTHING yet echoes `""` — only an ABSENT scope reads `"all"`. Collapsing the two guards into one
  `Option` (either way) is wrong. **8th truthiness/nullish divergence in 4 slices; the reading pass
  missed this one, which is why the oracle must exercise the ODD inputs, not just the happy path.**
  Also pinned: THREE counts are THREE FACTS (considered / withLog / scanned — fixture 4/3/2; a card
  with no local log is NOT a card checked and found clean); `buildScanCoverage` emits three
  DIFFERENT notes (nothing-to-scan / complete / SAMPLE — collapsing them lets an empty result read
  as a clean bill of health); a scope matches a workspace PREFIX *or* a sessionId SUBSTRING;
  `Math.min(topN ?? 15, 50)` is an UPPER clamp ONLY so 0 returns nothing — **the OPPOSITE convention
  from `loadedPluginVersions`' `Math.max(1, topN)`, so each must be asserted, never assumed**; a
  source is summed ACROSS TURNS so `sessions` ≠ `occurrences` (2 vs 5 — a single-turn fixture would
  hide it); `readTimeline` drops a torn line and a non-numeric `ts` INDIVIDUALLY and a missing file
  is EMPTY not an error; `resolveStateAt`'s boundary is INCLUSIVE; a pre-timeline query is
  `state: null` + a note (a GAP, never an error, never "no account"); `ts` beats `iso`.
  Live on the real corpus: **13,802 considered / 1,286 with log / 25 scanned** — the sampling gap
  working, with the SAMPLE note carried in the payload.
- **P4x.2d (commit f20b293): `get_agent_tokens`. 30 of 53.** THE MATCH ORDER IS THE WHOLE
  CORRECTNESS ARGUMENT: resolution starts from the NORMALIZED equivalence class (bare ↔ `agent-<id>`,
  case-insensitive) and exact sessionId equality is only a TIE-BREAK, never blanket precedence — **a
  spawn PLACEHOLDER's sessionId IS the bare agent id BY CONSTRUCTION**, so a bare-id query would
  "exactly" match the ZERO-BUCKET placeholder and serve it over the real totals, reporting a real
  agent's spend as free. The tie-break is trusted only when the query carries the distinguishing
  `agent-<id>` form. Mutation-proved: dropping `qLower !== qBare` fails 2 tests.
  **TWO BUGS I WROTE AND CAUGHT PRE-COMMIT, both invisible to a value comparison:** `warm` inserted
  BEFORE `spawnKind` (inverting the TS literal — key order is a wire contract, and computing `warm`
  first is the natural port mistake), and `cost_usd` reading the wall clock instead of an injectable
  `now`. **Add a key-order check against the TS literal to the slice discipline.**
  Also pinned: a card with NO parent has `spawnKind` NULL not `'fresh'` (never spawned ≠ spawned
  fresh; a CHILD without a kind DOES default to fresh — the parent distinguishes them);
  `ccDisplayEquivalent` derives `lastTurnContextRead` most→least authoritative and NEVER guesses
  (statusline → last USAGE-CARRYING turn, skipping a trailing zero entry → single-turn cumulative →
  NULL); a wrong parent SHOWS where the id does live; `lastSeenAt` from the card's own span, null on
  an unparseable start, never a fabricated now(); `turns` null not 0 at zero calls.
  Live: a real 1,166-turn session — 482.7M cache-read tokens, $294.84, lastTurnContextRead 459,848.
- **P4x.2d (commit 0d04865): `tokensByCause` + `get_cost_by_cause`. 31 of 53.**
  **⚠ I ALMOST SHIPPED A HARDCODED `stoppedEarly: false`**, reasoning the Rust path could not hit
  the TS's `scanWithBudget` early-stop. That would have deleted one of THREE coverage-note branches
  — and the live smoke landed on exactly it: **42 of 625 CC sessions, stopped by the 20s budget**.
  With the shortcut the response would have blamed the POOL CAP for the truncation and told the user
  a retry would not help, when it would. **NEVER hardcode a branch away because "the Rust path
  cannot reach it" — implement it or measure that it cannot.**
  Pinned: the unattributed bucket is PINNED LAST regardless of size (it is the BIGGEST row in every
  fixture dimension — mutation-proved: sorting it in fails 4 tests); its LABEL differs by dimension
  (`(unattributed)` = genuinely unknown vs `(no skill)` = not-caused-by-any-skill — one shared label
  asserts ignorance where the data is definite); `mcpTool` keys as `server/tool` so same-named tools
  on different servers never merge, and an unknown server keys `?/tool` rather than dropping a real
  chargeable cause; a costless call makes rows a FLOOR (`costKnown:false`); the remainder is SIGNED
  and never clamped and NULL when there is no ground truth ("cannot compute" ≠ "reconciles");
  `sessionId`/`sessionsScanned` DROP when absent and are mutually exclusive; **the window and rank
  are by LAST ACTIVITY not startTime** (fleet-measured: 13,241 cards, the active flagship ranked
  #446 by startTime, leaderboard reading 0 while its own drill showed 1,155); non-CC sessions are
  excluded from the scan but COUNTED as considered; `days` clamps at BOTH ends — **the OPPOSITE of
  `find_context_hogs`' upper-only `topN`**.
  **Oracle lesson:** compute an expected total FROM THE ENGINE, never by hand — a guessed
  exact-reconcile total was off by 1,005 and silently left the `remainder===0` branch untested.
- **P4x.2d (commits 860b2b6 + 6e84a1d): `shared/residentCost` engine + `get_context_inflation_report`.
  32 of 53.** The engine was **DELEGATED to a lean-worker** — a response to a MEASUREMENT: the live
  `get_burn_status` named this session the machine's hottest burner ($337/hr, 9.48M tok/min), and a
  fresh small context is the documented lever (not `/compact`, itself a cold rewrite). **Verified
  first-hand, not from its report** — 275/275, clippy 28, exactly 5 scoped files, field order checked
  against the TS literal at report AND block level.
  **THE PREDICATE WAS HARDCODED TO THE WRONG CALLER'S RULE.** `file_backed_pool` was written for
  `find_context_hogs` (prefix OR sessionId-substring, cap 25); this handler and the unported
  `get_cache_break_report` use **prefix ONLY, cap 20**. Left as-is a session gets scanned merely
  because its id contains the workspace string. Now a PARAMETER. Found by reading ahead.
  **THE DOUBLE-GUARD TRAP — all three sites now measured and ALL THREE DIFFER** for `"   "`:
  this handler echoes `"   "` (RAW+untrimmed under `??`), `find_context_hogs` echoes `""` (TRIMMED),
  an ABSENT arg echoes `"all"`. Assert every site; never generalize from one.
  **VERIFYING THE DELEGATED WORK FOUND A BUG IN MY OWN FIXTURE, NOT THE PORT:** parity failed on
  `totalContextTokens` (TS null vs Rust 0) because I wrote usage as `{inputTokens, cacheReadTokens}`
  when the step shape is `{input, cacheRead, cacheCreate}` — the TS summed `undefined` into NaN
  (→null) while the correct port read 0. Lesson: when a verification fails, suspect the FIXTURE
  before the port.
  Also pinned: `runawaySources` needs BOTH halves (a 90k ONE-turn paste and a 6-turn 200-token skill
  are both decoys, and both remain CONTRIBUTORS — excluded from runaway, not from the report);
  `peakTokens` folds MAX while cumulative/turnsPresent SUM (the runaway threshold reads peak);
  `considered`/`withLog` default to 1; `residentCost` session-scoped only with an explicit
  `{message}` for no-transcript; `itemizedPct` NULL at zero denominator; `{...b, drill}` appends last.
- **P4x.2d (commit 8e08209): `check_cache_expiry` + its MCP arm. 33 of 53.** DELEGATED to a
  lean-worker, and **verifying it first-hand found a defect its own oracle could not see**: the port
  gated the scan deadline behind `time_budget_ms > 0.0`. `scanWithBudget` computes
  `deadline = Date.now() + timeBudgetMs` **unconditionally**, so a non-positive budget is a deadline
  already in the past — scan nothing, `stoppedEarly: true`. The Option-gated version reads the same
  input as "no budget" and walks the WHOLE corpus: the opposite answer, and the expensive one, on
  the path whose entire purpose is to stay bounded. Every existing case used a generous 20s budget,
  so all of them passed either way. Now pinned by `toolAllElapsedBudget` /
  `toolDefaultElapsedBudget`, using **-1 not 0** (a zero budget is millisecond-nondeterministic —
  however many items fit in the current ms). **Rule: a bounded-scan port must carry a case with an
  ALREADY-ELAPSED budget; a generous-budget-only oracle cannot distinguish "bounded" from
  "unbounded".** The tail resolver (TRDD-CXPLAT01 `getLastRequestMs`) is NOT ported — the arm passes
  None and takes the TS's own documented reparse-per-candidate fallback rather than a different
  answer.
- **P4x.2d (commit e2c8e5f): `shared/cacheBreak` engine (383 ln). Not a tool — the shared engine
  behind the next two.** Ported IN THE MAIN CONTEXT (see the burn note below). Taxonomy is a Rust
  **enum**, not `&str`: the TS types all three tables as `Record<CacheBreakCause, string>`, so the
  compiler is what forces a remediation + label per cause; a `_` arm would ship an empty string for
  a cause added later and the parity test would not notice, because it iterates the causes it knows.
  Pinned: MODEL_SWITCHED is TRUTHY on BOTH sides (an empty model is "unknown", not "switched" —
  `is_some()` fires wrongly); `diffTurnSources`' two branches are ASYMMETRIC (`prevTokens: p?.tokens
  ?? 0` in the cur branch vs RAW `s.tokens` + literal `curTokens: 0` in the removed branch, and an
  undefined `excerpt` DROPS its key); the **two "no break" objects have different shapes** (turn 1
  has no `idleGapMs` key at all, the step-5 fallthrough has it) — invisible to a value-only compare;
  the reload check runs BEFORE the first-divergence pick AND requires the kind to have existed in
  prev (else turn-2 warmup is mislabeled a reload); offenders sort cost→tokens under a STABLE sort
  so full ties keep turn order.
  **HARNESS FALSIFICATION, and it caught a real weakness:** 11/11 passed on the first run, so the
  reload threshold was deliberately broken to 3 — only the BULK comparison failed. Every test that
  merely read the oracle's stored `out` stayed green while documenting semantics the port no longer
  had. All named-behaviour tests now run the RUST engine. **Rule: a test that cannot fail on a
  broken port is documentation, not a gate — falsify any suite that passes first try.**
- **BURN CORRECTION, measured and acted on.** Delegating engine ports to lean-workers to reduce
  burn was WRONG for build-heavy work: `investigate_burn --windowHours 1` named those very calls —
  PREMIUM_MODEL_FANOUT 2.7M equiv (49%), FORK_STORM 1.5M (28%), 3 fully-cold full-prefix writes,
  ~$21 in one hour. Mechanism: a fresh subagent gets a **5-minute** TTL and `cargo test --workspace`
  between turns blows it, so every turn is a cold full-prefix rewrite. The fat main conversation
  (1h TTL, 0.1× warm re-reads) is CHEAPER for anything with long tool gaps. Delegate only pure
  authoring with no long gaps, or batch all builds into one final turn.
- **P4x.2d (commit 7ddce2d): `get_cache_break_report` + its arm. 34 of 53.** The FIRST consumer of
  `cache_break.rs`. **THE SECOND DOUBLE-GUARD VARIANT, and it FAILED on the first run** — which is
  exactly why each site is asserted rather than generalized from a sibling. `scope =
  args.workspace?.trim()` is BOTH the truthy filter guard AND the `scope ?? 'all'` echo, so ABSENT
  and PRESENT-BUT-BLANK differ: absent → `"all"`, `"   "` → filters nothing and echoes `""`. The
  port collapsed both to `""` up front. For the same input the three sites now read: inflation
  `"   "` (RAW), hogs `""`, break-report `""`, absent `"all"`.
  Also pinned: `block: … ?? null` KEEPS its key while the engine's `breakSourceLabel` DROPS —
  same datum, two wire contracts; `{...o, wastedCostUsd: +…}` keeps the OVERWRITTEN key's ORIGINAL
  position (appending would reorder and still compare equal by value);
  considered/withLog/analyzed are three different numbers and the GAPS are the diagnosis.
  `get_composition` became `Option<&dyn Fn>` (one representation of the TS `if (!getComposition)`,
  and it keeps the signature inside clippy's arg limit).
- **P4x.2d (commit 38741c6): `effortTransitions.ts` engine (198 ln).** An unported PREREQUISITE of
  `get_cache_risk_costs`, found by READING AHEAD — the handler is 138 lines but imports from a
  198-line module nothing had touched, so its real cost was 336. **Third time this queue was
  mis-sized by filename.** Pinned: THE ABSENT-VALUE RULE (only an EXPLICIT non-empty string
  `effort` is an observation — absent→present is the FIELD APPEARING at the CC 2.1.212 boundary,
  and counting it manufactures one false invalidation per session across all history); the first
  observation is the BASELINE and emits nothing; PARTITION by (session, sidechain) with
  `=== true` STRICT; TIME order not FILE order (a resume writes a new file — the fixture puts a
  record BETWEEN two of another file's, so file-order differencing gives the same COUNT with
  different from/to: a length assertion cannot see it); `model` appended LAST and dropped when
  absent or non-string; both post-filters run AFTER the differencing (filtering records first
  differences across the hole).
  **MTIME-ORACLE pattern reused:** git does not preserve mtimes, so the generator STAMPS a table
  and PUBLISHES it; the Rust test re-stamps FROM THAT TABLE via `std::fs::FileTimes`. Never two
  hardcoded copies.
- **P4x.2d (commit 15e9e60): `get_cache_risk_costs` + its arm. 35 of 53.**
  **THE JOIN ONLY EVER SEES BREAKING TURNS** — `timed` filters `tsMs !== undefined`, and `tsMs` is
  written ONLY by the engine's break path, so both "no break" objects are INVISIBLE to it. A
  command followed by a quiet turn is billed against the next turn that actually BROKE, and the
  "menu opened and closed" note is reachable ONLY via a turn that broke wasting ZERO tokens (a
  model switch with no cache_creation). The first fixture had none: every case passed, the branch
  never executed, and a bare `/model` looked correctly billed when it had skipped two turns ahead.
  **A green suite is not coverage — enumerate the branches and check each one EXECUTED.**
  Also pinned: ONE TURN IS ONE COST (two commands before the same turn ⇒ only the EARLIEST is
  charged; this is the 102-vs-69 double-count, and the suite was FALSIFIED against it — dropping
  `!already_charged` fails 3 tests); `windowHours` NULLISH on the RAW arg vs `sinceMs` TRUTHY, so
  `window: 0` echoes 0 and filters nothing; an effort transition is an EVENT but NOT a COMMAND
  (so `commandsFoundInTranscripts: 0` co-occurs with a non-empty `events`); `minTokens` gates only
  a BREAK; the residue ships LABELLED and the test PROVES the inferred 40,000 is absent from the
  totals rather than trusting the note; `byKind.costUsd` re-rounds on EVERY accumulation.
  `fileBackedPool` gained its general PREDICATE form (the TS signature all along) and the string
  form delegates to it; the 6 scan inputs travel in a `CacheRiskCtx` struct.
- **QUEUE RE-ORDERED ON A MEASUREMENT (commits 7ed88d3, 670322c, b49bb5b) — 38 of 53.** The line
  below said `subscriptionUsage` next. Sizing the remaining 18 BY ENGINE said otherwise:
  subscriptionUsage is 797 + 90 `keychainConsent` + 89 `dataDir` = **976 lines of NETWORK code for
  ONE tool**, while `accountBurners` (470) + `windowEta` (205) + `bodyWriters` (282) is **~957 for
  THREE**, every dependency already ported (`accountStateTimeline`, `burnMonitor`,
  `bodiesActivity`) and nothing to stub. Took the three. The enumeration itself is the reusable
  step: `assets/mcp-tools.json` × a regex over `ui.rs`'s match arms gives the exact remaining set,
  and `grep -n "^import"` on each handler's engine gives its real cost.
- **P4x.2d (commit 7ed88d3): `accountBurners.ts` (470) + `get_account_burners`.** Pinned: a NULL
  accountId CLOSES the open segment (consumption in an unresolved stretch belongs to NOBODY —
  without this the gap is charged to the last known account, the exact misattribution this tool
  exists to prevent); `readAccountSegments` DROPS a non-numeric `ts` rather than defaulting to 0
  (which would open a segment at the epoch); the email/plan pick is `.filter(Boolean).pop()` — the
  last TRUTHY value, and the fixture's newest segment carries an EMPTY email on purpose;
  `previous` skips EVERY segment of the current account; `resolveWindowUntil` parses the RAW
  interval and NAMES an unparseable one; `fmtTok` divides by 1e3 unconditionally below 1M so 500
  renders "1k" (the columns are aligned to that); the same-plan capacity proxy is DETERMINISTIC
  (newest observedAt, then larger cap — the test re-runs it with the table reversed); fill% is
  COST-first with token fill as fallback and null ⇒ "undetermined", never guessed.
  **The rendered `text` is compared BYTE-IDENTICAL, and that test was FALSIFIED:** narrowing one
  padStart from 8 to 7 fails it while every field-by-field assertion still passes. A column drift
  is precisely what a value comparison cannot see.
  `js_to_fixed_str` moved from `spawn_rollup` (private) into `summarize::helpers` with the `-0`
  guard JS needs (`(-0).toFixed(2)` is "0.00"; Rust prints "-0.00").
- **P4x.2d (commit 670322c): `windowEta.ts` (205) + `get_window_eta`.** SHARES accountBurners'
  attribution rule, capacity resolver AND parity fixture — the TS says the two tools must never
  disagree, so a second fixture is exactly how they would drift.
  **THE ROLLING-WINDOW PLATEAU is why this is not `remaining ÷ rate`:** a rolling window sheds
  consumption older than its length, so at a steady rate r it plateaus at r × windowLength; below
  the cap it can NEVER exhaust, and a naive projection prints a confident countdown for a window
  that will never fill. Also pinned: the 5 etaReasons are DISTINCT outcomes (the test asserts all 5
  reachable AND no two share a human string); `humanEta`/`exhaustionEtaIso` read the UNROUNDED
  minutes while the reported field is `+toFixed(1)`; `Math.round(m % 60)` runs INDEPENDENTLY of
  the hour so 59.5 → "60m" and 1439.6 → "23h 60m"; a cost cap of exactly 0 is over-limit with a
  null fill (two guards reading the same number differently), not 'no-capacity'; an ALREADY-OVER
  window binds outright over a smaller positive ETA.
- **P4x.2d (commit b49bb5b): `bodyWriters.ts` (282) + `get_body_writers`.** `queryStoreWriterTotals`
  is **NOT PORTED** — the durable DuckDB store is not held by the Rust server, so the arm passes
  `store: None` and takes the TS's OWN store-unavailable branch; the payload's `note` says
  "STORE UNAVAILABLE", a degradation stated in the answer rather than a silently different number.
  Pinned: `active` and `recent` are DIFFERENT windows (the fixture's r3 is recent-but-not-active —
  the row that says "already stopped"); the store merge is an EXACT union and the test asserts the
  delta between the two store fixtures is exactly the ingested file's byte count; the unattributed
  bucket never inherits a card (TRUTHY `sessionId ?`); `available` is the UNION of dir and store;
  `lastWriteMs` of exactly 0 renders "never". The dir walk is SORTED (Node's `readdirSync` order is
  filesystem-dependent, so the TS's own tie order is not reproducible — there is no correct order
  to match); the fixture carries no rate ties.
- **P4x.2d (commit 5e3359b): `cacheCreationForensics` SCAN HALF.** Not a tool — the bounded scan
  every cache-creation-forensic tool builds on, and `cacheEventLog`'s dependency. Two TS deps
  deliberately NOT ported, neither changing an answer: `defaultBodiesDir()` (the bodies dir is a
  REQUIRED param; the route already resolves it via `burn::guard::default_bodies_dir`, and a second
  resolver inside the engine could disagree) and `makeRssSampler` (pure server.log diagnostics).
  Pinned: the REQUEST's model WINS over the response's (s1's request says opus-5, its response
  opus-4-8 — different rates, so the cost moves with it); an unknown model is priced ZERO and the
  key is DROPPED (unpriced ≠ free; 5 event fields are optional and `?? null` would add 5 keys);
  ATTRIBUTION and IDENTITY are separate (s5 joins through a request whose `user_id` is not JSON ⇒
  `attributed: true` + `requestRef`, no sessionId); an absent `cache_creation` sub-object is 0/0 NOT
  unknown (that split is what separates TTL expiry from a real break); a capped scan is
  `complete:false` + SAMPLE while a MISSING dir is `complete:true` (nothing to sample is not a
  partial view); the request index is capped by the CONSTANT `REQUEST_INDEX_CAP`, never `scan_cap`
  — **the rule the suite was FALSIFIED against** (swapping it fails 2 tests).
- **LEAK SHIPPED AND FIXED (b49bb5b → 6f6566a): run `check-identities` in the SAME gate batch as
  tests and clippy, EVERY slice.** `bodywriters-expected.json` committed this machine's home path 8
  times — `LiveBodiesScan.dir` echoes the caller's path and the generator handed it an absolute one.
  I ran cargo test + clippy for that slice and NOT the identity gate, so it shipped. Beyond the red
  guard: the fixture pinned one machine's layout into a test every contributor runs. Both that
  generator and the new forensics one now REDACT absolute paths (`<FIXTURES>/`, `<BODIES>`,
  `<MISSING>`) and the parity tests apply the same substitution — which also deleted a special case
  that copied `got.dir` into the expectation to dodge the mismatch, so `dir` is now actually
  compared. **check-identities is the only gate whose failure mode is a LEAK rather than a red test.**
- **P4x.2d (commit 38fd0c5): `cacheCreationForensics` REPORT HALF + 3 tools. 41 of 53.**
  `buildCacheCreationReport` → `get_cache_creation_report`, `buildExpensiveWritesTrace` →
  `trace_expensive_writes`, `buildCacheBreakGapReport` → `get_cache_break_gap_report`. The builders
  return `Value` rather than structs with `to_value()` **on purpose**: the formatters read the
  report back field by field exactly as the TS does, so a second in-memory representation would
  only be a place for the two halves to disagree.
  `groupBy='cause'` returns an EXPLICIT error payload naming `buildCauseCostPeakReport`
  (cacheBreakTimeline, unported) — falling back to `'session'` would return a DIFFERENT report
  under the label the caller asked for, and every number in it would look right.
  **`to_locale_en` grew a fraction half, and that is a real bug this slice found:** it claimed to
  be `Number.prototype.toLocaleString` but TRUNCATED, invisible only because every existing caller
  passed an integer. `formatCostPeaks` renders `bucketValue` through it, and under
  `bucket=billable_weighted` that is a USD cost — 4.5585 must read "4.559", not "4". Intl rounds
  the double's SHORTEST decimal repr to ≤3 fraction digits half-away-from-zero, so `fmt_js_num` is
  the right source string and testing the 4th digit against '5' reproduces halfExpand exactly.
  `pad_start` moved to the same shared helpers (it was private to `account_burners`).
  Pinned: `toFixed(4)` runs BEFORE the group sort, so the ranking compares ROUNDED values and
  near-ties keep first-seen order · the per-session turn index is assigned BEFORE `turnFrom`/
  `turnTo` run, so an excluded event still consumes its number (that is what makes `turnFrom` mean
  the same thing across two calls) · `i === 0` in the gap classifier is POSITIONAL within the
  session, NOT "the previous BIG event" (fixture rC1/rC2 exists solely to pin that) · the
  composition cache is keyed on `bodyRef` ALONE, so a request reached first WITH exact usage and
  later as a chain turn reuses the first, differently-calibrated summary · an unrecognized bucket
  falls through to `cache_creation`, not 0 · an unparseable `timeFrom` yields NaN and excludes
  EVERYTHING (not "no filter") · `slice(0, n)` with a NEGATIVE n counts back from the end.
  Oracle: `gen-ccreport-expected.mjs` generates BOTH the `ccreport-bodies/` fixture and the
  expected JSON (one source for the bodies and the mtime table that gives them meaning), in its
  OWN dir — adding files to `forensics-bodies/` would shift every count in the pinned scan oracle.
  All 6 gap buckets fire at the DEFAULT 100k threshold and the test asserts it rather than
  trusting a green run. FALSIFIED (11/11 passed first run): gap boundary 6m→5m · turn-index sort
  asc→desc · `toLocaleString` 3→2 fraction digits · composition cache disabled — each caught by
  the test that should catch it, each restored.
- **P4x.2d (commit 91fc3f8): `cacheEventLog` (479) + `get_cache_event_log`. 42 of 53.**
  The `otelCallIndex` SIDECAR CACHE is deliberately NOT ported: it exists to avoid re-walking the
  span store in single-core TS, and **the TS itself bypasses it entirely ("no sidecars") once the
  Rust engine is opted in** — here that scan IS the engine (`agentlens_spanstore::scan_call_events`),
  so the cache would be a second, staler copy of what the direct scan already produces in ~1s.
  **`chrono` + `iana-time-zone` become DIRECT deps** (both were ALREADY in the workspace lock as
  transitive — a direct edge to what compiles anyway, not new supply-chain surface): std has NO
  local-time support and the ledger renders `localTime` + the IANA zone name. The engine takes the
  zone as a **PARAMETER** (`DisplayZone`), never reading the process — a fixture generated in one
  zone and asserted in another is not a fixture, it is a different expected file per machine;
  `DisplayZone::System` resolves PER TIMESTAMP so a DST-spanning window renders both sides right.
  Pinned: OTEL WINS when the span store has events, and the two feeds differ in `source`, in
  `excluded.note`, and in what is attributable AT ALL (OTEL carries session.id per call, so a
  compaction's own summarization call — `query_source: compact` — gets a row the
  previous_message_id chain structurally cannot produce) · `cacheWriteTtl` is 1-hour only from an
  enriched body; an OTEL row with no body is UNKNOWN (null), **NOT** 5-minute · an UNKNOWN model is
  `computed` with cost 0 while `weighted` is null (calcTokenCostUsd returns a NUMBER for an unpriced
  model, lookupRates returns nothing — the disagreement IS the honest answer), and only a call with
  NO model reaches `unpriced` · the peak is by COST, ties to the MOST RECENT · a
  `cache_missed_input_tokens` of exactly 0 renders no parenthetical · a whitespace-only `project`
  is FALSY and falls through to `CLAUDE_PROJECT_DIR` · terminal display WIDTH, not char count (the
  flame marker is one code point in two columns).
  **FALSIFIED (6/6 first run) — and the falsification found a REAL defect in the suite:** two tests
  stayed green under a deliberate TTL break because `every_cost_source_and_ttl_branch_is_reached`
  was asserting against the ORACLE's stored rows, so it documented the TS and gated nothing. Rewired
  to run the RUST engine; it now fails under that same break. **This is the second time that exact
  anti-pattern appeared — a named-behaviour test MUST run the engine, never read `out`.**
- **PROCESS SLIP (no damage, recorded so it is not repeated): I ran `sed -i` on a source file.**
  The pattern made no substitution and the file was byte-identical, but it wrote a stray
  `.bak-falsify-check`, and the rule (`~/.claude/rules/never_use_sed.md`) is absolute because a
  `sed` that does nothing looks exactly like a `sed` that worked. Backup removed only AFTER `git
  show HEAD:<file>` proved it byte-identical to committed content.
- **P4x.2d (commit cb1a66a): `sessionBurnProfile` (462) + `get_session_burn_profile`. 43 of 53.**
  Also lands `sessionIdOf`, `heartbeatCost`'s dependency.
  Pinned: **THE USAGE CHAIN IS OFF BY ONE BY DESIGN** — turn i's usage lives on the response whose
  id equals turn **i+1**'s `previous_message_id`, so the LAST request is unusable by construction,
  not by omission (fixture: 7 requests / 6 usable, asserted) · **`sessionIdOf` reads
  `metadata.user_id` from the END, never message content** — a naive `/"session_id":"…"/` matched a
  session id MENTIONED in conversation text and two different queries returned byte-identical
  profiles; fixture r4 carries that exact shape · the `tools[]` fingerprint is **ORDER-SENSITIVE**
  (`join('\x00')`): a pure REORDER of an identical set still invalidates the whole prefix, and
  comparing SETS instead is the obvious "simplification" that silently drops the class · the
  even-length **median** is `Math.round((a+b)/2)`, not the upper element — a median BELOW the 20k
  floor with a p90 far above it is stable-and-appending with the cost concentrated in a few break
  events, a completely different remediation from a per-turn rewrite (fixture: 14,000 / 150,000) ·
  the weighted comparison names the dominant term (the fixture's raw reads outnumber writes 3.5:1
  yet the WRITE term dominates at 1.25× vs 0.1×; ranking by raw tokens names the wrong culprit) ·
  `inspectNewest` gives a deferred BUILT-IN its own `bySource` bucket, which `sourceOf` in the
  stability diff deliberately does NOT — the two classifiers answer different questions · cold
  calls below the 50% floor must NOT emit the cold-loop remediation (a list that fires on
  everything is advice nobody reads) · `extractToolNames` scans BYTES where the TS scans UTF-16
  units (every tested char is ASCII, so structure and slice boundaries are identical) and is a
  FINGERPRINT, not a parser — an unterminated array yields NOTHING rather than a partial
  fingerprint that would read as a tool-set change next turn · the empty profiles distinguish a
  MISSING DIR from a missing SESSION, and `lastCallMinutesAgo` stays **null** (no last call ≠ "0
  minutes ago"). The MCP arm reproduces the handler's P7 provenance graft, including the
  unique-PREFIX card fallback so a prefix query is not left without provenance.
  **FALSIFIED (5/5 first run):** prefix match → equality · even-length median → upper element ·
  `tools[]` fingerprint → set comparison · the deferred `bySource` bucket removed. Both profile
  tests went red; the three primitive/empty-path tests correctly stayed green (none touches those
  rules) — a falsification that reddens EVERY test is not evidence the tests are targeted.
- **P4x.2d (commit dc0f30f): `heartbeatCost` (316) + `get_heartbeat_cost`. 44 of 53.**
  THE TWO TRAPS this tool exists because of: **`raw.includes(marker)` is WRONG** — the marker
  persists in the transcript history of every later call and appears in any conversation that
  merely discusses the janitor (measured on the real spool: **1412** bodies contained it, **ZERO**
  were fires) — and **the LAST message is NOT the user's** (Claude Code appends hook output after
  it, so a naive last-message check never matches a real fire; the walk goes BACKWARDS past
  injected context and stops at the first assistant message). Both are pinned by fixture files
  built for exactly that shape.
  Also pinned: Agent/Task spawns come from the **LAST message only** · `u.model = r.model` when the
  response carried none is a **MUTATION** of the stored entry (a clone-first port diverges on that
  shape, so the port takes `get_mut`) · **without** a sessionId filter another session's call inside
  the fire's index range is counted as one of the fire's `apiCalls` AND disclosed under
  `concurrent` — `candidates` is session-filtered only when asked, and the test asserts the two
  runs differ by exactly ONE call · an unsettled tail is EXCLUDED and disclosed, never zero-filled ·
  `totalTokens` deliberately EXCLUDES the ephemeral 5m/1h split (a breakdown OF the write; adding
  it double-counts).
  **PINNED AS-IS, NOT "CORRECTED":** on the no-fire report `coverage.filesScanned` is **0** while
  its own note says "Scanned 11 body file(s)" — `emptyReport` hardcodes the count and threads only
  the note, so two fields of one object disagree. My first test asserted the count would be real
  and it failed against a port that was already byte-exact: **the parity comparison was right and
  my assertion was wrong.** Recorded so nobody smooths it into a divergence on the field a caller
  uses to judge whether the answer is trustworthy.
  **FALSIFIED (5/5 first run):** assistant early-return → `continue` · the UserPromptSubmit
  injected-context branch disabled · Agent/Task counted over ALL messages · the model adoption
  removed. Three tests red; the two that stayed green cover paths none of those rules reach.
- **QUEUE RE-ORDERED — `compare_configs` MOVES TO THE SQL GROUP (sized by engine, 4th time this
  check has changed the queue).** `forensicsCompare.ts` looks like 253 lines; it imports
  `./forensicsDb` (**261 ln, NO `.rs` counterpart**), which is a **sql.js reader over a
  `forensics.db` SQLite snapshot** that also REGISTERS CUSTOM SQL FUNCTIONS (`billableWeight`,
  `tierClassify`). So the real slice is **514 lines plus a SQLite binding agentlens-core does not
  have** — the same infrastructure `run_diagnostics_sql` / `run_transcript_sql` need. Doing it
  "next" would have meant discovering that mid-port. It belongs WITH the sql tools, at the end.
- **`burnInvestigator` IS SPLIT IN TWO, and slice 1 has a PREREQUISITE — both decided, do not
  re-derive.** 632 lines does not fit one context alongside an oracle and a parity test, and it
  splits on the SAME seam `cacheCreationForensics` used (scan `5e3359b` → report `38fd0c5`):
  **slice 1** = the corpus-scan primitives (TS ~114-235: `equivOf`, `listWindow`, `scanResponses`,
  `scanRequest`, `djb2`, `looksLikeWorkspace`), landed as an ENGINE with its own parity test the
  way `cacheBreak.ts` and `effortTransitions.ts` were; **slice 2** = the detectors + assembly
  (TS ~260-632) which wires `investigate_burn` + `burn_seismic`.
  **PREREQUISITE — DONE (commit `bcd964e`): `utf16_len` + `js_slice_from` promoted into
  `summarize::helpers`, SEVEN private `utf16_len` copies deleted.** They agreed by luck, not
  construction (one had drifted to `encode_utf16().count()` — same answer, a second body to keep
  in step forever). Needed because `scanRequest` slices by UTF-16 CODE UNITS (`text.slice(-256)`
  carry, `text.slice(i, i+2600)` fingerprint input) and `djb2` hashes via `charCodeAt`.
  **CORRECTS MY OWN NOTE FROM THE PREVIOUS TURN:** it said core had "no `utf16_slice` at all".
  It does — **`js_slice(s, n)` IS `utf16_slice`**, under the JS name it ports. Verifying before
  acting on my own handoff note is what caught it; otherwise a duplicate helper would have shipped
  into the very commit whose purpose was removing duplicates.
  The new `helpers.rs::utf16_tests` pin a DELIBERATE lossy edge nobody had written down: `js_slice`
  and `js_slice_from` are complements at every boundary EXCEPT one inside a surrogate pair, where
  **BOTH halves drop the char** (JS splits it into two lone surrogates that re-concatenate
  losslessly; a Rust `&str` cannot hold one). Honest — a lone surrogate JSON-encodes to U+FFFD —
  but invisible on ASCII and silently lossy on real text, so the 256-unit carry CAN lose an emoji
  on the boundary. My first version of that test asserted they were complements EVERYWHERE and
  failed against code with passing parity suites — **the second time this session a new assertion
  of mine was wrong about behaviour the port had right.**
  Two further traps, each already paid for once upstream: `buf.toString('utf-8')` on a chunk
  boundary SPLITS a multi-byte character and Node emits U+FFFD, so `String::from_utf8_lossy` is
  the faithful port (re-joining the boundary "correctly" diverges the text AND the fingerprint) ·
  `WS_RE` is **global on purpose** — a transcript QUOTES "Primary working directory:" whenever the
  conversation is about this code, and a session that read that very file made the scanner capture
  **the regex's own source** and report it as the machine's top-burning workspace.
- **TOKEN-ANOMALY HEARTBEAT WARNING FALSIFIED (2026-08-21T01:48).** The heartbeat reported ~3.78M
  weighted tokens in 5 min, 66× the session median, "$91.03/h machine-wide". `investigate_burn
  --windowHours 0.25` — the cost-weighted ranker the doctrine names as authoritative — answered
  *"No known burn pattern detected: 4.0M input-equivalent tokens across 93 calls look like ordinary
  traffic (**largest single write 2k**)"*, with **13 active sessions** machine-wide. Warm re-reads
  across a busy machine, not this session. **All three remedies it suggested would have made
  things worse here:** there were no background subagents to `TaskStop`; `/compact` is itself a
  cold full-prefix rewrite (~27× a warm turn); and delegating to a lean-worker is the burn source
  this very card MEASURED at ~$21/hr. Second time this falsification step has paid off — always
  run it before acting on a burn warning.
- **P4x.2e DONE (commit e1ce274): `burnInvestigator` SLICE 1 — the corpus SCAN half.** Still 44 of
  53 wired (this slice adds NO tool; slice 2 wires `investigate_burn` + `burn_seismic`). Ports TS
  112-231 plus the assembly the scan decides alone — `totals`, `attribution`, `coverage`, the
  3-valued `blind` classification, and the two verdict branches that need no detector (blind, and
  no-responses). Returns `ScanOutcome { resps, reqs, total_equiv, cc, cr, est_cost_usd,
  stop_failures, blind, verdict_override, partial }`; slice 2 inserts `findings` + `verdict` into
  `partial`. `resolveBodiesReadScope`/`dataDir` stay unported as the documented parameter pattern
  (`BodiesScope { dirs, missing, capture_on }` is passed in). 412 tests, clippy 28.
  **Non-obvious things that are load-bearing, not style:**
  - `String::from_utf8_lossy` IS the faithful port of `Buffer.toString('utf-8')` on a split chunk
    boundary — both emit U+FFFD. Do NOT re-join the boundary to "fix" it; the fingerprints diverge.
  - `{20000,}` is HAND-ROLLED (`sum_image_bytes`): the regex crate expands that repeat literally
    and blows its compiled-size limit.
  - `short_ws` uses `replacen(.., 1)` — JS `String.replace` with a STRING pattern is FIRST-ONLY,
    and `str::replace` would replace every occurrence.
  - `clamp`, not `.max().min()`: it PROPAGATES NaN like `Math.min(48, Math.max(0.25, NaN))`,
    where `f64::max` swallows NaN and silently returns the floor.
  - `by_model` MUST stay insertion-ordered (a `Vec`, not a map): the total cost is a float sum
    over it and addition is not associative. `by_hour` is a BTreeMap because the TS reads it back
    through a default `.sort()`, which on fixed-width 13-char ISO keys is plain lexicographic.
  - `num()` everywhere, never `json!(f64)` — serde_json Number equality does not bridge PosInt vs
    Float, so a count emitted as `5.0` compares unequal to the oracle's `5` with every digit equal.
  **Falsified, 5 rules, each confirmed red then restored:** reversed size sort (7150 vs 7250 bytes
  — the 101-file cap fixture earned its keep and pins "keep the LARGEST", otherwise untested);
  first-WS_RE-hit (prints `([^ is the pattern` as a workspace — the historical incident verbatim);
  byte-indexed fingerprint, BOTH the panicking and the valid-boundary variant; blind-scan-reports-
  complete.
  **⚠ THE BYTE-SLICE FALSIFICATION FOUND A REAL HOLE — read this before trusting a fingerprint
  test.** The panicking variant reddened all 4 tests, which LOOKED like coverage and was not: a
  valid-boundary byte cut is the realistic bug shape, and nothing could observe it. A fingerprint
  VALUE never reaches the report (it is only ever compared for equality), and a byte cut can never
  SPLIT a shared prefix — only MERGE distinct ones. Fixture `q8` closes it: it matches `q1` through
  byte 2600 but diverges at UTF-16 unit 2000, so only a correct `slice(i, i+2600)` tells them
  apart. A byte window merges two unrelated transcripts into one "shared transcript" family, which
  is exactly what slice 2's fork-storm detector counts.
  **A THIRD assertion of mine was wrong while the port was right:** I asserted `capHit` must have
  no scan-decided verdict. It has one, correctly — its corpus is 101 REQUEST bodies and zero
  responses, so it takes the no-responses branch; the cap is incidental. Pinned as the TS has it.
  **`blind='capture-off'` has NO oracle** — `investigateBurn`'s `bodiesDir` override hardcodes
  `captureOn:true`, so the branch is unreachable through the TS public API. Pinned by a Rust unit
  test and labelled as such; do not mistake it for oracle-verified.
- **P4x.2f DONE (commit 01140e1): `burnInvestigator` SLICE 2 — detectors + assembly. 45 of 53.**
  `burn/investigator.rs`: the 4 detectors, findings/verdict composition, `attach_causing_calls`,
  and the wired `investigate_burn` arm. 417 tests, clippy 28. All 11 oracle cases match the TS
  byte for byte including `findings` and `verdict`.
  **⚠ RE-SIZED — the entry above was WRONG: `burn_seismic` is NOT in this module.** It comes from
  `src/burnSeismic.ts`, a SEPARATE 1,004-line engine importing `ndjsonDuck` (no `.rs` counterpart)
  and `projectSlug` — so it moves to the SQL-backed group at the end, and this slice wired ONE
  tool, not two. FOURTH time the size-by-engine check corrected a queue entry; run it before
  starting any handler, not after.
  **Load-bearing, not style:**
  - Key order is NOT uniform across findings and that IS the wire contract — `base`-spread findings
    run `equivTokens, shareOfWindow, evidence, cause, confidence, verdict`; every other detector
    leads with `cause`. Normalizing compares equal field-by-field and is wrong on the wire.
  - Cluster equiv is `equivOf(cc, 0)` — a rewrite's bill IS its writes, so it differs from the
    window's equiv deliberately.
  - `attach_causing_calls` takes the findings array OUT and puts it BACK; iterating a `mem::take`d
    temporary drops every mutation AND empties the array, turning a report with findings into one
    without any. Written wrong here first, caught before it ran, now pinned by a test.
  - `by_model` / `fams` / `attr` stay insertion-ordered Vecs — costs are float sums over them.
  - The arm reports an unparseable `untilIso` as an EXPLICIT error payload, never a fallback to
    "now": confident numbers about hours nobody asked for is the worse failure.
  **KNOWN DIVERGENCE, deliberate:** the TS resolves a possibly-MULTI-dir scope via
  `captureConfig.resolveBodiesReadScope` (live spool + legacy dir during a drain). Unported, so the
  arm passes the single `default_bodies_dir`. `coverage.dirsScanned` reports exactly what was read,
  so the report never implies wider coverage than it had. Porting that resolver is the one thing
  that would close it.
  **Falsified, 4 rules:** median-as-min; reporting floor `&&`→`||` (4 tests red, and
  `every_burn_cause_…` NAMED the 4 causes that vanished); FORK_STORM key order normalized; the
  `attach_causing_calls` write-back removed.
  **⚠ TWO MORE HOLES FOUND AND CLOSED — same shape as slice 1's q8, a rule NO fixture could
  observe.** (1) The idle corpus used UNIFORM gaps, so `gaps[len/2]` equalled min, max AND mean at
  once and every wrong median passed; gaps are now `[70..3000]`, median 660 vs min 70 / max 3000 /
  mean 698. (2) NO corpus reached the verdict's honesty clause (`attributedShare < 0.5`) and my
  test asserted `main` did — it attributes 74%. `burnscan-partial/` now lands at 12.5%, between the
  2% reporting floor and the 50% threshold, and is also the only single-spike cluster so it covers
  `confidence:'low'`. **THE PATTERN: "all tests reddened" is NOT coverage.** Ask which fixture could
  distinguish the rule, and if none can, build it.
  **A FOURTH wrong assertion of mine against a correct port** (`main` under-attributes). The count
  is now four; treat a failing new assertion beside a passing `same()` as evidence about the
  assertion, always.
- **P4x.2g DONE (commit 57048b3): `rateLimitReport` (134) + `get_rate_limit_report`. 46 of 53.**
  StopFailure hook events grouped into stall EPISODES, newest episode deep-attributed through
  `investigate_burn` (which is why it waited on P4x.2f). 422 tests, clippy 28. 6 oracle cases exact.
  **⚠ A TRAP PORTED DELIBERATELY — do NOT "fix" it.** `topFindings` reads `code`/`summary`/`detail`
  and a real `BurnFinding` has NONE of them (it carries `cause`/`verdict`/`evidence`/`confidence`),
  so the label is ALWAYS empty and every entry is a 160-char JSON DUMP of the finding. The
  falsification that rewrites it to use `cause` prints `"FORK_STORM"` — which READS BETTER than the
  dump, and is exactly why a well-meaning refactor would ship it. The fixture carries findings WITH
  those keys too, so the label branch and the dump branch are distinguished, not assumed.
  **Other parity details that are not style:** `summary ?? detail` is NULLISH (an explicit null
  falls through to `detail`, but a non-null NON-STRING `summary` suppresses `detail` AND fails the
  string filter, leaving only `code`); episode grouping is INCLUSIVE at 600s and the fixture sits
  exactly on the boundary BOTH ways (600s joins, 601s splits); FIRST record per session wins inside
  an episode, so a session that died twice is listed once with its EARLIER error; `.slice(0,200)`
  and `.slice(0,160)` are UTF-16 (the fixture error is 125 emoji, so a byte cut keeps a different
  amount); `.slice(-max).reverse()` is newest-FIRST while `episodesTotal` counts them all; and the
  empty-window branch returns a DIFFERENT key set (no `episodesTotal`, no `attributed`) that says
  capture may simply not be installed — an empty result is never an all-clear.
  The `investigate` parameter is the TS's OWN test seam, kept as a closure returning `Result` so the
  oracle can stub the scan AND drive the catch branch; production always returns `Ok`.
  **Falsified, 4 rules:** boundary `<=`→`<`; last-record-per-session wins; `topFindings` "improved"
  to use `cause`; byte-indexed error truncation.
- **P4x.2h DONE: `store/bodiesEvidence` (217) → `agentlens-store::bodies_evidence`.** No tool — an
  NPT. Sizing `cacheBreakTimeline` BY ENGINE found it: `cacheBreakTimeline` imports
  `store/bodiesEvidence`, which had NO `.rs` counterpart. FIFTH time that check paid.
  **It is NOT SQL-blocked** the way `compare_configs`/`burn_seismic` are: `agentlens-store` already
  bundles DuckDB (`open_store`, `parquet_scan`, `sections::{Part, reassemble, sha256_hex}`) and
  `agentlens-core` already depends on that crate — so this landed in the STORE crate, mirroring the
  TS `src/store/` layout, and needed no new dependency.
  **⚠ THIS ORACLE IS DIFFERENT IN KIND from every other one on this card.** The fixture is a REAL
  Parquet store WRITTEN BY THE TYPESCRIPT store (`tests/fixtures/evidence-store/`, 12K) and the Rust
  reader reads it. So it checks the ON-DISK COMPATIBILITY BOUNDARY the store's module doc claims,
  not merely that two implementations agree on logic — a Rust-written store would pass while proving
  nothing. Regenerating renames the parquet parts (the filename embeds a timestamp + pid), so a
  regen shows in git as delete+add, never modify.
  **What the fixture pins** (the measured 2026-08-13 incident): `aaa` is flushed then DRAINED from
  the spool and must STILL be evidence and still reconstruct — the vanished-turn regression, where a
  break classified at 01:08Z ceased to exist by the next run and one session's turn count visibly
  shrank 172 → 145 over identical history. `bbb`/`ccc` are in BOTH places and must yield exactly ONE
  row each (the store's), or a caller double-counts every turn for the length of the drain lag.
  `ddd` is spool-only with body_id/session_id/ts all NULL — the spool name is an opaque uuid and
  reading it to learn the session is the read-everything cost this module exists to remove.
  **⚠ A BEHAVIOUR THAT LOOKS LIKE A BUG AND MUST NOT BE "FIXED":** `inStore` is built from the rows
  the filter KEPT, so a store row the filter EXCLUDED can reappear as a SPOOL row. Measured: under
  `sessionId='sess-A'`, `ccc` (sess-B) is filtered out of the store half and its spool copy is
  appended — a row the caller's own filter excluded, carrying no session at all. Pinned.
  **Rust-side notes:** every DuckDB column is read as a NULLABLE STRING, because parquet parts
  written at different times carry mixed integer widths and a typed getter that guesses `i64` fails
  at runtime on the part that stored `i32`; `duckdb::types::Value` has no `Display`, so the widths
  are spelled out explicitly rather than debug-formatted. `selection` is `&mut` because the TS
  mutates the caller's rows when it resolves a fallen-through spool row's body_id.
  **Falsified, 2 rules:** dropping the store/spool dedup (6 rows vs 4 — the mid-drain double-count);
  starving `reassemble` of its blob spans, which made the sha256 gate FIRE and refuse the bytes —
  proving the end-to-end proof works rather than asserting it does.
- **NEXT (P4x.2d continued): 7 of 53 remain, and EVERY ONE needs a big engine or a SQL binding —
  the cheap tail is gone.** Immediate: `cacheBreakTimeline`, now UNBLOCKED (1,927 → 2 tools:
  `get_cache_break_timeline` + `get_cache_break_causes`, and it also unblocks the `groupBy='cause'`
  branch above). **SLICE IT IN FOUR — 1,927 lines will not fit one context alongside an oracle and
  a parity test.** The seams are already clean in the TS, by line:
  1. **Classification primitives (48-635, ~590):** the cause enum + `EXPECTED_CAUSES` +
     `CACHE_BREAK_REMEDIATION`, `minCacheableTokensFor`, `classifyContentKind`, `segmentInjected`,
     `extractTurnPrefix`. Pure functions over a raw request — the cheapest slice to pin.
  2. **`classifyCacheBreak` (637-1025, ~390):** the verdict engine, `prev`/`cur`/`prev2` +
     `BreakTiming`. Pure; its oracle is a table of prefix pairs.
  3. **`buildCacheBreakTimeline` + compaction-hook evidence (1026-1657, ~630):** the I/O half —
     this is the one that consumes `bodies_evidence` (just landed), `readHookEvents`,
     `loadCompactionHookInfo`, `applyCompactionHookEvidence`.
  4. **Reports (1658-1927, ~270):** `buildCauseCostPeakReport`, `buildCacheBreakCauses`,
     `formatTimeline` — wires BOTH tools and the `groupBy='cause'` branch.
  Its other imports are all landed: `rawBodyContext.parseUserId` ✓, `logReader.claudeProjectsDirs`
  → `agentlens_logscan::discovery` ✓, `tokenEstimator` ✓, `shared/pricing` ✓, `hookEventStore` ✓,
  and the `cacheCreationForensics` re-exports (`defaultBodiesDir`, `bucketValueOf`,
  `tokenCountsFullCost`/`Total`, the caps) ✓.
  THEN → `subscriptionUsage` (976, **NETWORK** — the oracle MUST stub the Anthropic usage
  endpoint; it is also the live TTL-regime oracle) → the 2 sql tools (`run_diagnostics_sql`,
  `run_transcript_sql`) — and `compare_configs` AND `burn_seismic` NOW SIT WITH THEM, per the two
  re-sizes above (both need a SQL/DuckDB binding the crate lacks).
  **SIZE BY ENGINE: before starting any handler, grep its imports for a module with no `.rs`
  counterpart** — that check caught `effortTransitions`, `residentCost`, `forensicsDb`, and now
  `burnSeismic`'s `ndjsonDuck`, and skipping it mis-sized this queue three times before that.
  **SUPERSEDED — do NOT carry forward:** every earlier "next up" ordering in this block (the
  handler-line-count orderings that named `handleGetCacheBreakReport` 81 / `handleGetCostByCause`
  82 / `handleGetContextInflationReport` 90 / `handleGetAgentTokens` 102 / `handleCheckCacheExpiry`
  110 / `handleGetCacheRiskCosts` 138, and the "heavyweights last" plan that listed
  `cacheCreationForensics` as unstarted). All of those are LANDED; the list above is the only live
  queue.
  `subscriptionUsage.ts` (797 ln — also the TTL-regime oracle; NETWORK: calls Anthropic's usage
  endpoint, so the oracle must stub). Heavyweights (forensics / timeline / investigator / sql)
  last. **Every new arm must end in `tool_ok_lean`, never `mcp::tool_ok`.** The dispatch cases are
  `src/mcpServer.ts` ~3434-3890 and most shapers sit at 1617-3390 (largely UNREAD).
  `get_context_composition` (2438), `get_context_history` (2325), `get_conversation` (2391) — all
  three shapers are in `src/mcpServer.ts` and UNREAD except their heads; each has `turn` / range
  filtering and caps (`CONVERSATION_RANGE_CAP`, `CONVERSATION_SUMMARY_TURN_CAP`) plus a
  `verbatimTurn` helper. Then burn / cache-risk / statusline. Still unported and MCP-only:
  `imageReport` / `findResidentBlobs` / `queryBlocks` in contextCompositionIndex.ts — purely
  ADDITIVE, they reuse the core landed in P4w.1c(ii)a/b.
- **ALSO PENDING (not blocking P4x): the dedicated MCP listener.** `/mcp` is served on the UI
  listener today; the CLI defaults to `http://localhost:4316/mcp` (`AGENTLENS_MCP_URL` repoints
  it). `alcore serve` has no `--mcp-port` yet.
- **(historical) P4w.2 COMPLETE.** Rows 32, 33, 34, 36, 37 went live before row 35. Row 35's
  contract and its lock choreography (lock → `resolve_request` → CLONE the pointer → UNLOCK →
  blocking read/parse → RE-LOCK → account backfill via `account_registry`) are IMPLEMENTED as of
  82281c1 — this bullet is a record, not a pending instruction. The composition query engine
  (`imageReport` / `findResidentBlobs` / `queryBlocks`) is still unported but purely additive.
- **THEN P4w.3 row 35**
  (`resolveCallContext`, contract two bullets below). After those the HTTP §1 table is complete.
  `imageReport` / `findResidentBlobs` / `queryBlocks` remain unported — MCP-surface only, and the
  MCP surface is a separate frozen contract (53 tools); they reuse the core that landed in
  (ii)a/(ii)b, so they are additive, not a rewrite.
- **(landed above) the (ii)b contracts, kept for reference:** `aggregateResidents` (signature = `` `${kind}|${label}` ``;
  **`bySig` MUST be an IndexMap** — the pre-sort insertion order is the stable-sort tie-break
  beyond the two comparators, so a HashMap silently reorders equal-cost rows), `summarizeImages`
  (`firstSeenTurn === 0` is the sentinel; count/tokens are MAX across calls, cumulative is Σ),
  `buildSessionComposition` (a null call is SKIPPED but `callsTotal` counts refs, not parsed
  calls — that gap IS the coverage honesty), `ContextCompositionIndex` (`cache` is an
  insertion-ordered LRU, re-insert on hit, evict oldest past `maxSessions=64`),
  `sessionCompositionSummary` (peak = max contextTokens, `otherTokens` clamped ≥0,
  `+(pct*100).toFixed(1)` → `js_to_fixed_num(x,1)`, `residentBlobs.slice(0,15)` + `findSample`),
  and `getBlockContent` (two distinct ERROR shapes: `{sessionId,turn,message}` when no pointer,
  `{sessionId,turn,blockIndex,message}` when no block — both 200, not an error status).
  Deferred with it: `imageReport` / `findResidentBlobs` / `queryBlocks` are MCP-surface only, not
  needed by rows 36-37. Note `+x.toFixed(4)` → `js_to_fixed_num(x,4)` throughout.
- **Composition gotchas that outlive the slice.** The index consumes three already-landed pieces:
  `call_body_registry` (`session_ids` / `request_pointers` — the LAZY contract, never a full-disk
  sweep of the 20k+ body files), `build_call_context`, and `IMAGE_BLOCK_LABEL_PREFIX` — image
  re-classification keys on that LABEL PREFIX, so do NOT "clean it up" into a real ContextBlockKind
  (a dedicated shared kind ripples into the residentCost Record and the webview mirror; that is
  why the TS parks images in the `other` bucket and re-detects them by label).
- **THEN (P4w.3, freeze row 35): `resolveCallContext`.** Deliberately NOT ported with the wrapper
  — it is route-level ORCHESTRATION, and doing it in the pure module would force file I/O under
  the CoreState lock (the P4s rule). Its shape must be: lock → `resolve_request` → CLONE the
  pointer → UNLOCK → blocking read/parse off the executor → RE-LOCK → account backfill. Contract:
  `registry.resolveRequest` → `bodyRef` ? file : `inlineBody` ? parse : null, then FOUR
  post-assignments on the result: `ctx.sessionId = sessionId` (overwrite), `ctx.requestId =
  sel.requestId ?? ptr.requestId ?? ctx.requestId`, `if (!ctx.model) ctx.model = ptr.model`
  (falsy, not nullish), and `if (ctx.accountUuid) registry.recordAccount(...)` — the
  TRDD-BURNWDGT backfill that makes account attribution work for sessions whose OTEL events
  never carried the attribute. NOTE those add `requestId` to the wire object AFTER `truncated`,
  so the key order of a resolved context differs from a freshly-built one — a parity test that
  only ever exercises freshly-built contexts will not see that, so assert it explicitly.
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
