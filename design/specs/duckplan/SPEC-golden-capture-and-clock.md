---
title: SPEC U0 - golden capture of the current alcore and the clock seam
status: draft
unit: U0
created: 2026-10-03
inputs: reports/DUCKPLAN/20261003_171551+0200-operation-contracts.md (OC), reports/DUCKPLAN/20261003_165118+0200-concurrency-and-flaws.md (CF)
---

# SPEC U0 - golden capture of the CURRENT alcore, and the clock seam

Rationale (one sentence): the DuckDB-index rewrite must be provable field by field against what alcore answers today, so every operation of the current build is captured under a frozen clock, frozen corpus and pinned environment, and the same capture is later replayed on the rewrite and compared.

Citation key: `OC §x` = operation-contracts report section or entry id; `CF Hn` = concurrency-and-flaws hazard. Paths under `rust-core/crates/agentlens-core/src/` are written bare (`ui.rs:1309`). Anything not read in code this session is marked UNVERIFIED. Existing oracles to reuse, not replace: `tests/update_payload_parity.rs` (pinned clock, OC F1 (f)), `ctxcomp_parity.rs` (pins `generatedAtMs`, OC §7.3 seam paragraph).

## 0. Scope and non-goals

- In scope: all 126 operations of OC key finding 1 inventory = 48 HTTP route/method pairs (H1-H44), 53 MCP tools (Q1-Q53), 4 SSE frame types (F1-F4; F4 never emitted) plus the initial comment F0, 6 shell placeholders (OC §5.2), 15 dashboard view entries (V0-V14).
- Not in scope: changing any behaviour of the current alcore other than the seams of section 1 (each seam is inert unless its env var is set). No new data tables. The rewrite is compared, not designed, here.
- Two suites, same harness: `tiny` (a small synthetic tracked fixture corpus, ALL 126 operations including writes, minutes, runs in CI and in the harness tests) and `full` (the frozen real corpus, READ operations only, local machine, hours of boot). Mutating operations are never run against the real corpus (section 3.4).

## 1. Clock and environment seams (changes to alcore, all inert by default)

### 1.1 `AGENTLENS_NOW_MS`

`crate::now_ms()` at `lib.rs:911` becomes: read env `AGENTLENS_NOW_MS` once into a `OnceLock<Option<i64>>`; when set return that value on every call, else the existing `SystemTime` path. Cost: one atomic load per call.
Fail-fast guards (the footgun is a stray variable freezing production time silently):
1. alcore refuses to start (exit non-zero, message on stderr) when `AGENTLENS_NOW_MS` is set and `AGENTLENS_GOLDEN_CAPTURE=1` is not.
2. When both are set, alcore prints one loud stderr line `CLOCK FROZEN at <ms>` at boot (`bin/alcore.rs` near the `AGENTLENS_STARTED_BY` stamp at `bin/alcore.rs:146`).
3. Value must parse as a positive integer, else exit non-zero (no fallback).
Consequences to accept: ingest stamps (`receivedAt` `span_window.rs:59-60`, `last_ingest_activity_ms` `ui.rs:1531`, `build_id` `lib.rs:640`, hook `ts`, statusline stamp `statusline_store.rs:323`, OC §7.3 E) all equal the pinned value; `server-stats.uptimeSec` is 0; `startedAt` equals the pin. That is intended: they become deterministic.

### 1.2 Optional clock stepping (only for the two behaviours that need time to pass)

Two captures need two different instants inside one process: the agent-gate advisory dedupe window `ADVISORY_DEDUPE_MS` (H23, `ui.rs:1871`, OC §7.3 A) and burn alert expiry (F3). Spec: when `AGENTLENS_CLOCK_CONTROL=1` (requires the two variables above) alcore exposes `POST /api/debug/clock {"nowMs": <int>}` under the existing `/api/debug/` namespace (`ui.rs:1722-1797`), which replaces the pinned value (monotone forward only; a smaller value returns 400). Without the flag the route does not exist (falls to the bare 404, H43). OWNER DECISION NEEDED: this adds a debug route; alternative is to capture H23 dedupe only in the Rust integration test `tests/ui.rs:939` and mark the HTTP dedupe variant UNCAPTURED in the manifest.

### 1.3 Private and second clocks (OC §7.3 C) - exhaustive list and the seam for each

| Site | Problem | Seam |
|---|---|---|
| `cache_break_timeline.rs:2057-2059` private `fn now_ms() -> f64`, used at `:2139, :2518, :3082` (Q41, Q42) | second clock independent of the handler `now` | delete the private fn, call `crate::now_ms() as f64` (verified: private fn exists at line 2057) |
| 20 s scan deadlines `mcp_tools.rs:2466-2470` (Q12), `:2835-2842` (Q27), `:3007-3016` (Q28), `:3454-3459` and `:3502-3508` (Q21); passed as `20_000.0` from `ui.rs:2415, 3581, 3652, 3724` | wall-clock budget makes COVERAGE non-deterministic (OC finding 8) | new env `AGENTLENS_SCAN_BUDGET_MS` (default 20000; value `0` = unlimited), read in one helper used by all four `ui.rs` call sites. UNVERIFIED which clock the deadline compares against (Instant or now_ms); the acceptance test in 7 (A6) proves it by asserting the goldens report `stoppedEarly:false` / `complete:true` |
| keychain 3 s deadline `burn/account_info.rs:125-138` | would only matter if the keychain is read | capture with the keychain opt-in gate OFF (`keychain_read_allowed`, OC Q53 (c)); no seam needed; assert in the manifest that the gate is off |
| log sweep budget `log_reader.rs:1331-1340` | a budget-cut boot sweep gives a partial corpus (CF H18) | new env `AGENTLENS_SWEEP_BUDGET_MS` (`0` = unlimited). UNVERIFIED the exact semantics of the budget at that site; read it before implementing |
| serve-stale `STALE_BUDGET_MS = 500` `ui.rs:138`, rebuild gating `Instant` `ui.rs:285-317`, 25 ms rebuild loop `ui.rs:138-260` | a reader may get a summary up to 500 ms stale | new env `AGENTLENS_STALE_BUDGET_MS` (`0` = readers always wait for a fresh summary). Instant gating needs no seam once the readiness criterion (section 2.4) proves `data_version` is stable |
| `SLOW_CACHE_MS` refresh of account/TTL signals `burn/runtime.rs:78-87`, 4 s burn tick `ui.rs:4144-4310` | signals refresh on a timer | no seam; the readiness criterion waits for two full burn ticks (>= 9 s) before the first request, and the account-state file is read from the frozen copy |

### 1.4 Other pins (no code change, environment only)

