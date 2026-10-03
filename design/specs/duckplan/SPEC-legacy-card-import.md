---
title: DuckDB-index redesign - legacy card import (preserving the 5,742 orphan session cards)
status: draft
scope: project
sources: reports/DUCKPLAN/20261003_170728+0200-orphan-cards.md (O), design/specs/duckplan/SPEC-operation-catalog.md (K), reports/DUCKPLAN/20261003_165118+0200-concurrency-and-flaws.md (F)
---

# Legacy card import

Marks: VERIFIED = read this session in a file; INFERRED = deduced here; UNVERIFIED = not measured, must be settled before it is relied on. Section numbers cite O (orphan report), K (operation catalog), F (concurrency/flaws report).

## 0. Problem and rationale

The redesigned index is built ONLY from transcripts (`raw_line` -> `event`/`api_call`/... , K 2.1 FND-02..04). O 2 found 5,742 of 40,979 cards (14.0%, all `claude_code`) whose transcript no longer exists; they hold 37,707,785,237 tokens (10.2% of all tokens, 8.3% of input-equivalent) and 11 main sessions carry 74% of that (O 3). A transcript-only rebuild silently loses them. Rationale in one sentence: import each orphan card once, as a frozen aggregate-only node, so every total, count and list that includes it today still includes it after cutover.

## 1. Source of truth and the orphan test

### 1.1 Source: the two NDJSON files, not `cards.duckdb`

- Source = `~/.agentlens/log-sessions.snapshot.ndjson` + `log-sessions.delta.ndjson`, replayed with the existing `DeltaLog::replay` semantics (`delta_log.rs`: lines `{"k":key,"v":card}` / `{"k":key,"d":1}`, later line wins, tombstone deletes, one torn trailing line tolerated, a corrupt interior line is an ERROR) (VERIFIED, `delta_log.rs` header + `read_lines`/`replay`). This is exactly the set O counted (40,979 merged cards; O inputs line).
- NOT `cards.duckdb`: it is a rebuildable cache that `CardStore::open` deletes on any open error (F H1, VERIFIED `card_store.rs:221-222` per F), O never opened it, and `seed_written` documents that after a reused-DB start the snapshot may lag the database for records changed after the last save (`delta_log.rs`, VERIFIED). UNVERIFIED: whether `cards.duckdb` holds orphan cards that the snapshot+delta lacks. The import therefore also runs a read-only cross-check (card-key set of `cards.duckdb` minus the NDJSON set, reported not imported); a non-empty difference is a blocker to review, not an automatic import.
- The importer works on a FROZEN COPY (section 7), never on the live files, because the old engine's compaction rewrites the snapshot and deletes the delta.
- Card shape (VERIFIED on the first snapshot record): keys `sessionId, source, startTime, model, turns, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, totalLlmCalls, totalToolCalls, toolCounts, filesRead/Written/Changed/Searched, peakContextPerTurn, timeline, timelineTruncatedCount, timelineRetainedBytes, title, userRequest, workspace, dataSource, tokensSource, ...`. No cost field (O 3): cost is derived from totals at `now` (K FND-04), so legacy nodes get cost by the same function. `tokens` and `endTime` are null in the sampled record.

### 1.2 Exact orphan test

A card with natural key K (the `k` of the NDJSON line = `sessionId`) is an orphan iff, at the end of a COMPLETE transcript ingest catch-up, the new index has no node whose natural key is K (`node_key` lookup, K FND-01). This node-absence test is AUTHORITATIVE.

The path/stem rules of O 2 are the PREDICTION the node test must reproduce (O 2, VERIFIED as rules, run by O):
- `<uuid>` and `agent-<hex>`: orphan iff `<key>.jsonl` is absent from `~/.claude/projects`.
- bare 17-hex id (sub-agent card built from the parent transcript): orphan iff `agent-<id>.jsonl` is absent AND the id occurs in no surviving main transcript.
- `<uuid>-sub-toolu_*`: orphan iff the parent `<uuid>.jsonl` is absent.
- codex (20) and copilot (2): transcript present, not orphans. opencode (19): UNVERIFIED (per-session presence in `opencode.db` not checked, O 2); they are imported only if the node test says so.