| Input (OC §7.3) | Pin |
|---|---|
| Filesystem mtimes (D, 20 files listed there) | capture on an immutable snapshot cloned with mtimes preserved (section 2.1); `AGENTLENS_NOW_MS` = snapshot instant so every window is relative to the same `now` as on the live machine at snapshot time |
| Time zone (F) | `TZ=UTC` in the process env AND a seam for `DisplayZone::system()` (`cache_event_log.rs:55-66`, uses `iana_time_zone`, which on macOS reads the system zone, not `TZ`: UNVERIFIED). New env `AGENTLENS_DISPLAY_TZ` (IANA name) consulted first by `DisplayZone::system()`; capture sets `Etc/UTC`. Test (A7): Q45 golden `timezone` equals the pin. Span segment day keys are UTC already (CF H15 item 3, `writer.rs:138-141`); the `session_summary_sql.rs:81` comment says local: do not fix, just record the observed behaviour in the golden |
| Process env (G) | `CLAUDE_PROJECT_DIR=<RUN>/project`, process cwd `<RUN>/project`, `HOME=<RUN>/home`, `CLAUDE_CONFIG_DIR=<RUN>/home/.claude`, `DATA_DIR=<RUN>/data`, no inherited `AGENTLENS_*` other than those listed in this spec (the harness launches with `env -i` plus an explicit list) |
| Memory pressure and admission (G) | `AGENTLENS_RSS_HARD_CAP_MB=65536` (`rss_guard.rs:32`, default 2048, `lib.rs:794`), `AGENTLENS_MAX_RSS_MB=65536` (`admission.rs:94`), `AGENTLENS_MIN_FREE_DISK_MB=0` (`admission.rs:95`). Purpose: no 503 backpressure shedding (OC §1.4) and no memory-pressure window shrink to 300 s (OC §4 last paragraph, `lib.rs:743`) while capturing |
| Ports (CLAUDE.md "Operations") | `UI_PORT`, `MCP_PORT`, `OTLP_PORT` pinned to free ports away from the live server (a pinned port is honoured exactly, a busy OTLP port refuses to start; the live OTLP 4318 never moves). The harness picks three free ports per run and records them in the manifest |
| Single instance | the capture root has its own `DATA_DIR` and `HOME`, so the data-dir pid lock (`pid_lock.rs`, CLAUDE.md) does not collide with the live collector; any `server.pid`/lock file cloned from the live data dir is removed from the RUN clone before launch (regeneratable runtime state, not user data) |
| Provenance stamp | `AGENTLENS_STARTED_BY="golden-capture"` (`bin/alcore.rs:146`) |
| Browser clocks (OC §7.3 H) | out of scope for server goldens (V0-V14 handled in section 3.6) |

## 2. Frozen corpus and the isolated instance

### 2.1 Snapshot, then one clone per run

1. `SNAP=reports_dev/golden/snapshots/<yyyymmdd_hhmmss%z>` (gitignored, `/reports_dev/` is in `.gitignore:41`).
2. APFS clone with preserved metadata, one command per source: `cp -c -p -R ~/.claude/projects $SNAP/home/.claude/projects`; same for `~/.codex/sessions`, the copilot data dir, the OpenCode data dir (default location UNVERIFIED; `OPENCODE_DATA_DIR` overrides it, CLAUDE.md gotcha on `src/logReader.ts`), `~/.claude/plugins/cache` (Q51), `~/.claude.json` and `~/.claude/settings.json` (NS-4 inputs, OC §7.1), and the WHOLE `~/.agentlens` as `$SNAP/data`. `-p` is mandatory: without it `cp -R` stamps new mtimes and every mtime-windowed operation (OC §7.3 D) changes meaning.
3. `chmod -R a-w $SNAP`; write `$SNAP/MANIFEST.json`: snapshot instant `NOW_MS` (taken immediately before step 2; every cloned mtime is <= it), per-source file counts and total bytes, `git rev-parse HEAD` of the alcore under test, sha256 of the alcore binary, `uname -a`, tool versions.
4. Disk cost: a clone shares blocks until a file diverges, so the snapshot itself costs ~0 extra bytes on APFS (UNVERIFIED on this volume: confirm with `df` before and after, and that `~/.claude/projects` and the target are on the same APFS volume, otherwise `cp -c` silently falls back to a full copy; the harness checks and refuses to continue on a cross-volume copy).
5. EVERY capture run starts from `cp -c -p -R $SNAP $RUN` (a clone of the pristine snapshot) and never runs against `$SNAP`. Reason: alcore mutates its own data dir while running (bodies pass extracts `api_call` facts then DELETES bodies, OC §4 chores row; retention purge; log-offset and card persistence; `account-state.ndjson` written every 4 s on change, OC Q20), so a second run on the same root would see different inputs and the determinism check of section 4 would flag the harness, not the product.
6. Private data: the snapshot holds the user transcripts, account email and tokens-adjacent files. It stays under `reports_dev/` and is never committed or uploaded. `~/.claude.json` is cloned because NS-4 operations read it (OC §7.1); the keychain is NOT read (gate off, section 1.3).

### 2.2 Tiny synthetic corpus (tracked)

`rust-core/crates/agentlens-core/tests/fixtures/golden-tiny/` (new, tracked, hand-built, contains no real identity; follow `scripts/check-no-identities.js`): at least one Claude root session with a spawned child (placeholder `<parent>-sub-<toolUseId>` plus an `agent-<id>` transcript so the link merge `feed_merge.rs:150-225` runs), one Claude session with a 1 h cache write tier, one Codex, one Copilot, one OpenCode session (reuse existing parity fixture files under `tests/fixtures/` where they fit, e.g. the `bodies`, `acct-state.ndjson`, `agentgate-tree` entries visible there), one OTEL-only session POSTed to the OTLP port at the pinned clock, one OTEL twin of a Claude log session (exercises the displaced-twin merge, OC §1.1), raw API request/response bodies for the B operations, a hook-events ndjson, an `account-state.ndjson`, instruction files for H26-H28. It is the only corpus on which write operations run.

### 2.3 Launching the instance

`env -i` plus: `HOME`, `TZ=UTC`, `CLAUDE_CONFIG_DIR`, `CLAUDE_PROJECT_DIR`, `DATA_DIR`, the three ports, `AGENTLENS_NOW_MS=<NOW_MS>`, `AGENTLENS_GOLDEN_CAPTURE=1`, `AGENTLENS_SCAN_BUDGET_MS=0`, `AGENTLENS_SWEEP_BUDGET_MS=0`, `AGENTLENS_STALE_BUDGET_MS=0`, `AGENTLENS_DISPLAY_TZ=Etc/UTC`, `AGENTLENS_RSS_HARD_CAP_MB=65536`, `AGENTLENS_MAX_RSS_MB=65536`, `AGENTLENS_MIN_FREE_DISK_MB=0`, `AGENTLENS_STARTED_BY=golden-capture`, and `AGENTLENS_CLOCK_CONTROL=1` only for the tiny suite. Binary: the same `alcore` the live server uses (`bin-native/darwin-arm64/alcore`); do not copy or re-sign it (CLAUDE.md codesign trap: exit 137 means unsigned). The binary command line flags are UNVERIFIED (`bin/alcore.rs` not read in full); the harness reads them at implementation time. The harness owns the child process: it starts it, records its pid, and ALWAYS terminates it in a `finally` (SIGTERM, then verifies exit; a leaked child fails the run, per the project testing rule).

### 2.4 Readiness criterion (when capture may begin)

All of the following, polled by the harness, in order, with a hard timeout (default 6 h for `full`, 5 min for `tiny`; on timeout the run FAILS, never captures partial):
1. The UI port answers `GET /api/server-stats` with 200. The boot sweep completes BEFORE the server answers (`log_reader.rs:1424-1450`, `boot_rx` handshake, CF H18), so a 200 already means the boot sweep finished; the harness still asserts `stderr` contains no sweep-error line.
2. `GET /api/debug/log-scan-stats` field `dataVersion` (H20, `ui.rs:1797`) is unchanged across 3 consecutive polls 6 s apart (>= one `PUSH_COALESCE_MS = 4000` window and 1.5 burn ticks). This also waits out the 1 h backfill, which stamps `cacheCreate1hTokens` 200 cards per step (`log_reader.rs:745-1100`, OC §4). UNVERIFIED that the backfill bumps `dataVersion` on every step; therefore criterion 3 is the real gate.
3. The sha256 of the canonical-JSON `GET /api/summary` body is identical across 3 polls 10 s apart.
4. At least two burn ticks elapsed since step 1 (>= 9 s), so `account-state.ndjson` and burn status are settled.
5. `/api/summary` has `sessions.length > 0` (a zero-session capture is a harness failure) and, for `full`, the count equals the count recorded in `$SNAP/MANIFEST.json` from a prior accepted run once one exists (first accepted run records it).

## 3. Capture harness

### 3.1 Files (all tracked; goldens are NOT)

| File | Role |
|---|---|
| `scripts/golden/requests.json` | the request list of section 3.3 (code, tracked) |
| `scripts/golden/capture.py` | launcher plus requester (Python 3.12, stdlib only: `http.client`, `json`, `subprocess`; run as `uv run scripts/golden/capture.py`) |
| `scripts/golden/compare.py` | comparator of section 5 |
| `scripts/golden/normalize.json` | volatile-field rules of section 4 |
| `scripts/golden/sets.json` | declared unordered arrays (section 5) |
| `design/specs/duckplan/CONTRACT-DELTA.md` | allowlist of permitted differences (section 5.4) |
| `scripts/golden/tests/` | tests of the harness itself (section 6) |
Python is chosen over Node because `JSON.parse` loses integer-key order and integers above 2^53, and object key ORDER is part of the contract (OC §1.4 Strip key order pinned byte for byte by `tests/ui.rs:2235`; OC Q1 row keys "in LITERAL order"). Python `json` keeps insertion order and exact integers; `parse_float=Decimal` keeps the lexeme. Location is an owner decision (UNVERIFIED repo convention for non-Rust harness code).
Goldens: `reports_dev/golden/<suite>/<alcore-git-sha>/<opId>/<variantId>.json` (gitignored: they contain private transcripts, workspaces, accounts, prompts). A tiny-suite golden set is synthetic and MAY be committed under `rust-core/crates/agentlens-core/tests/fixtures/golden-tiny-expected/` so CI can compare without the real corpus (owner decision; default: commit them).

### 3.2 One golden file per (operation, variant)

```
{ "op": "Q1", "variant": "default", "request": {...exact bytes sent...},
  "status": 200, "headers": {allow-listed: content-type, cache-control, vary, content-security-policy, retry-after},
  "body": <parsed JSON, key order preserved> | {"_text": "..."} | {"_sha256": "...", "_bytes": n},
  "mcp": {"textParsed": <JSON parsed from result.content[0].text>}   // MCP only
}
```
HTTP bodies that are JSON are stored parsed; HTML and static assets as text (HTML) or sha256 (binary). For MCP the JSON-RPC envelope is kept and the inner text string is also stored parsed (`textParsed`) so field comparison does not diff an escaped string. The raw bytes of every response are also stored beside as `<variant>.raw` (gzip) so a comparator bug can be re-checked without re-capturing.

### 3.3 Fixture selection (the ids the requests need)

A probe step runs first and writes `fixtures.json` into the golden dir (itself compared like a golden): from `GET /api/summary` (sorted per OC §1.1) it picks deterministically, by rule, never by hand: `S_CLAUDE_PARENT` (newest claude_code root with >= 1 child), `S_CLAUDE_CHILD` (its first child by `seq`), `S_CLAUDE_PLAIN` (newest claude_code root with no child and a transcript), `S_CODEX`, `S_COPILOT`, `S_OPENCODE`, `S_OTEL_ONLY` (`dataSource` otel, no log twin), `S_DISPLACED` (log card that displaced an OTEL twin, `coverageNote` present), `S_NO_TRANSCRIPT` (card with no `.jsonl`), `S_1H` (non-zero `cacheCreate1hTokens`), `AGENT_ID` (child `agent-<id>`), `WS` (workspace of `S_CLAUDE_PARENT`), `REQ_ID`/`SPAN_ID` (first call in `S_CLAUDE_PARENT` timeline, from H39), `ACCT` (an `accountId` from the burn status). A role with no candidate is recorded as `null` and its variants are emitted as `UNCAPTURED(reason)` in the manifest (never silently skipped). Each variant lists its fixture roles; the same selection rule on the rewrite must give the same ids (the probe golden proves it).

### 3.4 Request table (derived from OC; `R` = read, runs in `full` and `tiny`; `T` = state-changing or side-effecting, `tiny` only, in the fixed order of 3.5)

Every HTTP variant is sent twice: once plain, and (for the admission/CORS gate H-gate, OC §1.4) once with `Origin: http://evil.example` on non-GET routes only inside the single dedicated gate variant H-GATE below, never elsewhere.