Why node-absence is authoritative and the path test is not: the redesign changes discovery by design (K 4: D4 skips `journal.jsonl` and `*.orphaned-*.jsonl`; D3 re-parents workflow subagent files). A card built from a file the new discovery no longer ingests has a transcript on disk but no node; the path test calls it a survivor and it would be lost. Acceptance: |node-test orphans minus path-test orphans| must be fully explained (each extra key traced to D3/D4 or an O caveat), else the import is blocked. Expected from O: 5,742 predicted (11 main + 5,231 agent-file + 459 bare17 + 41 `-sub-`, O 2 table); the final imported count is 5,742 + (explained D4 extras) - (explained D3 re-keyings). UNVERIFIED: size of the D4/D3 extras.

Known twin case (O 2 caveat, VERIFIED statement): 8 of the 5,231 `agent-<id>` orphans have a surviving bare17 twin card, and a transcript-only rebuild yields the bare17 node, never the `agent-<id>` node. Policy: import them (their key is absent), set `twin_nk` to the bare17 node. Whether they double count tokens against the twin is UNVERIFIED; default = visible, flagged, listed in the verification report; revisit if the twin tokens match the legacy tokens.

### 1.3 Partial orphans (card from a transcript that exists but has lost lines)

Detection (after catch-up, for each node whose key matches a snapshot card): `legacy.totalLlmCalls > count(distinct api_call message ids of the node)` or `legacy.startTime < min(event.ts)` by more than a tolerance (tolerance INFERRED: 1 s). Do NOT compare token totals: D1/D2 change totals by design (K 4: subagent usage was undercounted ~95% in places and sibling files double counted), so token deltas of either sign are expected and prove nothing. For the same reason the call-count rule is applied automatically only to main-session cards (`<uuid>`); for `agent-*`/bare17/`-sub-` cards a hit is recorded as `partial_suspect` only.

Policy (default, a decision for the user to confirm): the transcript node stays the visible one with the numbers the transcript supports; the legacy card is RETAINED in `legacy_card` with `partial=1` and `deficit_calls = legacy - derived`; its totals are NOT added to the node (overlap between kept lines and lost lines is unknown, so adding would double count). The loss is surfaced in the import report, and a read-side diagnostic may expose `legacyDeficit`. UNVERIFIED: how many partial orphans exist and how many tokens they hide; O did not measure it. Before cutover run the detection once and report count + tokens; if the hidden tokens are material (threshold set by the user), re-decide toward "serve the legacy totals when larger".

Not needed going forward: once a session is in the index its `raw_line` rows are kept even if Claude Code later deletes the file (F H1 rationale), so future deletions create no new orphans; this import is a one-off for the PAST.

## 2. Target representation

- One `node` row per imported card (same table as transcript nodes, K FND-01) with `source='legacy'`, `file_id NULL`, nk allocated on the writer thread (F H11 `nk allocator`), natural key in `node_key`, and a `rollup` row filled from the card (inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, turns, totalLlmCalls, totalToolCalls, toolCounts, files*, peakContextPerTurn, startTime, durationMs, model, workspace, title, userRequest, entrypoint, initiator, outcome). This is the same shape `/api/import` needs (F H16: `source='import'`, `file_id NULL`).
- `legacy_card(nk PK, natural_key UNIQUE, card JSON, imported_ms, origin, run_id, partial, deficit_calls, twin_nk, shadowed_ms, shadowed_by_nk)`: `card` is the verbatim NDJSON `v` (about 10.4 MiB for all 5,742, O 4: 10,943,984 bytes); `origin` = `snapshot:<sha256 of frozen snapshot>+delta:<sha256>`; `run_id` references `legacy_import_run`.
- `legacy_import_run(run_id, source_snapshot_sha256, source_delta_sha256, started_ms, finished_ms, cards_seen, orphans_imported, skipped_existing, status)`.
- Conflict with the requested column: `node.source` also carries the agent (`claude_code`, `codex`, ...) used by agent filters (Q1 `agent`, `agentSources`). With `source='legacy'` the agent is lost from `node`. Resolution (INFERRED, decision): keep `node.source='legacy'` as requested and serve the agent from `legacy_card.card->>'source'` via the read view below, so no operation sees agent `legacy`. A cleaner alternative is a separate `node.origin` column; that is a schema decision for FND-01.
- `spawn_edge`: for legacy cards whose JSON carries a parent (bare17 and `-sub-` cards, O 1), write the edge only when the parent node exists; otherwise leave NULL. UNVERIFIED which card fields carry the parent (the sampled card had none).