| Op | Request variants | Phase |
|---|---|---|
| H1 `ANY /events` | see section 3.7 (SSE) | R |
| H2 `GET /api/summary` | plain | R |
| H3 `GET /api/server-stats` | plain (structure-only compare, section 4) | R |
| H4 `GET /api/embed-status` | plain; `x-agentlens-viewer: bogus` (expect the 403 of OC §1.4) | R |
| H5 `GET /api/hook-config` | plain | R |
| H6 `POST /api/hook-config` | valid patch `{"captureEnabled":false}`; invalid key; body of 8193 bytes (cap 8192) | T |
| H7 `POST /api/clear` | plain (LAST in the order) | T |
| H8 `POST /action` | `{"type":"clearAll"}`; other JSON; malformed JSON | T |
| H9 `POST /api/statusline-samples` | main sample; `statusline_stream:"subagent"`; non-object; bad JSON | T |
| H10 `POST /api/hook-events` | statusline-routed event; a lifecycle event; malformed | T |
| H11 `GET /api/hook-events` | no query; `session=S_CLAUDE_PARENT`; `ev=`; `since`/`until`; `limit=0`, `limit=1`, `limit=1001` (clamp 1..1000) | R |
| H12 `GET /api/lifecycle-events` | no query; `limit=1`; `kinds=` list; `session=S_CLAUDE_PARENT` | R |
| H13 `POST /api/import` | valid `{sessions:[...]}` with `tokensSource` log, otel, merged; `{}` (400); bad JSON (400) | T |
| H14 `POST /api/write-prompts-file` | claude, codex, copilot; body is written into `<RUN>/project` | T |
| H15 `POST /api/branch-dump` | valid slug; slug with `..`; unknown slug | T |
| H16 `GET /api/debug/codex-store-groups` | plain | R |
| H17 `GET /api/debug/span-attr` | `traceId`+`spanId` of an OTEL span, default key; `key=` other; `fromMs` omitted (default `now-24 h` under the pinned clock) | R |
| H18 `GET /api/debug/capture-activity` | plain | R |
| H19 `GET /api/debug/requests` | plain, captured LAST of the R group (it records the harness own traffic; structure-only, section 4) | R |
| H20 `GET /api/debug/log-scan-stats` | plain (counters volatile, section 4) | R |
| H21 `GET /api/burn-status` | plain | R |
| H22 `GET /api/burn-risk` | plain (OC §7.2: NO existing test, so this golden is the only pin) | R |
| H23 `POST /api/agent-gate` | allow (non-matching tool); deny; warn; advisory; advisory repeated (dedupe, clock step per 1.2); bad JSON (204) | T |
| H24 `GET /api/cache-risk-commands` | plain; `window=1`; `limit=1`; `kinds=` list | R |
| H25 `GET /api/generated-file` | path inside scratch; path outside (blocked); missing | R |
| H26 `GET /api/instruction-suggestions` | `workspace=WS`; missing (400); blank (400) | R |
| H27 `GET /api/instruction-files` | `workspace=WS` | R |
| H28 `POST /api/instructions/apply` | each allowed target; disallowed target; escaping path | T |
| H29 `POST /api/bodies/export` | selection of a fixture session | T |
| H30 `POST /api/bodies/purge` | plain (after H29, destroys the body fixtures: runs after every B read) | T |
| H31 `GET /api/collector-gaps` | plain | R |
| H32 cards family | `/api/cards/page` (no query; `limit=1`; `limit=200`; `limit=0` 400; `limit=201` 400; `cursor=<last_active_ms>:<seq>` taken from the previous page; bad cursor 400); `/api/cards/children?parentId=S_CLAUDE_PARENT` (+ missing 400); `/api/cards/by-ids?ids=A,B,unknown`; `/api/stats/overview` | R |
| H33 `GET /api/composition/:id` | `S_CLAUDE_PLAIN`; `S_CLAUDE_CHILD&parent=S_CLAUDE_PARENT`; `S_NO_TRANSCRIPT` (null); percent-encoded id | R |
| H34 `GET /api/history/:id` | same four as H33 | R |
| H35 `GET /api/conversation/:id` | same four as H33 | R |
| H36 `GET /api/composition-index/:id` | `S_CLAUDE_PARENT`; unknown | R |
| H37 `GET /api/block-content/:id/:turn/:blockIndex` | valid `1/0`; `full=1`; non-numeric (400); empty segment (parses as 0, OC H37); image block (no bytes) | R |
| H38 `GET /api/callcontext/:id[/:requestId][?span=]` | id only; with `REQ_ID`; with `span=SPAN_ID`; unknown. Side effect: records the account (OC H38), so it runs after every `accountId`-reading R operation (3.5) | R* |
| H39 `GET /api/timeline/:id` | `S_CLAUDE_PLAIN`; `S_DISPLACED` (OTEL graft, OC H39 (d)); `S_CODEX`; `S_OTEL_ONLY`; unknown (defaults); a cold card (timeline demoted, forces the reparse WRITE, OC key finding 7) | R* |
| H40 `GET /mcp` | plain | R |
| H41 `POST /mcp` | `initialize`; `tools/list`; unknown tool (-32601); unknown method (-32601); no method (-32600); no tool name (-32602); `get_account_status {all:true}` (-32601 not implemented); oversized body >4 MB (rejected) | R |
| H42 `GET /` and `/index.html` | plain; `x-agentlens-viewer` unverifiable (403) | R |
| H43 static + 404 | `/dashboard.js`, `/dashboard.css`, `/sidebar.js` (sha256), `../` traversal, unknown path, `OPTIONS /api/summary`, `OPTIONS /mcp` on the MCP port | R |
| H44 OTLP `POST /v1/traces`, `/v1/logs`, `/v1/metrics` | fixture payloads at the pinned clock (this is how the tiny corpus gets its OTEL half) | T |

MCP tools (H41 transport, MCP port): each tool is captured as `default` (lean) and `full` (`verbosity:"full"`, OC §1.4: the lean wrapper is universal and undocumented, so both modes are pinned) plus the listed argument sets. `maxTokens:200` is added on Q1, Q10, Q24, Q39 to pin the shaping rule (arrays capped at 5, strings clipped at 400/160, `_truncated[]`).

| Op | Argument sets beyond `{}` (fixture roles in caps) |
|---|---|
| Q1 get_recent_sessions | `limit:3`; `limit:-2` (JS slice, drops from END); `limit:100` (min 50); `agent:"claude_code"`; `workspace:<substring of S_CLAUDE_PARENT id>` (matches id or prompt, not workspace, OC Q1 (a)); `workspace:WS` (expected near-empty: pins the naming trap) |
| Q2 get_workspace_patterns | `{}`; `days:1`; `days:30`; `workspace:WS` (silently ignored, `ui.rs:2290`); `days:0` |
| Q3 find_relevant_context | `task:"fix the login test"`; `task:"a b"` (no usable words); task with no match; `workspace` ignored |
| Q4 get_efficiency_report | `{}`; `days:1`; `days:365`; `workspace:WS` (ignored) |
| Q5 get_instruction_suggestions | `workspace:WS`; `workspace:"  "` (error); workspace with < 5 sessions |
| Q6 get_session_detail | S_CLAUDE_PARENT; S_CLAUDE_PLAIN; S_1H; S_OTEL_ONLY; S_NO_TRANSCRIPT; unknown id |
| Q7 get_context_growth | S_CLAUDE_PARENT; S_CODEX; unknown |
| Q8 get_subagent_tree | S_CLAUDE_PARENT; S_CLAUDE_CHILD (root becomes the parent); S_CLAUDE_PLAIN; unknown |
| Q9 get_agent_tokens | `agentId:AGENT_ID` (bare); with `agent-` prefix; uppercase; `parentSessionId` scoped; ambiguous prefix (candidates); unknown |
| Q10 get_cost_rollup | each `groupBy` in project, model, session, subagent, all, "bogus" (behaves as session); `windowHours` 0.01 (clamp 0.05), 24, 5000 (clamp 1080); `sinceIso`+`untilIso`; bad ISO; `subagentsOnly`; `parentSessionId`; `liveOnly`; each `sortBy`; `topN` 0, 1, 500 |
| Q11 predict_session_cost | `task:"refactor the parser"`; `+subagentType`; `+fileBytes`; `topK` 1, 12, 99; `task:"ab"` (error); no match |
| Q12 get_cost_by_cause | `sessionId:S_CLAUDE_PARENT`; `days:7`; `days:0`, `days:365` (clamps) |
| Q13 get_burn_status | `{}` |
| Q14 get_session_status | `sessionId:S_CLAUDE_PARENT`; `workspace:WS`; `{}`; unknown sessionId |
| Q15 get_window_budget | `{}`; `accountId:ACCT`; unknown account |
| Q16 get_account_status | `{}`; `all:true` (-32601) |
| Q17 check_burn_risk | `{}`; `fanoutThreshold:1`; `spikeTokensPerMin:1` |
| Q18 get_window_eta | `{}`; `account:"current"`; `account:ACCT`; `rate_window_min:1`; unknown account (Known list) |
| Q19 get_account_burners | `{}`; `account:"previous"`; `interval:"last"`; `limit:1`; unknown account |
| Q20 get_account_state_at | `ts:NOW_MS`; `iso:<NOW as ISO>`; `ts:0`; missing both (error) |
| Q21 check_cache_expiry | `{}`; `sessionId:S_CLAUDE_PARENT`; `all:true`; `project:WS`; `thresholdMinutes:1` |
| Q22 get_context_composition | S_CLAUDE_PLAIN; `+turn:1`; S_CLAUDE_CHILD (no ancestor fallback, OC Q22 (a)); S_NO_TRANSCRIPT |
| Q23 get_context_history | S_CLAUDE_PLAIN; `+turn:1`; `+turn:1,blockId:<first block id>`; S_CLAUDE_CHILD; S_NO_TRANSCRIPT |
| Q24 get_conversation | S_CLAUDE_PLAIN; `turn:1`; `turnFrom:1,turnTo:25` (cap 20); S_CLAUDE_CHILD; S_NO_TRANSCRIPT |
| Q25 get_context_inflation_report | `sessionId:S_CLAUDE_PARENT`; `workspace:WS`; `workspace:""` (all, scan cap 20) |
| Q26 find_context_hogs | `scope:WS`; `scope:<id substring>`; `topN:1`, `topN:99` (max 50) |
| Q27 get_cache_break_report | `sessionId:S_CLAUDE_PARENT`; `workspace:WS` (cap 20) |
| Q28 get_cache_risk_costs | `{}`; `window:168`; `minTokens:1`; `topN:1`; `workspace:WS`; `kinds:["/model"]` |
| Q29 get_skill_attribution | `{}`; `window:24`; `topN:1` |
| Q30 burn_seismic | `{}` (fleet); `scope:"workspace"` without id (error); `scope:"workspace",workspace:WS`; `scope:"session",sessionId:S_CLAUDE_PARENT`; `windowHours:0.05`, `72`; `includeSubagents:true`; `fdrAlpha`, `fdrMethod`, `rateLaw` one each |
| Q31 run_transcript_sql | each `preset` named in `assets/mcp-tools.json` (enumerated at harness build time from the frozen schema, UNVERIFIED list); `sql:"select count(*) c from transcripts"`; invalid SQL; `limit:1` |
| Q32 get_call_context | `sessionId:S_CLAUDE_PARENT`; `+requestId:REQ_ID`; `+spanId:SPAN_ID`; unknown (not captured message) |
| Q33 get_block_content | `turn:1,blockIndex:0`; `+full:true`; bad indices; image block |
| Q34 get_image_report | `{}`; `scope:WS`; `scope:"nonexistent"` |
| Q35 find_resident_blobs | `{}`; `scope:WS`; `kind:"image"`; `minTokens:1`; `minResidentTurns:1`; `topN:1` |
| Q36 query_context_blocks | `{}`; `project:WS`; `sessionId:S_CLAUDE_PARENT`; `groupBy:"kind"`, `"model"`; `kind`, `model`, `minTokens`, `turnFrom`/`turnTo`, `topN:1` |
| Q37 get_body_writers | `{}`; `window_min:1`; `active_min:1`; `limit:1` |
| Q38 get_cache_creation_report | `{}`; each `groupBy` session, account, model, time; `groupBy:"cause"` (error payload, `ui.rs:2745`); `bucket`; `topN:1`; `format:"text"`; `window:24` |
| Q39 trace_expensive_writes | `{}`; `sessionId:S_CLAUDE_PARENT`; `accountUuid:ACCT`; `model`; `minCacheCreate:1`; `minOutputTokens:1`; `turnFrom`/`turnTo`; `timeFrom`/`timeTo`; `chainDepth:1`; `format:"text"` |
| Q40 get_cache_break_gap_report | `{}`; `minCacheCreate:1`; `window:24` |
| Q41 get_cache_break_timeline | `{}`; `sessionId:S_CLAUDE_PARENT`; `scope:WS`; `minTokens:1`; `window:24`; `topN:1`; `format:"text"` |
| Q42 get_cache_break_causes | `{}`; `scope:WS`; `minTokens:1`; `window:24`; `topN:1` |
| Q43 get_heartbeat_cost | `{}`; `marker:"[janitor-heartbeat]"`; `sessionId:S_CLAUDE_PARENT`; `window:24`; `fire:1` |
| Q44 get_session_burn_profile | S_CLAUDE_PARENT; id prefix; `window:24`; empty id (error); unknown |
| Q45 get_cache_event_log | `{}` (format table, window 24); `format:"json"`; `mode:"recent"`; `mode:"peak-with-context",context:2`; `project:WS`; `sessionId:S_CLAUDE_PARENT`; `window:0`; `limit:1` |
| Q46 compare_configs | `groupBy:"model"`, `"session"`; each documented `metric`/`agg`; `filter:{window:24}`; `rankOrder`; `topN:1` (enumerated from the frozen schema, UNVERIFIED list). Side effect: re-index when `forensics.db` is > 5 min stale (OC key finding 7); the first call per run is the one pinned |
| Q47 run_diagnostics_sql | each `preset` (from schema); `sql:"select count(*) c from api_calls"`; `params:{window:24}`; `format:"json"`; `limit:1`; invalid SQL |
| Q48 investigate_burn | `{}`; `windowHours:1`, `24`; `untilIso:<NOW as ISO>`; bad `untilIso` (error); `maxFiles:1` |
| Q49 get_rate_limit_report | `{}`; `windowHours:24`; `maxEpisodes:1`; `maxFiles:1` |
| Q50 get_lifecycle_events | `{}`; `session:S_CLAUDE_PARENT`; `kinds:["clear"]`; `window:1`; `limit:1` |
| Q51 get_loaded_plugin_versions | `{}`; `plugin:<first plugin seen>`; `activeMinutes:0`; `activeMinutes:null`; `staleOnly:true` |
| Q52 get_runtime_inventory | `{}` (operational: presence-and-shape only, section 4) |
| Q53 get_subscription_usage | `format:"json"` and `"table"` with `force:false`, ONLY against a fixture usage cache (the live path performs an HTTPS fetch with the account token, OC Q53 (c)); on `full` the variant is `UNCAPTURED(external service)` |

Count rule (checked by test T4, not a hand number): the harness derives the 126 operation ids from the table headings in this spec, and the request list must contain at least one variant for each id, with `UNCAPTURED(reason)` entries allowed only for the reasons listed in section 7 (A2).