### 2.1 Read path

A single view `node_visible` = all `node` rows except legacy rows with `shadowed_ms IS NOT NULL` (section 4). Every SQL function of K reads `node_visible`, never `node`. Fields a legacy node can serve: all aggregate and identity fields above, `toolCounts`, `files*`, `timelineTruncatedCount`. It cannot serve a timeline: O 3 shows `timeline` is EMPTY on every card in the snapshot (even survivors) and `timelineTruncatedCount` sums to 370,398 over 5,440 orphans, so detail is already absent today; the response keeps `timeline: []` and the count, so nothing regresses.

By operation class (K 0 legend; card ids from K 2.2; INFERRED mapping):

| class | legacy node | how |
|---|---|---|
| PL paged lists (H32a-d, C02) | included | `node`+`rollup`, cursor `ms:seq`; legacy rows get a `seq` at import (K NS-1), ordering by start desc then seq unchanged |
| AGG (H2/S4/V0/V1 C01; Q1, Q2, Q4, Q10, Q11 C04; V7/V8 analytics) | included, totals only | `rollup` columns; cost from totals at `now` (FND-04); `tool_use`-based counts (Q1, Q2) fall back to `toolCounts` for legacy nodes: UNVERIFIED that `toolCounts` reproduces the same figure as a `tool_use` count |
| SSD (H39 timeline C03, V2, V12) | included, `timeline: []` + `timelineTruncatedCount`, flag `legacy:true` | from `legacy_card.card` |
| TOPN / forensics over `raw_line`, `api_call`, `call_block` (Q12 and the forensic/composition/cache-break/body cards C12-C26) | excluded | no rows exist; add a `coverage` note "N legacy sessions without call-level data" (INFERRED wording); this is a contract delta to list in CONTRACT-DELTA.md |
| OTEL (merge, `otel_span`) | n/a | all cards are `dataSource=log` (O 1); the log-vs-OTEL merge never touches them |
| FS (Q37, Q51-Q53, C30) | n/a | filesystem, unaffected |
| W (H7 clear, H8, H13 import, C31) | see section 6 | |
| ST (static) | n/a | |

Quirk to keep: today's `/api/cards/*` has no merge stamps (K 4 tail); legacy nodes keep that.

## 3. Idempotent import

- Natural key = `sessionId` (NDJSON `k`). Insert is `INSERT ... ON CONFLICT (natural_key) DO NOTHING` in the single writer funnel (F H3), in bounded batches (the card total is 10.4 MiB; a batch of a few hundred rows is enough), one transaction per batch, `legacy_import_run` row opened before and closed after.
- Re-run safety: an existing `legacy_card` row is NEVER overwritten (the legacy card is frozen history). A second run over the same frozen source inserts 0 rows and reports `skipped_existing = N`. A run over a source with a different sha only adds keys not already present.
- A crash mid-import leaves committed batches; the re-run completes the rest (no partial-state problem, because each batch is independent and keyed).
- Order: run ONCE at cutover, after transcript catch-up is complete and before the old store is retired (section 7). Running earlier is safe (any card imported early and later found to have a transcript is shadowed, section 4) but makes the count check in section 5 meaningless, so verification is only taken after catch-up.
- Re-runnable on demand via an explicit CLI/maintenance entry (name INFERRED: `alcore legacy-import --source <frozen dir>`); not triggered by HTTP.
- The import never deletes anything and never opens the live NDJSON for writing.