### 3.5 Fixed execution order (state dependence)

1. R operations that read only frozen data, in id order, EXCEPT those marked `R*` and H19/H20.
2. `R*` (H38, H39 cold card): they write (H38 records the account into `st.accounts`; H39 reparses and `put_log_session`s a cold card, OC key finding 7), so any card `accountId` or timeline read AFTER them differs. The golden therefore runs every `accountId`-reading operation first (H2, H21, Q13-Q21, F1/F2) and records, in the manifest, that `R*` ran after them. The rewrite must reproduce the SAME order (the order is part of `requests.json`).
3. H19 and H20 (they observe the traffic above; structure-only).
4. `T` operations (tiny suite only), in the fixed order: H44 ingest first (builds the OTEL half), then H9, H10, H13, H6, H14, H15, H28, H23, H8, H29, H30, H7 last (clear destroys everything).
5. SSE capture (3.7) runs in its own connection pass between 3 and 4 on `tiny`, and in step 1 on `full`.

### 3.6 Dashboard views V0-V14 and shell placeholders S1-S6

- V0-V14 are browser computations over server responses (OC §6 introduction; the dashboard calls only the ops listed there). They are covered TRANSITIVELY: `requests.json` carries a `consumers` map V-id to the H/Q/F ids it consumes (OC §6: V0 and V1 H2/F1/F2; V2 H39 plus H35; V3 H39, H34, H33, H36, H37; V4 H39, H33; V5 H34, H39; V6 H12, H24; V7 F1; V8 none beyond H2; V9 H13; V11 H5, H6, F2; V12 H38; V13 F1) and the harness fails when a V entry maps to an id with no captured variant. V14 (five views exported but never mounted, OC V14) is recorded as `NOT-MOUNTED, no server contract`.
- Additional acceptance gate: the existing `src/test/browser/dashboardSmoke.test.ts` (OC §6) is run once against the golden-corpus instance on both old and new builds; it must pass on both (it asserts every tab renders and zero console errors, light and dark).
- S1-S6 (the six `@@TOKEN@@` placeholders, OC §5.2): one `GET /` capture covers all six (`@@VIEWER_META@@`, `@@BASE_PATH_JSON@@`, `@@BASE_PATH@@`, `@@SESSION_SUMMARY_JSON@@`, `@@BUILD_ID_JSON@@`, `@@SIDEBAR_INIT_JSON@@`), stored as text; the comparator additionally extracts the substituted JSON islands (`__INITIAL_SESSION_SUMMARY__`, `__SIDEBAR_INIT__`, build id) and compares them as JSON, so a token is verified by value, not by HTML text diff. The restricted-viewer branch of `@@VIEWER_META@@` needs an embed key to produce a Restricted role (`embed_auth`, OC H4); no key is configured in the capture env, so that branch is `UNCAPTURED(no embed key)` on both builds, and the OC §7.2 gap (shell substitution with data and the restricted branch untested) stays open for the restricted half.

### 3.7 SSE (H1, F0-F4)

The harness opens `GET /events` with a raw socket (no buffering), reads until it has: F0 the first bytes `:\n\n` (`ui.rs:1152`); F1 the first `data:` frame (type `update`, sent synchronously on connect, `ui.rs:1126`); F2 the first `burnStatus` frame (<= 15 s, the burn tick is 4 s, needs >= 1 client, OC F2); then holds the connection 30 s more and records every further frame type (expected: none, because the data is frozen and `data_version` does not change; this pins "no spurious pushes"). Frames are stored one per file: `H1/F0`, `H1/F1`, `H1/F2`, plus `H1/frames-after-first-30s.json` (list of types). F3 `alert` is captured on the tiny suite by opening an SSE connection, then POSTing the H23 deny payload and reading the frame (OC F3 producer 2; producer 1, new burn alert ids, is captured only when the tiny corpus is built to raise a `window_5h_pct` alert, UNVERIFIED reachable); F3 has NO existing test for emission (OC §7.2). F4 `sessionChanged` is asserted ABSENT over the 30 s hold (OC F4: no producer, a contract decision is still pending; the decision must be recorded in CONTRACT-DELTA.md before the rewrite ships).

## 4. Determinism check and normalization

Procedure (the acceptance gate A3): run the full capture twice, each from a fresh clone of the same snapshot (2.1 step 5), same binary, same pinned environment but different ports and a different `<RUN>` path; compare the two golden trees with the comparator in strict mode AFTER applying `normalize.json`. The result must be zero differences. Every difference found is resolved in exactly one of three ways, in this order of preference: (1) fix the SOURCE of nondeterminism with a seam (a new row in 1.3); (2) add a normalization rule; (3) declare the array a set (section 5). Nothing else is acceptable, and a rule must cite the code that makes the field volatile.

Normalization rules (`normalize.json`, applied identically to old and new goldens; a rule is `{opIds, jsonPath, action}` with action one of `replace:<placeholder>`, `ignore`, `shape-only` (compare key set and value types, not values), `sort-by:<key>`):

| Field | Why it differs | Rule |
|---|---|---|
| any string containing `<RUN>`, `<HOME>`, the three ports, the pid | per-run paths and ports (`dataDir`, `hookEventsDir`, `bodiesDir`, `ports{}`, `file` of H5, paths in H14/H15 results) | `replace` with `<RUN>`, `<HOME>`, `<UI_PORT>`, `<MCP_PORT>`, `<OTLP_PORT>` (done on the raw text before parsing, longest match first) |
| H3 `pid`, `version` (`version` is kept: it must equal the binary under test and is recorded in the manifest), `memory{rssMb,heapUsedMb,heapLimitMb}`, `resources{rssMb,loadPerCore,freeDiskMb,cpuCount}`, `persistence.*Writes/*Bytes`, `admission{inflight,queued,admittedTotal,shedTotal}`, `spans.pendingAppends`, `bodies.newestMs`, `tracesPayloads/logsPayloads/metricsPayloads/parseErrors` | process state and counters that depend on timing and on the harness own traffic (OC H3 (c), `server_stats.rs:441`) | H3 `shape-only` except `startedAt` (equals the pin), `uptimeSec` (0), `dataDir` (placeholder), `ports` (placeholder) and `logSessions`, `store`, `spans.windowMs/configuredWindowMs/retentionDays` (exact) |
| H19 request ring entries (`ts`, `ms`, `bytes`, order) | the ring records the harness own traffic including this call | `shape-only` on `requests[]` element keys, `ignore` on `heap` |
| H20 counters `incrementalReads`, `fullReads`, `filesStatted`, `derivedCaches.*.hits/misses`, `scratchListing.*` | request-history and timing dependent; `dataVersion` and `summaryEngine.sharedCopies` are kept exact only if they pass the determinism run, else `shape-only` | `shape-only` for the counters |
| `build_id`, `buildId`, `@@BUILD_ID_JSON@@` | boot `now_ms` (`lib.rs:640`) | exact (equals the pin) |
| H31 `collectorGaps` entries and Q1 `collectorGaps` | derive from `<data>/collector-lifecycle.json` (OC H31) which gains a new run record at each boot | capture runs against a clone, so the cloned file plus one new run record at the pin; exact. If the new record makes two runs differ, `ignore` the LAST element only and cite it |
| Q52 get_runtime_inventory | process table | `shape-only` on `instances[]`, `topProcesses[]`; `ownRssMb`, `totalRssMb`, `processCount` `ignore` |
| Q53 and any `ttlSource`/`windowSource` derived from the live keychain or network | external | the variant is `UNCAPTURED` or fixture-fed (3.4) |
| Q46, Q47 `index_state`/freshness fields if present | the `forensics.db` re-index time | `ignore` those keys; UNVERIFIED which keys exist (the module output was not read, OC marks them I) |
| Response `date` and any wall-clock header | harness | not stored (only the allow-list of 3.2 headers) |
| Hash-map-ordered arrays (unknown today) | Rust `HashMap` iteration order | found by the determinism run; each is either fixed in the oracle (preferred, it is a latent bug) or listed in `sets.json` with the reason |

A field NOT listed here that differs between two runs of the same build is a harness or product bug, not a candidate for a silent `ignore`.

## 5. Comparator (`scripts/golden/compare.py`)

`compare.py <expected-dir> <actual-dir> [--delta design/specs/duckplan/CONTRACT-DELTA.md]` exits 0 only when there is no unallowed difference. Both sides are normalized with the SAME `normalize.json` first.

### 5.1 Matching

Files are matched by relative path (`<opId>/<variant>.json`). A file present on one side only is a difference (`missing-file`/`extra-file`), except `UNCAPTURED(...)` entries which must be identical in both manifests. `status` and the allow-listed headers are compared exactly.

### 5.2 Value rules (on parsed JSON, using `object_pairs_hook` so duplicates and key order survive)

| Kind | Rule |
|---|---|
| object | the ORDERED key list must be equal (order is contract: OC §1.4 Strip, OC Q1, update payload "insertion order" OC F1 (b)); then values compared per key. Differences reported as `missing-key`, `extra-key`, `key-order` |
| array | ordered, element by element, unless the JSON path matches a `sets.json` entry; then compared as a multiset of canonical JSON (and, when the entry names a `key`, matched by that key and compared per element). Length difference is reported before elements |
| integer (JSON token without `.`, `e`, `E`) | exact, arbitrary precision (Python `int`) |
| float (token with `.`/`e`/`E`) | equal when `a == b` or `abs(a-b) <= 1e-9 * max(abs(a), abs(b))`; compared as `Decimal` parsed from the lexeme. NaN/Infinity cannot occur in JSON; if the parser sees them it is an error |
| integer vs float representation (`1` vs `1.0`) | a `type` difference, NOT tolerated by default (the TS oracle formats numbers like JS: `toFixed` strings are STRINGS and are compared exact, OC Q1, Q4, Q27); allowlistable |
| string | byte-exact. `toFixed`-style numeric strings (`"0.1234"`, `"87%"`) are strings, hence exact |
| null / bool | exact; `null` vs missing key is a difference (OC contracts distinguish absent keys, e.g. Q1 `active` ABSENT, `coverageNote` removed) |
| HTML/text bodies | exact after normalization, except the JSON islands of 3.6 which use the rules above |

A per-path override is allowed ONLY through CONTRACT-DELTA.md (5.4); `normalize.json` is for nondeterminism, never for intended change.

### 5.3 Output

For each difference: `opId/variant`, JSON path (RFC 6901), kind, expected value, actual value (both truncated to 200 chars; full values are in the files). Summary table at the end (counts per kind and per op). Exit codes: 0 equal, 1 differences, 2 harness error (unparseable file, missing manifest, allowlist syntax error).

### 5.4 CONTRACT-DELTA.md (allowlist)

A markdown file at `design/specs/duckplan/CONTRACT-DELTA.md` (tracked; created by the first unit that needs a delta). Machine-read table, one row per permitted difference:

`| id | op | variant glob | json path pattern | kind | expected -> actual summary | reason | owner sign-off (name, date) |`

Rules enforced by the comparator: (1) a difference is allowed only when a row matches op, variant, path and kind; (2) a row with an empty reason or an empty or unsigned owner column is a syntax error (exit 2); (3) a row that matches NO difference in the run is reported as STALE and fails the run (an allowlist that outlives its change hides regressions); (4) `*` paths are forbidden, a pattern may use `[*]` for an array index only; (5) the sign-off is the human owner, a sub-agent cannot sign. Known candidates that must each get a row or be reproduced exactly, from the contracts report: the `get_recent_sessions.workspace` naming trap (OC Q1); `workspace` dropped by Q2/Q3/Q4 (`ui.rs:2290`); `latestSession` of the update sidebar being the OLDEST card (OC F1); `dailyStats.totalTokens` input-only and `costUsd` always 0 (OC F1); Q22-Q24 without the ancestor fallback; `/api/cards/*` with no merge stamps (OC H32); the `groupBy:"cause"` error payload (Q38); the dead `sessionChanged` frame (F4); and every reads-that-write behaviour the rewrite drops (OC key finding 7, CF H16 reparse-on-demand). The default posture is reproduce, not delta.

## 6. Tests of the harness itself (real processes, no mocks)

All run with `uv run pytest scripts/golden/tests` (or the repo test runner, owner decision) and start a real alcore on the tiny corpus; every child process and temp dir is cleaned in `finally` and the process table is snapshotted before and after (project testing rule).

| Test | Asserts |
|---|---|
| T1 `test_tiny_capture_is_stable` | two captures of the tiny suite from fresh clones compare with 0 differences after normalization; fails if the number of captured variants is lower than the number in `requests.json` minus the declared `UNCAPTURED` |
| T2 `test_comparator_flags_injected_changes` | start from a captured golden and inject, one at a time: an integer +1, a float changed by 1e-6 relative, a float changed by 1e-12 relative (must NOT be flagged), a string change, two keys swapped (kind `key-order`), a key removed, a key added, an array reorder, `null` replacing a value, `1` replacing `1.0`; each flagged with the exact JSON path and exit 1; the untouched copy exits 0 |
| T3 `test_allowlist_semantics` | a signed matching row suppresses exactly its difference and nothing adjacent; an unsigned row exits 2; a row matching nothing is STALE and exits 1; a `*` path exits 2 |
| T4 `test_request_list_covers_every_operation` | parses the operation headings of this spec (`H1..H44`, `Q1..Q53`, `F0..F4`, `S1..S6`, `V0..V14`) and fails if `requests.json` lacks a variant, or an `UNCAPTURED` with an allowed reason, for any |
| T5 `test_clock_seam_pins_and_is_inert_when_unset` | with `AGENTLENS_NOW_MS` and `AGENTLENS_GOLDEN_CAPTURE=1`, `/api/server-stats.startedAt` equals the pin and `get_recent_sessions` `active` flags match the pin; with only `AGENTLENS_NOW_MS` set alcore exits non-zero; with neither set `startedAt` is within 5 s of the wall clock |
| T6 `test_scan_budget_seam` | with `AGENTLENS_SCAN_BUDGET_MS=0` Q12, Q21, Q27, Q28 report no early stop on a corpus large enough that the default 20 s budget would cut it (a synthetic generated corpus of > cap sessions); with the default they may stop early |
| T7 `test_display_tz_seam` | Q45 `timezone` equals `Etc/UTC` under the pin, and a different `AGENTLENS_DISPLAY_TZ` changes `localTime` |
| T8 `test_cross_volume_clone_is_refused` | the snapshot step refuses (non-zero) when source and target are on different volumes (uses a second APFS volume or a tmpfs mount if available, else the test is marked skip with the reason) |
| T9 `test_readiness_times_out_loudly` | a corpus that never settles (a writer thread appending to a transcript during boot) makes the run FAIL at the timeout instead of capturing |