## 4. Dedup when a transcript reappears

If a transcript for natural key K is ingested later (restored backup, re-synced `~/.claude`): TRANSCRIPT WINS, the legacy data is HIDDEN, NOT DELETED.
- The ingest path that allocates/looks up `node_key` for K finds the existing legacy node and ADOPTS it: the same `nk` is kept (so cursors, SSE roots and `spawn_edge` stay stable), `node.source` flips from `legacy` to the real agent, `file_id` is set, `rollup` is recomputed from the transcript rows; `legacy_card.shadowed_ms`/`shadowed_by_nk` are set. This is an UPDATE of `node`/`rollup`; it must be listed as an accepted exception to append-only in the concurrency analysis (F summary note on "only updated table").
- The legacy card JSON stays in `legacy_card` forever; `node_visible` simply no longer exposes a shadowed legacy contribution (there is none, the node now shows transcript numbers).
- If the restored transcript is itself partial, run the section 1.3 detection again and set `partial`/`deficit_calls`.
- If the transcript later vanishes again, `raw_line` rows already in the index keep the node whole; the legacy row is not re-activated.

## 5. Verification

Pin everything to the FROZEN copy: O was computed on the 2026-10-03 snapshot, and a later delta can change the counts, so numbers are recomputed from the frozen copy by a verifier script and ALSO compared with O below.

| check | expected (O) |
|---|---|
| orphan cards imported (frozen copy, before D3/D4 adjustments) | 5,742 of 40,979 merged (O 2) |
| by kind | main uuid 11; agent-file 5,231; bare17 459; `-sub-` 41 (O 2) |
| tokens by kind | 28,056,255,052; 9,623,477,778; 28,052,407; 0 (sum 37,707,785,237, arithmetic VERIFIED) |
| token buckets | input 72.1M, output 49.2M, cacheRead 36.70B, cacheCreate 884.0M (O 3, rounded: compare exact sums recomputed from the frozen copy, then check they round to these) |
| input-equivalent | 5.09e9 = input + 5*output + 0.1*cacheRead + 1.25*cacheCreate (O 3) |
| field presence | model 5,742; workspace 5,742; turns>0 5,739; tokens>0 3,057 (zero-token 2,685); toolCalls>0 3,022; fileOps 2,804 (O 3) |
| timeline | all empty; `timelineTruncatedCount` sum 370,398 over 5,440 cards (O 3) |
| bytes | `legacy_card.card` total 10,943,984 (O 4) |

Check mechanics: `SELECT count(*), sum(inputTokens), ...` over `legacy_card`/`rollup WHERE node.source='legacy'` equals the same sums over the orphan keys of the frozen NDJSON, bit-exact (integers; no float); any shortfall fails the cutover. Also: `survivors + imported + explained_D3_D4 = 40,979`, and per-month orphan distribution (O 2: 2026-05 2,155; 06 3,299; 07 283; none after 2026-07-03) matches.

Golden parity for orphan sessions: for a fixed sample (all 11 main orphans plus a seeded random 50 of the rest), the FND-00 golden capture of the CURRENT alcore (K 2.1 FND-00) is the oracle for H32c by-ids, H2 summary row, and Q1/Q4/Q10 rows; the SQL-backed output must equal the captured output except the declared legacy flag/coverage field, and cost (derived at `now` from the same pricing function, K FND-04). Diff is key-order exact (K 2.2 convention). Timeline route for an orphan must equal today's output (`timeline: []`).

## 6. Retention, clear, import endpoint

- Legacy rows are NEVER deleted by retention, by `POST /api/clear` (H7), by `POST /action clearAll` (H8, only `otel_span` anyway, K 1.1), or by any prune keyed on age or `received_ms`. Every such statement must carry `WHERE source <> 'legacy'`, and `legacy_card`, `legacy_import_run` are excluded from "truncate every owned table" (K C31: "assert H7 truncates every owned table" gains the exception).
- This is a contract delta (today `/api/clear` empties all cards): add D11 to CONTRACT-DELTA.md ("clear keeps imported legacy cards"). Whether the user needs an explicit way to remove legacy data is a user decision; per RULE 0 it must be a separate, deliberate, backed-up command, never implicit.
- `/api/import` (H13, F H16) writes `source='import'` nodes. If an imported session has the same natural key as a legacy node, the imported node is treated like a transcript (adopts the nk, hides the legacy row, section 4): INFERRED default, to confirm.

## 7. Rollback and the soak

- At cutover, BEFORE the new engine first opens a data dir: copy `log-sessions.{snapshot,delta}.ndjson` and `log-offsets.{snapshot,delta}.ndjson` (and keep `cards.duckdb` untouched) to `<dataDir>/legacy-source/<utc-stamp>/`, record sha256 in a manifest, set files mode `0444` and the directory `0555`. Copy, do not move: the old binary must still be able to start for a rollback.
- The new engine MUST NOT instantiate a `DeltaLog` writer on `log-sessions` (its compaction rewrites the snapshot and deletes the delta, `delta_log.rs` header, VERIFIED) and must not open `cards.duckdb` for writing; the live old-format files are left as they are.
- These files are kept until the soak passes. Soak = N days (N INFERRED: 14) during which: the count/sum checks of section 5 run at every boot and stay green, no unexplained node-absence difference appears, golden parity on a rolling sample is green. Only the USER may then retire the old files, and then via move to `.trashcan/` (RULE 0), not `rm`.
- Rollback = stop the new engine, start the old one: it reads its untouched snapshot/delta and `cards.duckdb`. The new index (never deleted, F H1) is kept for forensic comparison.

## 8. Tests (file name INFERRED: `tests/legacy_import.rs`; real files, no mocks)

Fixtures live as small NDJSON snapshot/delta files plus tiny transcript trees under the test temp data dir.
1. Full orphan: snapshot has main card A with no transcript. After catch-up and import: node `source='legacy'`, rollup equals the card, timeline `[]`, appears in H32a page, H2 summary, Q1; token/cost totals equal the card.
2. Partial orphan: card B `totalLlmCalls=10`, transcript has 6 distinct message ids. Expect visible node from transcript (6 calls), `legacy_card.partial=1`, `deficit_calls=4`, node totals NOT summed with the card; same fixture under an `agent-*` key sets `partial_suspect` only; a card whose call count is lower only because of D2 sibling dedup does not flag a main session.
3. Reappearing transcript: import A, then add `A.jsonl`; the same `nk` is kept, `source` flips, rollup recomputed from the transcript, `shadowed_ms` set, legacy row still present, no double count in H2; delete the transcript file again: the node stays whole from `raw_line`.
4. Duplicate import: run the import twice and a third time with an enlarged delta: the second run inserts 0 rows, the third only new keys; `legacy_card` rows are byte-identical after.
5. Torn trailing delta line tolerated; a corrupt interior line aborts the import with an error and writes nothing (fail fast).
6. D4 case: a card whose file is `journal.jsonl`-derived (present on disk, not ingested): node-absence test imports it, path test would not; the report lists it as explained.
7. Twin case: `agent-X` orphan plus surviving bare17 twin: imported, `twin_nk` set.
8. Clear: H7 empties transcript nodes but legacy nodes and `legacy_card` remain; retention prune leaves them.
9. Crash between batches (failpoint): rerun completes with exact counts.
10. Frozen source: import reads only the copy; live NDJSON mtime/sha unchanged; copy is mode 0444.
11. Real-corpus acceptance script (not a unit test): run section 5 against a COPY of `~/.agentlens` and print the table of expected vs actual.

## 9. Open decisions for the user

1. `node.source='legacy'` versus a separate `node.origin` (section 2).
2. Partial-orphan policy default (section 1.3) and the materiality threshold.
3. Twin handling (section 1.2) and `/api/import` precedence (section 6).
4. Whether any explicit legacy purge command is wanted at all (section 6).
5. Soak length (section 7).