Mutation discipline: T2 and T5 must each be shown to fail when the behaviour they test is deliberately broken once (comparator tolerance widened; seam removed).

## 7. Acceptance criteria

| Id | Criterion | Evidence |
|---|---|---|
| A1 | the seams of section 1 are merged, inert by default, and the existing `cargo test` suite of `agentlens-core` still passes with no env set | cargo test output; a diff showing every new env read |
| A2 | `requests.json` covers all 126 operation ids; the only `UNCAPTURED` reasons are: external service (Q53 on `full`), no embed key (restricted viewer branch), no candidate session for a fixture role, no producer (F4, asserted absent) | T4 |
| A3 | two `full` captures from the same snapshot compare with 0 differences after normalization; two `tiny` captures likewise | compare.py exit 0 on both, run log kept in `reports_dev/golden/` |
| A4 | the `tiny` golden set is committed (synthetic) and CI compares the current build against it; the `full` set exists on the owner machine with its manifest | git; manifest |
| A5 | every Q12/Q21/Q27/Q28 golden has `stoppedEarly:false` and `coverage.complete:true` (or the module equivalent), proving no wall-clock budget cut it | jq over goldens |
| A6 | the readiness criterion held for the `full` run: log of the 3 stable polls and the burn ticks | capture log |
| A7 | Q45 `timezone` is the pinned zone and no `localTime` differs between runs | T7 plus A3 |
| A8 | every H and Q operation that OC §7.2 lists as untested now has at least one real golden (H22, F2, F3, the ~40 MCP arms) | list in the manifest |
| A9 | `dashboardSmoke.test.ts` passes against the golden-corpus instance on the old build | test log |
| A10 | the capture of the current build is tagged with its git SHA and binary sha256; the rewrite is compared only against a golden set whose manifest matches the build it claims to replace | manifest check inside compare.py |
| A11 | project type-check and lint pass after the seam changes (`pnpm run check-types`, `pnpm run lint`, `cargo clippy` for rust-core) | tool output |

## 8. Risks

| Risk | Mitigation |
|---|---|
| PRIVATE DATA in goldens: transcripts, prompts, workspaces, account email and uuid, tokens-adjacent files (the full corpus snapshot, `~/.claude.json`) | all real material stays under `/reports_dev/` (gitignored, `.gitignore:41`); never committed, posted, or sent to an outside model service (qs/jgrep/llm-ext must not be pointed at it); only the synthetic `tiny` goldens are tracked; `scripts/check-no-identities.js` is run over the tiny fixtures and goldens before commit |
| `cp -c` falls back to a full copy (cross-volume) and fills the disk | same-volume check before cloning (T8); disk-space stop rule: if free space after the snapshot drops below 20 GB stop and ask the owner (global rule: never free disk unasked); clone cost is ~0 bytes until a file diverges, UNVERIFIED on this volume |
| the real corpus makes the boot sweep take hours (CF H18 cites 21 GB) | readiness timeout is explicit; `full` is a local nightly-style run, never CI; `tiny` is the CI gate |
| capture mutates its own inputs (bodies deleted by the bodies pass, retention) | one fresh clone per run (2.1 step 5); the pristine snapshot is read-only (`chmod -R a-w`) |
| a stray `AGENTLENS_NOW_MS` freezes a production collector | refuse-to-start unless `AGENTLENS_GOLDEN_CAPTURE=1`, loud boot line (1.1) |
| frozen clock hides time-dependent bugs (everything is "now") | the two-instant cases (H23 dedupe, advisory expiry) use clock control (1.2); window functions are exercised through `window`/`days`/`windowHours` arguments, and by running the `tiny` suite at two different pins (`NOW` and `NOW + 6 h`), compared against each other with the expectation that exactly the time-relative fields differ (documented per run in the manifest) |
| operations that read the live machine (process table Q52, plugin cache Q51, network Q53, keychain) leak the host into goldens | operational ops are `shape-only` or fixture-fed; the cloned plugin cache and settings are part of the snapshot |
| the comparator hides a regression through an over-broad `shape-only`/`ignore` | every rule cites its source line; T2 mutation test; STALE-row rule for CONTRACT-DELTA.md; normalization cannot silently widen because `normalize.json` changes are reviewed like code |
| goldens pin quirks that are bugs (OC finding 5) | by design: reproduce first, then record an owner-signed delta; the quirk list in 5.4 is the starting set |
| an op with a side effect on read (H38, H39 cold, Q46/Q47 re-index) changes later answers | fixed order (3.5) is part of the contract; the rewrite reproduces the order or documents the dropped side effect as a delta |
| golden requests depend on fixture ids chosen by rule; the rewrite may order sessions differently and pick different ids | the probe golden (3.3) is itself compared; a different pick is reported as the first difference, not as 400 cascading ones |
| UNVERIFIED items above (flags of alcore, which clock the 20 s budgets use, `dataVersion` bump on backfill, `DisplayZone` and `TZ`, OpenCode default dir, preset lists, APFS clone cost) | each is resolved by reading the cited site when the seam is implemented; the corresponding test (T5-T8, A5) fails if the assumption was wrong |

## 9. Unverified (this session read the two reports in full and spot-checked `lib.rs:911`, `cache_break_timeline.rs:2057`, `rss_guard.rs:32`, `admission.rs:94-95`, `cache_event_log.rs:55-66`, `.gitignore`)

Not read in code: `bin/alcore.rs` command-line flags and exact env names for ports and data dir (CLAUDE.md names `DATA_DIR`, `UI_PORT`, `MCP_PORT`, `OTLP_PORT`; `server_stats.rs:63` shows `MCP_PORT` default 4316); the clock each 20 s budget compares against; the sweep budget semantics at `log_reader.rs:1331-1340`; whether the 1 h backfill bumps `dataVersion`; key names inside the "I"-marked module outputs of OC (so several normalization rows are provisional); the list of presets and metrics in `assets/mcp-tools.json`; whether the alert-raising path of F3 producer 1 is reachable on the tiny corpus; the existing fixture inventory under `tests/fixtures/` beyond the first entries listed. Line numbers inherited from OC are exact where OC says so and about +-10 where OC says so.
