---
title: DuckDB-index redesign - dashboard moves from "receive the whole summary, compute every tab in the browser" to paged server queries
status: draft (revision 2)
scope: project
sources: design/specs/duckplan/SPEC-operation-catalog.md (CAT), design/specs/duckplan/SPEC-read-api.md (RA), docs_dev/duckplan-decisions.md (DL) and docs_dev/duckplan-decisions-r1.md (R1, wins on conflict), reports/DUCKPLAN/20261003_171551+0200-operation-contracts.md (R, sections 5.2, 6, 7.2, 7.3H), reports/DUCKPLAN/20261003_185312+0200-e4-tree-paging.md (E4), the code under media/src (read this session)
---

# Dashboard: paged server queries instead of the whole summary

Owner rule (task brief, 2026-10-03): the dashboard NEVER receives the whole card corpus. Every claim about current code cites file:line; anything this spec decides or proposes on its own (names, caps, route names, new catalog entries) is marked INFERRED or PROPOSED; anything a decision log entry settles cites it (DL D-n, R1-Dn). Evidence level: all media/src and index.html citations were read; nothing was run, so every number below that is not quoted from R/CAT/RA/E4/DL is a design choice, not a measurement. Line numbers: those marked (v) were re-checked by grep in revision 2 (several of revision 1 were off by one: state.ts:133 is 134, index.html:82 is 83, App.tsx:380 is 381); the others are +-1 and must be re-read at implementation time. The qs triage of the 17 tab files was not used: the files were read directly (section 4 lists each).

## 0. Summary of the decision

1. The browser stops holding `sessionSummary` (state.ts:134 (v)) and stops computing the derived lists (state.ts:522-636, (v) for 522/541/554/590/628). It holds a **query store**: results of named server queries keyed by `(name, params)`, each stamped with the server data version `v`.
2. The session list is a **cursor-paged list of ROOT cards** ordered by the immutable key `created_ms DESC, nk` (DL D-5, E4 cursor (i), RA F02), page size 50 (RA F02 default; limit 1..200). Sub-agents load on expand (`cards_children`, RA F03). Sorts on mutable or derived keys are **capped top-N, not paged** (DL D-5; E4: cursor (ii) on a mutable key gave 197 duplicates and 248 misses).
3. Every tab's aggregate (totals, daily cost, cache SLI, hot files, cause leaderboard, spawn rollup, advisor suggestions, cost, resident cost) is computed by a server function; the client deletes its copy (section 5 is the per-module decision).
4. SSE frame becomes the RA section 6 frame (`v, since, boot_id, clear_epoch, changedRoots`) plus the small live keys. The client revalidates only what `changedRoots` touches.
5. The shell no longer inlines the summary (S4 removed); the polling fallback polls a tiny `changes` function instead of `/api/summary`; search and export move server-side; the browser time zone is sent as `tz` and day buckets are built in Rust (DL D-14, no ICU).

## 1. Current state (what is deleted or replaced)

| # | fact | evidence |
|---|---|---|
| 1 | One bulk signal `sessionSummary`, initial value `window.__INITIAL_SESSION_SUMMARY__` (shell-inlined), replaced wholesale by every SSE `update.sessionSummary` | state.ts:134 (v); index.html:83 (v); App.tsx:381 (v); R 6 intro |
| 2 | Derived in the browser: `availableWorkspaces` (522), `agentFilteredSessions` (530), `displaySessions` (541), `rangedSessions` (554), `filteredSessions` incl. text/initiator/evidence filters and 8 sort keys (590-626), `agentPresence` (628) | state.ts:522-636 (v for the starts) |
| 3 | Time presets resolved with the BROWSER clock: `makeTimeRange` `Date.now() - ms`; `rangedSessions` `until = range.until ?? Date.now()`; custom bounds `Date.now()` default | state.ts:63 (v), 563 (v); App.tsx:642-649; R 7.3H |
| 4 | Window membership = interval overlap `startMs <= until && startMs+durationMs >= since` | src/shared/timeWindow.ts:10-22 (`sessionInWindow`) |
| 5 | A "DB search" for bounded presets is a client-side search over the same in-memory array, answered by the shim, limit `CHART_MAX`=25 | App.tsx:603-631; index.html:266-292 (`searchSessions` branch at 266 (v)); state.ts:12 (v) |
| 6 | Cost is computed per card in the browser (`calcSessionCost`, `calcEntryCost`, `stepCostUsd`) from `src/shared/pricing` | sessionMetrics.ts:3; state.ts:617-621; R 6 V2, V5 |
| 7 | Poll fallback fetches the whole `/api/summary` every 2 s and dispatches it as an `update` | index.html:373-385 (`_startPolling` at 373 (v), fetch at 377 (v)) |
| 8 | Export builds a 20-key JSON from `__latestSessions__` in the browser, filename from the browser clock | index.html:223-262 (v for 223); R 6 V9 |
| 9 | Per-session detail is already lazy, but there are FOUR separate LRUs each capped at `DETAIL_CACHE_MAX = 40` (detail, composition summary, conversation, composition), and only one trace subtree may be expanded at a time | state.ts:159 (v), 176, 328, 362, 376 (v: four `while (...LRU.length > DETAIL_CACHE_MAX)`); state.ts:187-200 |
| 10 | `sessionChanged` is handled but never emitted (F4 has no producer); `mergeChangedSessionCards` is therefore dead | App.tsx:412 (v); state.ts:419 (v); CAT F4/C38 |
| 11 | `displaySessions`/`sessionLimit` are vestigial: `sessionLimit` is set only by the host `setFilter` message and reset; `getSessionOffset` has no caller (grep over media/src shows only its definition at utils.ts:567 (v)); `displaySessions` feeds only automation checks (App.tsx:392 (v)) and a re-render subscription | App.tsx:225, 391-397, 467-470; state.ts:463 (v), 541 (v) |
| 12 | The dashboard does not call `/api/cards/*`, `/api/stats/overview`, `/api/burn-status`, `/api/collector-gaps` | R 6 intro |
| 13 | Local-date bucketing uses the browser time zone; server `dailyStats` uses UTC, `costUsd` always 0, `totalTokens` input-only | utils.ts:536 (`sessionDateKey`); R V7; CAT C34 (these three server quirks are FIXED by DL D-12 / D-14, so they are not preserved) |
| 14 | The browser smoke suite readiness loop polls `GET /api/summary` for the fixture sessions | src/test/browser/dashboardSmoke.test.ts:284 (v); it breaks the moment H2 is paged (section 7) |

## 2. The paged state model

### 2.0 Route naming (fixes a revision-1 contradiction with RA 1.3)

RA 1.3 makes every existing route an exact thin adapter with its legacy contract; H32a-d (`/api/cards/*`) today take only `limit`/`cursor ms:seq` and carry no merge stamps. Revision 1 "extended" those routes (N2), which RA forbids. The dashboard therefore calls the ADDITIVE generic route `GET /api/q/:name` (RA 1.1) and never the legacy routes. Mapping (function ids are RA section 2; all INFERRED names):

| dashboard name used below | RA function | note |
|---|---|---|
| `cards_page` | F02 `cards_page` | needs the N2 filter/sort params, `total`, `top_n/truncated`, `resolvedWindow` (RA lists only `limit, cursor` today) |
| `cards_children` | F03 | cap 500 + `truncated` (RA) |
| `cards_by_ids` | F04 | <= 200 ids |
| `cards_stats` | F05 (+ facets, N2) | |
| `session_timeline`, `turn_growth`, `spawn_rollup` | F06, F08, F10 | |
| `session_history`, `context_composition`, `conversation`, `composition_summary`, `block_content`, `call_context` | F20, F19, F21, F27, F28, F26 | by `nk` (section 2.1) |
| `daily_stats` | F45 | with `tz`, real `costUsd` (DL D-12; RA F45 still lists the old quirks, flagged in the revision log) |
| `cache_break_events` | F32 | Q41/Q42 |
| `changes` | NEW (N1) | same frame builder as RA 6 |

A response is the RA 1.1 envelope `{v, boot_id, clear_epoch, complete, backfill:{files_done,files_total,bytes_done}, data}`; a list `data` is `{rows, next_cursor|null, v}` (RA 3) and a capped list is `{rows, top_n, truncated}`. Revision 1 invented `nextCursor`/`capped`/`asOfMs`; they are dropped. Extra dashboard-only fields (`total`, `resolvedWindow`) sit inside `data`.

### 2.1 Query store (replaces `sessionSummary`, the derived computeds and the four detail LRUs)

PROPOSED module `src/shared/pagedQuery.ts` (pure, runtime-neutral so mocha can test it; same placement rule as the other shared engines) plus `media/src/queryStore.ts` (signals).

- Entry key: `name + "|" + canonical(params)`; canonical = sorted keys, defaults omitted, `since/until` ABSENT when a preset is used (see 2.3) so a key never changes with the clock. The stored value carries `v`, `status`, `rootNks` (the roots the payload depends on), `bytes`, `data`.
- Bounded memory: ONE store with a BYTE budget (sum of response sizes), not an entry count. Revision 1 proposed "LRU of 64 entries replacing DETAIL_CACHE_MAX=40": a count does not bound memory because entries range from a 2 KB aggregate to a multi-MB timeline, and today's 40 applies to each of four caches (fact 9), not to one. The budget value is decision ND-2. A list keeps at most 10 mounted pages (PROPOSED); dropping a page keeps its cursor so scrolling back re-fetches it by cursor. The single-expansion rule (state.ts:187-200) stays and `pnpm run check-single-expansion` (package.json:82, part of `compile`) keeps guarding it.
- Card key: the client keys by the opaque node key `nk`, not `sessionId`. E4: 408 stems collide (agent ids repeat across parents); DL D-DAT-5 and R1-D5 make node identity `(dev, inode)` of the session file with the path an updatable attribute. RA already keys everything on `nk` (F03 `parent_nk`, cursor `(created_ms, nk)`, SSE `changedRoots` of `nk`). Decision OD-1 is therefore RESOLVED: every card carries `nk` and `rootNk`; H33-H39 equivalents take `nk`; the client never parses or derives it. Legacy routes keep `sessionId` + `?parent=` for the old callers.

### 2.2 The session list

Params (all translations of today's signals): `source` (selectedAgentFilter, state.ts:464, 533), `dataSource` (`(dataSource ?? 'otel')`, state.ts:535), `workspace` (`workspace ?? ''`, state.ts:537), `initiator` (`initiator ?? 'user'`, state.ts:603), `q` (substring of `userRequest`, case-insensitive, state.ts:598), `window` preset or `since/until` ms, `tz`, `sort`, `dir`, `limit` (50), `cursor`.

- `evidenceSessionIds` (state.ts:113; Instructions "View sessions") has no list form: when set, the list is `cards_by_ids` (F04). Cap 200 ids (RA F04); more is refused with an error shown, not truncated silently.
- Root rows only. A filter matches the root row; sub-agents appear only under their root (DD-4, decision OD-4). Roots are nodes with a timestamped line; a node with none is not listed (DL D-DAT-6, R1-D5), so a root can appear late with an old `created_ms`: it lands behind the cursor of a client already past it (an allowed phantom, 2.3) or in place on page 1.
- Sorts (DEC-2): only `start_time` (`created_ms DESC, nk DESC`) is cursor-paged, because it is the only key RA F02/section 3 and E4 verified immutable. `source` (immutable per node, R1-ORIGIN) MAY be cursor-paged as `(source, created_ms, nk)` once RA adds that cursor (decision ND-3). Everything else (`total_tokens`, `duration_ms`, `errors`, `cost`, `model`, `prompt`, a future `activity`) is capped top-N: response has `top_n` and `truncated`, UI says "top N". PROPOSED N = 100 (OD-6). Revision 1 listed `prompt` as pageable with "INFERRED immutability"; nothing backs it (the first user request arrives after the node exists, and a text cursor needs a text index), so it is demoted to top-N.
- Infinite scroll: `Sessions.tsx` `INITIAL_RENDER/RENDER_BATCH` + IntersectionObserver over an in-memory array (Sessions.tsx:575-599) becomes "sentinel near viewport -> fetch `next_cursor`". Same pattern in ContextTab (ContextTab.tsx:511-529).
- Counts: "N sessions" (App.tsx:882) and "N stored" (Sessions.tsx:670-671) come from `total` (PROPOSED: `COUNT` with the same predicate, returned on page 1) and `cards_stats`, never `array.length`.
- Expand: `expandedTraceId`/`expandedBranchId` (state.ts:192, 200) key a `cards_children` query and the detail queries; collapsing releases them (matches the owner comment state.ts:187-192).
- Indexing in progress: while the envelope says `complete=false` (RA 1.1, backfill running) every view shows a banner "indexing history: files_done / files_total" and totals are labelled partial. Revision 1 ignored these fields.

### 2.3 Time range

The browser sends `window=<grammar>` and the SERVER resolves `since = now - span` with its injectable clock (FND-00); the response returns `resolvedWindow` so the chip that shows the exact window (App.tsx:699 region) reads it. RA's `window` type accepts `5h|7d|24h|<n>h|<n>d` only; the dashboard presets `15m` and `all` are NOT in that grammar. Decision ND-8: extend the grammar with `<n>m` and `all` (recommended; tiny, one parser). Custom range sends `since/until` ms from the datetime inputs (the browser's local wall time is converted to absolute ms in the browser, App.tsx:643-646, which is tz-independent; an empty `to` is sent as ABSENT = server now). Deleted: `makeTimeRange`'s `Date.now()` (state.ts:63), `rangedSessions` (state.ts:554-587), `fireSearch` + `rangedSearchResults` + the `searchResults` handler (App.tsx:481-491, 603-631; state.ts:76, 103). The predicate moves to SQL as `created_ms <= :until AND last_active_ms >= :since` (same interval-overlap semantics as src/shared/timeWindow.ts:10-22; the Rust golden must reuse the cases of src/test/timeWindow.test.ts). Note `last_active_ms` is clamped to `min(ts, ingest_wall_ms + 5 min)` and never decreases (RA 3, CF H20), whereas today's `startMs+durationMs` is unclamped: a session with future-dated lines leaves the window earlier (DD-22). The window filter uses a mutable column in a WHERE (not as a cursor), so a session may enter or leave the filtered set between two page fetches: accepted, documented (E4 cursor (i): late inserts behind the cursor are harmless phantoms; RA 3).

### 2.4 Time zone (DL D-14: DECIDED, Rust bucketing, no ICU)

Every query that buckets by calendar day or prints local time carries `tz` = `Intl.DateTimeFormat().resolvedOptions().timeZone` (IANA name). The server validates it against its tz database and an unknown name is HTTP 400 `bad_param` (no fallback to UTC; fail fast). Bucket boundaries are generated in Rust (`chrono-tz`, 23/25-hour DST days correct) as a `(bucket_start_ms, bucket_end_ms)` VALUES CTE of at most 1000 rows (RA 7); DuckDB never sees a time zone, and the ICU extension is neither needed nor loaded (DL D-ENG-1). `tz` is part of the entry key. Affects: `daily_stats` (today the UI buckets in browser tz, utils.ts:536, while the server buckets in UTC, R V7), export file name (index.html:252-256), `localTime` of Q45 (R 7.3F). Revision 1's "INFERRED, UNVERIFIED: ICU availability" is closed by DL D-ENG-1 (decision OD-7 RESOLVED). Day-bucket cap: RA F45 caps at 400 days and the corpus is already 218 days old (DL D-DAT-8); see ND-6.

### 2.5 Refresh on SSE (and the other transports)

Frame (RA 6; DECIDED by CF H17, layout INFERRED): `{"v", "since", "boot_id", "clear_epoch", "changedRoots":[nk...] | null, "overflow"?, "reset"?}` plus the live sidebar keys, `buildId`, `collectorGaps`, `burnRate`. `changedRoots` is capped at 200; `null` + `overflow:true` means "too many". `reset:true` is sent when `boot_id` or `clear_epoch` differ, `since` is older than retained rows, or on overflow. Removed from the F1 payload: `sessionSummary`, `analyticsData` (served by `daily_stats`), `sidebar` (INFERRED unused by the dashboard: no `.sidebar` reader found in media/src by grep), constant `summary.toolCalls` (App.tsx:380 (v) reads it; INFERRED harmless to drop with its reader). RA 6 says the legacy `update` frame "keeps its exact shape"; that sentence contradicts CAT D6/C34 and the cutover-all-at-once rule (the dashboard is the only consumer of `sessionSummary`); this spec follows CAT D6, and RA 6 must be amended (revision log).

Client handler (replaces App.tsx:374-405 body and the `searchResults`/`sessionChanged` branches):

| condition on the frame | action |
|---|---|
| `v` <= client `v` and same `boot_id`/`clear_epoch` | ignore (RA 6) |
| `reset:true`, or `boot_id`/`clear_epoch` changed | drop the whole store, refetch what is mounted |
| `changedRoots` non-empty or null (and no reset) | per-entry rules below |

| entry kind | stale when | action |
|---|---|---|
| list page 1 (cursor null) | `changedRoots` non-empty or null | refetch page 1 only if the list is mounted (new roots land AHEAD of page 1 under `created_ms DESC`) |
| list page k>1 | a row's `rootNk` is in `changedRoots` | refetch those rows with `cards_by_ids` and merge in place; never re-page |
| children of root R | R in `changedRoots` | refetch if mounted (expanded) |
| detail of session S (timeline, history, composition, conversation, composition summary, call-context, block) | `rootNk(S)` in `changedRoots` | refetch if mounted; else drop |
| aggregates (stats, daily, cache SLI, hot files, advisor, spawn rollup, cause leaderboard) | `changedRoots` non-empty or null | refetch if the tab is mounted; else drop |
| top-N list | `changedRoots` non-empty or null | refetch (no cursor, RA 3) |
| any entry not stale | - | re-stamp `entry.v = v` |

An SSE reconnect sends `Last-Event-ID: <v>`; the server replays one catch-up frame (RA 6), so the client no longer treats a reconnect as "everything changed" (revision 1 did; index.html:387-391 is where `onopen` lives). The server coalesces to 4 s (`PUSH_COALESCE_MS`, RA 6), so a burst cannot cause more than one revalidation per mounted entry per 4 s. Frames carry no card data; the client never merges pushed cards (this deletes `mergeChangedSessionCards`, state.ts:419-432, and the dead `sessionChanged` handler, App.tsx:412-422; whether the server ever emits `sessionChanged` stays with CAT C38). `burnStatus` (F2) and `alert` (F3) frames are unchanged (App.tsx:407-410; index.html:404-413).

### 2.5.1 Shell and polling fallback

- Shell: `window.__INITIAL_SESSION_SUMMARY__ = @@SESSION_SUMMARY_JSON@@` (index.html:83 (v)) and the `__latestSessions__` shim (index.html:89-93 (v)) are deleted, as is the window typing (types.ts:263) and the signal initialiser (state.ts:134). First paint is a skeleton; the app fetches page 1, `cards_stats` and the active tab's queries on mount (one extra round trip; DD-11). Order of removal matters: the token `@@SESSION_SUMMARY_JSON@@` must leave index.html BEFORE (or in the same commit as) the Rust substitution, because `substitute_tokens` leaves unknown tokens verbatim (R 5.2) and a leftover token in the inline script is a JS syntax error. S1-S3, S5 (`@@BUILD_ID_JSON@@`, index.html:86 (v)) and S6 (`__SIDEBAR_INIT__`, index.html:540 (v)) stay (small, CAT C35).
- Polling: `_startPolling` (index.html:373-385) polls `GET /api/q/changes?since=<v>` (NEW function, N1) every 2 s and dispatches the SAME frame object, so `App.tsx` is transport-agnostic. The server builds the frame with the RA 6 query (`SELECT DISTINCT root_nk FROM ingest_batch_root ...`) and sets `reset:true` when `since` is older than its retained rows (`ingest_batch_root` retention is RA OPEN-R6). The polling start/stop logic (`_sseOk`, `onopen`, `onerror`, index.html:370-422) is unchanged.

### 2.6 Search and export

- Search: `searchSessions` shim (index.html:266-292) and the `searchResults` message are deleted; text search is the `q` param of the list query (case-insensitive substring of `userRequest` with LIKE escaping of `%`/`_`; JS `toLowerCase` vs DuckDB lowering differ on exotic Unicode: accepted, DD-10). The shim also matched `model` (index.html:270) but only for the time-range prefetch that never sent text (App.tsx:621-625), so no behaviour is lost.
- Export: `exportSessionData(Redacted)` (index.html:223-262; Export.tsx:18-28) becomes a server route `GET /api/export?<list params>&redact=0|1&ids=` (PROPOSED, N8) that streams the 20 keys of R V9 by keyset-paging the same predicate (so the browser never holds the corpus, and the export covers the whole filter instead of the in-memory array). File name `export[_redacted]_sessions_YYYYMMDD_HHMMSS.json` is produced by the server from `tz` (today the browser local clock, index.html:252-256); the client triggers a plain download link, no Blob. Export uses a dedicated connection and a hard wall-clock limit (RA OPEN-R6, write-side spec). Restricted viewers: the route must be a GET that the restricted gate allows or refuses explicitly (INFERRED: confirm against the viewer-role method gate, R H4/H42).

### 2.7 Archived-lines view (R1-D4: DECIDED that pruned lines stay viewable)

R1-D4(b): a gen bump (the transcript file was replaced or pruned) ingests the new gen as new rows, old-gen rows stay in the archive hidden from display by `gen = file.gen`, and that node's rollup is recomputed from current-gen rows. Consequences for the client:
- Cards carry `archivedLines` (count of old-gen lines; 0 for nearly every card, the corpus has 0 superseded files today, R1-D4). Totals shown on a card exclude archived lines (DD-23).
- In the Sessions detail Transcript sub-tab (TranscriptView, H35 equivalent `conversation`), when `archivedLines > 0` a toggle "Archived lines (N)" appears; it renders the old-gen lines through the same line renderer, labelled with their gen, read-only, paged by a leaf cursor `(gen, byte_off)` within `nk` (RA 3 defines `(byte_off)`; the `gen` component is an RA addition, N11 function `archived_lines(nk, cursor, limit)`).
- Placement is decision ND-5 (per-session toggle recommended). Nothing in the UI deletes archived lines.

### 2.8 Clear semantics: OPEN pending revision 2 of the decision log

Coordinator instruction (mid-task): R1-D10 ("/api/clear = forget-before-T watermark, with an unclear action") is under revision and clear will likely keep today's meaning (drop OTEL spans, rebuild derived data). This spec therefore does NOT design a "cleared before T" indicator or an "unclear" action. The only client behaviour kept is the generic one that does not depend on the semantics: a changed `clear_epoch` in any envelope or frame (RA 1.1, 6) makes the client drop the whole query store and refetch what is mounted. The Settings clear button (Settings.tsx:15, `confirm('Clear all AgentLens session data? This cannot be undone.')`) and `clearAll` (index.html:186-190) are unchanged until revision 2 settles the contract; the confirm text and any watermark UI are decision ND-4. Any "unclear" route, `clear_before_ms` envelope field or import-vs-watermark interaction (rows imported older than a watermark would be hidden) is NOT specified here.

## 3. Per-view specification (V0-V14)

Legend: **Feed** = server function (CAT id / RA function, called as `/api/q/<fn>`). **Deleted** = client computation removed. NEW = not in CAT/RA; listed in section 6.

### V0 Global derived state (state.ts) - card C01
- Displays: nothing; feeds every tab. Today: whole corpus in memory.
- Feed: `cards_page` (F02), `cards_by_ids` (F04), `cards_stats` (F05, extended with facets: distinct `workspace`, per-`source` counts for the active window, `newestRoot`, `pricingLastUpdated`).
- Deleted: `availableWorkspaces`, `agentFilteredSessions`, `displaySessions`, `rangedSessions`, `filteredSessions`, `agentPresence`, `mergeChangedSessionCards`, `sessionLimit` semantics, `rangedSearchResults`, `searchResults` (state.ts:76, 103, 419-432, 463, 522-636). Workspace dropdown sorts the facet names with `shortWorkspaceName` (state.ts:512-518) in the client (a presentation sort of a short list; the sort key is a UI label).
- State: section 2. Replaces H2/S4/`update.sessionSummary` as the dashboard's source (CAT D6). H2 itself: C01 decides whether it returns page 1 + cursor for its remaining callers (bench script only per CAT H2 consumers; decision OD-8).

### V1 App chrome (App.tsx) - C01/C34
- Displays: tab bar (`TABS`), filter bars, collector-gaps banner (App.tsx:267), bell/alert count, session count, indexing banner (2.2).
- Feed: SSE frame keys `collectorGaps`, `burnRate`, `v`, `changedRoots`; `serverBurnStatus` via F2 (unchanged); counts via `total`.
- Deleted: the `update` branch's `sessionSummary`/`analyticsData` assignments (App.tsx:381-385), `checkAutomations(sessionSummary...)` at first load (App.tsx:392 (v)), `fireSearch` (App.tsx:603-631), the `displaySessions` re-render hack (App.tsx:225). `BellButton` count: see V11.
- Smoke selectors stay (`button.tab[data-tab=...]`, dashboardSmoke.test.ts:346).

### V2 Sessions tab (Sessions.tsx) - C02/C03
- Displays: paged root list, per-row cost/tokens/chips, nested children, detail sections, Transcript archived-lines toggle (2.7).
- Feed: `cards_page`, `cards_children` (replaces `sessionSummary.sessions.filter(parentSessionId===id)`, Sessions.tsx:219), `session_timeline` (F06, C03).
- Deleted: `calcSessionCost`/`isUnpriced` in rows (server fields `costUsd`, `isUnpriced`, PROPOSED card columns from FND-04), client sort (state.ts:605-625), the in-memory render windowing (Sessions.tsx:575-599; replaced by cursor paging), `hasAny`/stored count from array length (Sessions.tsx:601, 670).
- Stays (per-session, over ONE already-loaded detail payload): fileOps aggregation and sort, keep-warm from the timeline, `generateInsights(summary,[sess])` (R V2/V14: client rules with no server counterpart), `TimelineWaterfall` grouping by turn.
- Open: F06 returns the whole timeline of one session and CAT D5 uncaps it. One expanded session at a time bounds it, but a very long session is still one large response: OD-2 (options below); RA 3 already defines a `(byte_off)` leaf cursor for F06, so revision 1's `turnFrom/turnTo` (N9) is dropped.

### V3 Context tab (ContextTab.tsx) - C12/C13/C20
- Displays: root tree (`buildContextRows`), per-session turn points, source layers, resident cost, composition summary.
- Feed: roots via `cards_page`; children via `cards_children`; `session_timeline`, `session_history` (F20), `context_composition` (F19), `composition_summary` (F27), `block_content` (F28). Resident cost via Q25 `get_context_inflation_report` (C15; a Rust implementation with `residentcost_parity.rs` exists, CAT Q25).
- Deleted: root derivation from `filteredSessions` (ContextTab.tsx:503-522), `buildResidentCostReport(history)` call (R V3), the THIRD token estimator `tokenEstimator.ts countTokens` (R V3; file is 75 lines (v)): estimated sources must come in the composition payload (CAT C12 "estimator stays Rust"). INFERRED: H33 already returns the estimated sources; if not, that is an addition to C12. Numbers will shift where the TS and Rust estimators differ (DD-16).
- Stays: `buildTurnPoints` fold (one point per turn of one loaded timeline; exact four-bucket arithmetic via `src/shared/tokenBuckets`, which stays, section 5).

### V4 Cache tab (CacheTab.tsx, cacheShared.tsx) - C16/C23/C05
- Displays: SLI trend (overall, below-threshold count, worst 12), top break causes and wasted-$ leaderboard (top 20), fleet tree.
- Today it hydrates `HYDRATE_LIMIT = 25` roots' timeline + composition and runs `buildCacheBreakReport` in the browser (CacheTab.tsx:15, 221-240).
- Feed: SLI = NEW `cache_sli` (N5: overall = Sigma read/(Sigma read + Sigma create), count below `threshold`, worst 12, over the whole filter and window from the rollup); leaderboard = Q42 `get_cache_break_causes(scope, minTokens, window, topN)` (C23, RA F32 `cache_break_events`), whose output shape is UNVERIFIED (decision OD-3); fleet tree = Q8 `get_subagent_tree` (C05, RA F09/F10) per expanded root.
- Deleted: the 25-session hydrate effect and both client aggregations (CacheTab.tsx:221-267), `buildCacheBreakReport`, `buildSpawnRollup` calls (cacheShared.tsx:2), the `childrenByParent` full scan (CacheTab.tsx:211-219).
- Threshold `cacheHitSliThreshold` (state.ts:461, default 0.7 (v at 461)) is sent as a param; the per-agent thresholds stay client config (localStorage, V11).

### V5 History tab (HistoryTab.tsx) - C13
- Displays: per-step table for ONE picked session, burn events, resident cost list.
- Feed: `cards_page` (picker; today `filteredSessions`, HistoryTab.tsx:262), `session_history` (F20), `session_timeline` (generatedFiles), Q25 (resident cost).
- Deleted: client `stepCostUsd` pricing (HistoryTab.tsx:6; `uncached = max(0, usage.input - cacheRead - cacheCreate)`): the server adds `costUsd` per step (Rust `step_cost`, R 7.3B) and keeps the cache-INCLUSIVE `usage.input` convention (CAT C13); `buildResidentCostReport` (HistoryTab.tsx:7).
- Stays: `detectBurnEvents` rules (cache-create >= 50,000, cache break, model switch, fleet spawn; R V5) as a per-session fold of one loaded history. INFERRED: no Rust counterpart; if `jgrep` finds one at implementation time, serve it instead.

### V6 Lifecycle tab (LifecycleTab.tsx) - C27
- Displays: lifecycle events and cache-risk commands.
- Feed: H12 `lifecycle-events?kinds&limit=300` (RA F40), H24 `cache-risk-commands?window&limit=300` (RA F24) (R V6). Already server-queried and bounded at 300; no change in phase 1. A cursor is available (RA F40 PAGE) but not required by the owner rule.
- Smoke gap: `TAB_CONTENT` has no `lifecycle` entry (dashboardSmoke.test.ts:163-172 (v): sessions, context, cache, history, analytics, patterns, export, import) although `lifecycle` is in `TABS` (App.tsx:47 (v)): add it (selector read at implementation time).

### V7 Analytics tab (Analytics.tsx, Cost.tsx charts, Agents.computeStats, SessionCharts.tsx) - C34
- Displays: estimated cost per day/per agent, agent breakdown, context growth, token usage per session.
- Feed: `daily_stats` (F45 / N4: rows per local day x source with input/output/cacheRead/cacheCreate/costUsd/llmCalls/toolCalls/errors/durationMs, params filters + window + `tz`). RA F45 and CAT C34 still say "UTC days, costUsd 0, totalTokens input-only"; DL D-12 FIXES those, so the function must return real cost and all four token buckets. Per-session charts (newest `CHART_MAX`=25, Analytics.tsx:100; state.ts:12 (v)): `cards_page` limit 25. Context growth: Q7 `get_context_growth` (RA F08) per charted session, replacing 25 full `loadSessionDetail` timelines (Analytics.tsx:106-114); PROPOSED N10: accept `ids` (<=25) to make it one request.
- Deleted: `calcSessionCost` per-day sums and `sessionDateKey` bucketing (utils.ts:536), `computeStats` (Agents.tsx:6, per-source totals/tool counts/cacheHitRate/ttft/durations over a card array), client `timeOrdered` sort/slice (Analytics.tsx:94-100), the time-window re-filter in Agents (Agents.tsx:100-110), `dailyStats`/`lifetimeStats` signals fed by F1 (Cost.tsx:506-507; state.ts:80-81).
- Disclaimer rates date `PRICING_LAST_UPDATED` (Analytics.tsx:11, Cost.tsx:7) comes from `cards_stats.pricingLastUpdated`.

### V8 Advisor tab (Patterns.tsx + Instructions.tsx) - C06
- Displays: token totals, Instructions suggestions, EfficiencyMap, ClaudeMdTips, CostTrend, HotFiles.
- Feed: suggestions = H26 `instruction-suggestions?workspace=` (C06, RA F11 feeding the Rust advisor); H27 `instruction-files` may now feed `existingText` (R V8: the standalone shim ignores it today, so `existingText` is empty - DD-17); totals = `cards_stats`; CostTrend = `daily_stats`; EfficiencyMap = `cards_page` sort `cost` capped top-N; HotFiles = NEW `hot_files` (N7: file frequency from `tool_use`, top 20; R V8 computes it from card fields `filesRead/filesChanged/filesWritten`, which would otherwise have to ship in every card).
- Deleted: `generateSuggestions` (Instructions.tsx:321, a client duplicate of `instruction_advisor.rs`/H26/Q5, R V8), the wsSessions filter (Instructions.tsx:645-647), `filteredSessions` reads (Patterns.tsx:429; Instructions.tsx:642). H26 requires a `workspace` (prefix match): the "all" workspace case needs a defined behaviour (INFERRED: empty = all; confirm in C06).

### V9 Export / Import tabs (Export.tsx, Import.tsx) - C31
- Export: section 2.6 (`export` route, N8, `ids` = the checked/filtered set or the whole filter). Count shown from `total` (Export.tsx:15-16 uses `filteredSessions.length`).
- Import: unchanged (`POST /api/import`, H13; ui.rs:484 test). After success the client treats the response as a `reset` for its own mounted queries (the server also pushes an update frame, R F1 (3)).

### V10 Help tab - C28
- Static; no data. Unchanged. (Smoke has no selector for it; not required.)

### V11 Alerts / Automation / Settings - C08
- Displays: client threshold rules (localStorage), server burn alerts from F2, hook switches.
- Feed: F2 `burnStatus` unchanged (C08); H5/H6 hook-config unchanged; rule INPUTS change.
- Today the rules run over `filteredSessions` on every SSE update (Alerts.tsx:648-663; Automation.tsx:457-460; BellButton App.tsx:223-225; `checkAlerts`/`computeAlertCount` Alerts.tsx:378-392). With paging they run over the WORKING SET = page 1 of the current list + sessions active in the last N minutes (`cards_page` filter `activeWithin`, PROPOSED param) + `cards_stats` totals for `buildDisplaySummary` (utils.ts:573-600). Rules that need a timeline use card columns (`peakContextPerTurn`, `loopSignals`, a PROPOSED `activeComputeMs`) instead of the lazily loaded timeline (R V11: today they see only sessions whose detail happened to load).
- DD-8 / OD-5: alerts for a session outside the working set stop firing (options in section 9).
- Deleted: `buildSpawnRollup`/`buildCacheBreakReport` in Alerts.tsx:3,14 (spawn antipatterns come from Q8 / C05; cache context-window checks from card columns).
- Settings clear button: unchanged, see 2.8 (OPEN).

### V12 Trace / Flow / Charts components - C03/C19
- Traces (Traces.tsx 1,909 lines): roots from `cards_page` (Traces.tsx:1843-1868); children via `cards_children` (replacing `sessionSummary...filter`, Traces.tsx:1738) and by-id lookups (Traces.tsx:1462, 1636) via `cards_by_ids`; per-call tree `call_context` (F26, C19, lazy); per-step cost from the timeline payload `costUsd` (R V12 lists it as a read field); cache breaks per turn from the served report (section 5: `cacheBreaksByTurn`, `diffTurnSources`, `CAUSE_LABEL`, `buildCacheBreakReport` at Traces.tsx:19 are replaced by served data). `entryBeforeWindow` (Traces.tsx:22, 1554, 1561) stays, fed `resolvedWindow.since` instead of a browser clock.
- Flow (Flow.tsx:687), SessionCharts (imports five session signals at line 3 and has no other reference to them: INFERRED unused imports), Tools (Tools.tsx:149), TranscriptView (H35, C14), GeneratedFilesView, CopyBranchButton (reads `sessionSummary.sessions` at CopyBranchButton.tsx:149: becomes `cards_children` + `cards_by_ids` for the branch): see V14 for the unmounted ones.

### V13 Live sidebar (index.html + sidebarWebview.ts) - C34
- Displays: status, agent, duration, prompt, model, sparkline, counters, tokens, cost, burn rate.
- Feed: SSE live keys (`isActive`, `lastActivityMs`, `sessionCount`, `agentSources`, `currentSession`, `burnRate`, `avgInputTokens`, `avgOutputTokens`; sidebarWebview.ts:352-373) and `__SIDEBAR_INIT__` (index.html:540 (v)): both unchanged in shape (CAT C34 `sql_sidebar`, `sql_current_session`). Revision 1 said "the quirk `latestSession` = OLDEST card stays (CAT 4 quirks)"; DL D-12 lists exactly that quirk among those FIXED, so it does NOT stay: `currentSession`/`latestSession` becomes the most recently active root (exact definition is the C34 / RA F46 card's; RA F46 and CAT section 4 quirks list still say "OLDEST", flagged). Only the heavy `sessionSummary` leaves the frame. No smoke coverage today (R V13): add one (section 7).

### V14 Unmounted views (Agents, Cost, Flow, Tools, Insights) - C38
- Not mounted by `ActivePanel` (App.tsx:55-69, R V14). They still read `filteredSessions`/`rangedSessions`/`sessionSummary` (Cost.tsx:411-413; Tools.tsx:149; Agents.tsx:103; Insights.tsx:488-490; Flow.tsx:687). They must compile after V0's deletion, so each is either (a) deleted under the C38 decision or (b) rewritten onto `cards_page`. Recommendation (INFERRED, cheapest): decide C38 FIRST; delete the unmounted entry components, keep only the helper exports that mounted views import (`computeStats` goes away with V7; `CostBarChart`, `fmtUsd`, `FlowCanvas`, `ToolsChart`, `generateInsights`, `InsightCard`, R V14).

## 4. The 17 files that read `filteredSessions` (disposition)

grep over media/src (v) lists 18 files for the token `filteredSessions` (the 17 below plus the declaring state.ts); `sessionSummary` appears in 13 files.

| file | line | use | disposition |
|---|---|---|---|
| App.tsx | 11, 882 | count label | `total` from the list query |
| utils.ts | 2, 568, 578 | `buildDisplaySummary` default; `getSessionOffset` | overview totals / working set; `getSessionOffset` deleted (no caller (v)) |
| tabs/Sessions.tsx | 579 | the list | `cards_page` + children |
| tabs/Alerts.tsx | 650 | rule inputs | working set (V11) |
| tabs/Automation.tsx | 460 | in-progress rules | active working set (V11) |
| tabs/Analytics.tsx | 86 | all charts | `daily_stats` + page limit 25 (V7) |
| tabs/CacheTab.tsx | 204 | roots + hydrate | `cache_sli` + Q42 + Q8 (V4) |
| tabs/ContextTab.tsx | 504 | roots tree | `cards_page` roots + children (V3) |
| tabs/Traces.tsx | 1845 | roots tree | `cards_page` roots + children (V12) |
| tabs/HistoryTab.tsx | 263 | session picker | `cards_page` (V5) |
| tabs/Patterns.tsx | 430 | totals and charts | stats/daily/hot-files (V8) |
| tabs/Instructions.tsx | 643 | suggestion input | H26 (V8) |
| tabs/Export.tsx | 16 | export set | export route (V9) |
| tabs/SessionCharts.tsx | 3 (import only) | none found | delete import (INFERRED unused) |
| tabs/Cost.tsx | 412 | unmounted view | C38 |
| tabs/Flow.tsx | 688 | unmounted view picker | C38 |
| tabs/Insights.tsx | 489 | unmounted view | C38 |

## 5. Duplicated server logic in `src/shared`: keep or serve (per module)

Rule: a computation that duplicates Rust logic OR runs over many sessions is served; a pure per-row arithmetic helper with ONE definition shared with the server stays. Importer counts are NOT re-established: revision 1 said 19 non-test importers for `pricing.ts`; a loose grep for the path fragment `shared/pricing` over src/ and standalone/ (non-test) now returns 23 files (it also matches sibling modules whose name starts with `pricing`), so re-count with `tldr references` at implementation time. `cacheBreak` is imported outside tests by `src/mcpServer.ts` (v) plus one more path-fragment match.

| module | dashboard use | decision | reason |
|---|---|---|---|
| `src/shared/pricing.ts` | sessionMetrics.ts:3, HistoryTab.tsx:6 (rates), Analytics.tsx:11 and Cost.tsx:7 (`PRICING_LAST_UPDATED`) | SERVE cost; dashboard stops importing it | A second rate table in the browser drifts from the Rust cost-from-totals-at-now rule (CAT FND-04, R 7.1 decision 4). The module stays for its non-dashboard importers (`src/mcpServer.ts`, `src/burnMonitor.ts`, ...) and `pnpm run check-pricing-export` (`node scripts/export-pricing.js --check`, package.json:84, part of `compile`) must stay green. Whether TS and Rust rates are kept in lockstep is the existing R 7.1 decision 5 (CLAUDE.md names `pricing.ts` as the single rate source; R 7.1 says pricing stays a Rust function): not decided here. |
| `src/shared/cacheBreak.ts` | Alerts.tsx:3, Traces.tsx:19, CacheTab.tsx:8 | SERVE the report incl. labels and per-turn breaks | A third copy of the classifier (Rust `cache_break.rs` Q27, TS shared, TS `cacheBreakTimeline.ts`, R V4). Only non-test importer left is `src/mcpServer.ts`. New HTTP function for Q27/C16 (N6). Closes CAT C16 "decide fate of TS duplicates". Deleting the module is a separate card after `tldr references` and the parity-oracle check (project memory `ts-dead-code-vs-rust-parity-oracles`), because rust-core fixture generators may run it. |
| `src/shared/spawnRollup.ts` | Alerts.tsx:14, cacheShared.tsx:2 | SERVE (Q8 / RA F10 `spawn_rollup`, already in CAT C05) | same reasoning; `spawnKindBadge` label mapping stays in the dashboard (presentation). |
| `src/shared/residentCost.ts` | HistoryTab.tsx:7, ContextTab (R V3) | SERVE via Q25 (Rust has `residentcost_parity.rs`, CAT Q25) | Rust implementation exists. |
| `src/shared/tokenBuckets.ts` | utils.ts:3, sessionMetrics.ts:4, Flow/Insights/SessionCharts/Agents/Traces | KEEP | Three tiny pure functions (`contextTokens`, `cacheHitRate`, `disjointBuckets`) shared with six server TS modules; documented single convention (utils.ts:64; sessionMetrics.ts:17); arithmetic over rows already loaded; serving them gains nothing. Card-level `cacheHitRate` and `peakContextPerTurn` are already server fields. |
| `src/shared/timeWindow.ts` | state.ts:3 (`sessionInWindow`), Traces.tsx:22 (`entryBeforeWindow`) | `sessionInWindow` -> SQL; `entryBeforeWindow` KEEP | The first is a corpus filter; the second dims one already-loaded step relative to the resolved window. media/src has exactly 2 importers (v). After the change the file has one export; its unit test keeps the overlap cases as the oracle for the Rust predicate. |
| `src/shared/cacheRiskKinds.ts`, `branchSerialize.ts`, `embedParams.ts` | LifecycleTab, CopyBranchButton, dashboard.tsx | KEEP | styling/serialisation/URL parsing, not data logic. |

Other client duplicates handled above: `generateSuggestions` (V8), `tokenEstimator.ts` (V3), `computeStats` (V7), `calcSessionCost`/`calcEntryCost` (V2/V12). `pnpm run check-mirrors` (scripts/check-no-mirrors.js) must stay green: nothing is re-declared under media/src.

Where shaping lives: RA 1.3 says the function layer returns rows/columns only and shaping lives in the legacy adapter. The new dashboard functions that return a REPORT (`cache_sli`, the cache-break report N6, `hot_files`) have no legacy adapter, so each is registered as an RA FnSpec whose Rust wrapper shapes the result into one object, as F10 `spawn_rollup` ("one object") already does. RA should state this explicitly (revision log).

## 6. Server additions this spec needs that are NOT in SPEC-operation-catalog.md / SPEC-read-api.md (PROPOSED; each needs a card)

| id | what | feeds | note |
|---|---|---|---|
| N1 | `changes?since=v` -> RA 6 frame fields | polling fallback | needs `ingest_batch_root` retention (RA OPEN-R6); C34 neighbour |
| N2 | `cards_page` params `source,dataSource,workspace,initiator,q,window,since,until,tz,sort,dir,activeWithin`, data fields `total`, `top_n`, `truncated`, `resolvedWindow`; card columns `nk`, `rootNk`, `costUsd`, `isUnpriced`, `activeComputeMs`, `archivedLines`; `cards_stats` facets + `pricingLastUpdated` | V0, V2-V5, V8, V11 | RA F02 today takes only `limit`, `cursor`; the SQL `cost` sort is decision ND-1 |
| N4 | `daily_stats` with `tz`, real `costUsd`, all four token buckets | V7, V8 | extends F45; contradicts RA F45 quirks, see DL D-12 |
| N5 | `cache_sli` | V4 | |
| N6 | `session_cache_breaks` = Q27 per session as a FnSpec | V4, V12 | Q27 is MCP-only today |
| N7 | `hot_files` | V8 | |
| N8 | `GET /api/export` streaming | V9 | |
| N10 | Q7 batch (`ids`<=25) | V7 | optional |
| N11 | `archived_lines(nk, cursor(gen, byte_off), limit)` | V2 transcript toggle | R1-D4; PAGE bound |
| N12 | window grammar `<n>m`, `all` | all | ND-8 |

(N3 and N9 of revision 1 are dropped: N3 never existed in revision 1's table; N9 `turnFrom/turnTo` is replaced by the RA leaf cursor.)

## 7. TypeScript and test plan (concrete)

### 7.1 Gates (each must be run and its output read)

Run in this order, from the repo root with absolute paths in the commands the agent types:
1. `pnpm run check-types` (tsc twice: `src/` and `media/src/`), `pnpm run lint`, `pnpm run check-mirrors`. These three are the owner-named gates.
2. `pnpm run compile`: package.json:56 chains check-types, lint, check-mirrors, `check-single-expansion`, `check-duckdb-only`, `check-pricing-export`, `check-identities`, `check-guards`, `check-dist-contents`, then `node esbuild.js`. Revision 1 listed only a subset; running `compile` covers the rest. `check-single-expansion` matters here because the query store replaces the expansion signals' consumers.
3. Deploy discipline (CLAUDE.md gotcha): a change is live only after `node esbuild.js` succeeds AND `agentlenspro server restart`; grep a new symbol (for example `queryStore`) in `media/dashboard.js`, and check which `agentlenspro` is on PATH before measuring (CLAUDE.md "Check WHICH agentlenspro").
4. Unit (mocha, `pnpm run test:unit`; single file: `pnpm run compile-tests && npx mocha out/test/test/shared/pagedQuery.test.js`): new `src/test/shared/pagedQuery.test.ts` asserts (a) key canonicalisation: sorted keys, defaults omitted, preset keys contain no `since/until` and are identical across two simulated clocks; (b) the stale-rule tables of 2.5 row by row, including `changedRoots:null`, `reset:true`, ignore of `v` <= client `v`, changed `boot_id`; (c) byte-budget eviction order (least recently used first, expanded entries pinned), dropping a page keeps its cursor; (d) a negative control: the same walk with a `last_active` cursor must report duplicates (proves the test can fail, RA T2). `src/test/timeWindow.test.ts` stays as the overlap oracle.
5. Rust golden tests of the new functions are the RA section 9 tests T1-T12 (paging T2, version T3, bound T4, time T10): this spec only adds cases for `cards_page` filters (each filter alone and combined equals the old client `filteredSessions` on the FND-00 corpus), `cost` top-N equals the old client sort over the same priced corpus, `tz` 400 on an unknown name, `daily_stats` day buckets for UTC+14, UTC-8 and Europe/Rome across 2026-03-29 and 2026-10-25.
6. Browser: `pnpm run test:browser` (package.json:91: `compile-tests`, `node esbuild.js`, then `AGENTLENSPRO_BROWSER_TESTS=1 mocha ... out/test/test/browser/dashboardSmoke.test.js`; CI sets the variable at .github/workflows/ci.yml:195). The existing suite uses puppeteer-core, headless (`headless: true`, dashboardSmoke.test.ts:298), an isolated HOME with transcripts written before boot (FIXTURES at :115), screenshots under `reports/screenshots/` (:38) and `button.tab[data-tab=...]` selectors (:346).

### 7.2 Fixture server (changes to dashboardSmoke.test.ts)

- Seed: replace the 4 sessions at :115-119 by 130 roots with distinct `created_ms`, 3 of them sharing ONE `created_ms` to exercise the `nk` tie-break, 3 roots with 2 sub-agents each (one sub-agent id reused under two parents, the E4 collision), and 1 root whose transcript is later replaced by a different file at the same path (new inode) to produce `archivedLines > 0` (2.7). 130 roots = 3 pages at size 50. Transcript timestamps for tz tests: two sessions at 23:30 UTC and 00:30 UTC of the next day.
- Readiness: the loop at :284 (`GET /api/summary`) becomes `GET /api/q/cards_stats` and waits until the root count equals the seeded count and `complete` is true (a poll loop with a 60 s deadline, as now). Poll cadence stays the harness's.
- Each test opens its own page with `newPage(theme)` and closes it in `finally`; take a process-table snapshot to a file before and after the suite (`ps -eo pid,ppid,etime,command > <file>`, never a piped grep) and assert no extra Chrome or alcore pid remains (testing rule).

### 7.3 Per-tab test matrix (each test runs for `dark` and `light` via `newPage(theme)`, screenshot named `p10-<tab>-<theme>-<stamp>.png` in `reports/screenshots/`, zero console errors asserted as at :368)

| tab (selector) | seed used | assertions | queries the page must issue (CDP `Network.responseReceived` log) |
|---|---|---|---|
| sessions `#sessions-content` | 130 roots, 3 with children, 1 archived | page 1 has exactly 50 rows (replaces `rowCount === FIXTURES.length` at :355); scrolling the sentinel loads page 2 and 3 (130 rows total, no duplicate `nk`); the 3 equal-`created_ms` roots appear once each in `nk` order; expanding a root issues `cards_children` and shows its children; switching to sort `cost` shows the "top 100" label and `truncated` rows stop at N; "N sessions" equals `total` (130) not 50; archived toggle visible only on the replaced root | `cards_page` x3, `cards_children`, `session_timeline`, `archived_lines` |
| context `#summary-context-content` | same | root tree shows 50 roots then loads more; expanding turn points issues `session_history`; no `tokenEstimator` call path (grep the bundle) | `cards_page`, `session_timeline`, `context_composition`, `session_history` |
| cache `#summary-cache-content` | same | SLI, worst-12 and leaderboard render from ONE `cache_sli` and ONE `cache_break_events` call, and NO per-root hydrate burst (at most 2 timeline/composition requests, not 25) | `cache_sli`, `cache_break_events`, `spawn_rollup` |
| history `#summary-history-content` | same | picker lists 50 then paginates; picking a root issues one `session_history`; step costs come from the payload (page script has no `stepCostUsd`) | `cards_page`, `session_history` |
| analytics `#analytics-content` | tz sessions | day bucket of the 23:30 UTC session differs between `emulateTimezone('Pacific/Kiritimati')` and `emulateTimezone('America/Los_Angeles')` and equals the Rust-computed expectation; a `tz` of `Not/AZone` set by a request override yields a visible error, not UTC data (400, fail fast) | `daily_stats` with `tz=` |
| patterns (Advisor) `#patterns-content` | same | HotFiles from `hot_files`; suggestions from `instruction-suggestions` | `hot_files`, `daily_stats`, H26 |
| lifecycle (selector read at implementation; the missing `TAB_CONTENT` entry is added) | hook events fixture | tab mounts, list bounded at 300 | H12, H24 |
| export `#export-content` | same | click Export: a download whose file has the 20 keys of R V9 for ALL 130 roots (not 50); redacted variant has `userRequest` `"[redacted]"`; file name carries the `tz` date | `GET /api/export` |
| import `#import-content` | an export file | import succeeds, store reset, list refetched | `POST /api/import`, `cards_page` |
| help | none | tab mounts (no selector today: add `#help-content` check only if one exists) | none |
| sidebar (index.html live keys) | one active root | `__SIDEBAR_INIT__` present; the SSE frame updates status/prompt; new smoke coverage (R V13) | SSE `update` frame |

Cross-cutting tests (one each):
- Whole-corpus guard (the owner rule as an executable check): the HTML shell contains no `"sessions":[` JSON and `window.__INITIAL_SESSION_SUMMARY__` is undefined; no `/api/*` response during the test carries more than 200 cards; the page never requests `/api/summary`.
- SSE refresh: append a new transcript, assert the new root appears at the top of page 1 within one coalescing period plus slack (poll loop with a deadline), and that a page-2 row is NOT refetched when unaffected (count of `cards_by_ids` requests = 0).
- Polling fallback: abort the `/events` request with request interception (`page.setRequestInterception`), assert the page polls `changes` and never `/api/summary`, and still updates.
- Reconnect: kill and restart the SSE connection, assert the client sends `Last-Event-ID` and does not refetch everything (the 2.5 behaviour that replaced revision 1's "reconnect = null").
- Clear: only the generic rule is tested (a changed `clear_epoch` drops the store and refetches); no watermark UI test until the contract revision (2.8).
- Shim removal: the old shim message types `searchSessions` and `exportSessionData` are never posted (spy on `postMessage`).
- Existing unrelated smoke tests (transcript sub-tab :380-426, hook-switches :432-494) stay green.

Unverified by this spec: that `page.emulateTimezone` is available in the pinned puppeteer-core (INFERRED from its public API; check at implementation) and the exact `lifecycle`/`help` content selectors.

## 8. Changes of behaviour for the user (seed for CONTRACT-DELTA; numbering continues CAT section 4, INFERRED)

| # | change | views | evidence / note |
|---|---|---|---|
| DD-1 | Default order is `created_ms DESC` (immutable), not the card `startTime`. A node's `created_ms` is its first TIMESTAMPED line; a node with no timestamped line is not listed (DL D-DAT-6, R1-D5). Revision 1 said such roots "sort by file mtime"; that mtime fallback was only E4's simulation of 9,912 untimestamped-first-line files out of 27,779 files (its documented bias), not the design | V0, V2-V5 | E4 header; R1-D5; CAT C01 ordering |
| DD-2 | Sorts by tokens, duration, errors, cost, model, prompt show only the top N (PROPOSED 100) and are not scrollable past it; start (and possibly source) stay fully pageable | V2 (list header), V0 | DL D-5; E4: mutable-key cursors dup/miss; state.ts:107 |
| DD-3 | "N sessions"/"N stored" come from server counts for the whole filter; no longer the length of the loaded array | V1, V2, V9 | App.tsx:882; Sessions.tsx:670 |
| DD-4 | Filters match root rows only; sub-agents show under their root. Today a child whose parent is filtered out is promoted to top level (Traces.tsx:1860-1864; CacheTab.tsx:207-209) - that promotion is gone | V2-V4, V12 | OD-4 |
| DD-5 | Time presets resolved by the server clock; chip shows server-resolved window; no browser clock skew | V1 | R 7.3H |
| DD-6 | Analytics: per-day cost uses real server cost over the WHOLE window and the browser tz via `tz` with Rust buckets (today: cost from cards, UTC totals zero-cost) | V7, V8 | DL D-12, D-14 |
| DD-7 | Cache SLI and cause leaderboard cover the whole filter/window; no longer the first 25 hydrated roots | V4 | CacheTab.tsx:15, 223 |
| DD-8 | Alerts/automation evaluate the working set (page 1 + active), not every session; alerts for old unloaded sessions stop firing | V11, V1 bell | OD-5 |
| DD-9 | Export covers the whole filter server-side, file name from the server clock and `tz` | V9 | index.html:223-262 |
| DD-10 | Text filter is server substring match (LIKE-escaped, DuckDB case-folding) | V0 | state.ts:598 |
| DD-11 | First paint is a skeleton; one extra round trip because the shell no longer inlines the summary | all | CAT S4 removal |
| DD-12 | Poll fallback hits `changes`, not `/api/summary`; a slow server no longer returns the corpus every 2 s | shell | index.html:373-385 |
| DD-13 | F1 loses `sessionSummary` (CAT D6), `analyticsData`, `sidebar`, `summary.toolCalls`; gains `v`, `since`, `boot_id`, `clear_epoch`, `changedRoots` (and `reset`/`overflow`) | V1, V13 | update_payload_parity.rs oracle changes |
| DD-14 | Costs shown come from the Rust pricing path; small differences from the old TS calculation are possible (scheduled price changes priced at now; `isUnpriced` now a server field) | V2, V5, V7, V12 | CAT FND-04; R 7.3B |
| DD-15 | History step cost is server-computed (cache-inclusive input handled server-side) | V5 | R V5 |
| DD-16 | Context-tab estimated sources come from the Rust estimator; the third TS estimator is removed, numbers shift | V3 | R V3 |
| DD-17 | Advisor suggestions come from the Rust advisor; with H27 wired, `existingText` is no longer empty so already-covered suggestions disappear | V8 | R V8 |
| DD-18 | `sessionLimit` and `displaySessions` removed (vestigial) | V0 | state.ts:463, 541 |
| DD-19 | Workspace dropdown lists workspaces from server facets; the mounted-page cap of 10 pages means very long scrolls re-fetch earlier pages | V0, V2 | section 2.1 |
| DD-20 | `evidenceSessionIds` list capped at 200 ids with an explicit error beyond | V8 -> V2 | RA F04 |
| DD-21 | The sidebar's current session is the most recently active root, not the OLDEST card (DL D-12 fixes the quirk) | V13 | DL D-12; RA F46/CAT quirks list stale |
| DD-22 | Window membership uses the clamped, non-decreasing `last_active_ms`; a session with future-dated lines leaves the window earlier than with today's `startMs+durationMs` | V0-V5 | RA 3 (CF H20) |
| DD-23 | A card's totals exclude archived (replaced/pruned) lines; those stay viewable in the Transcript archived-lines toggle | V2 | R1-D4 (b) |
| DD-24 | While backfill runs (`complete=false`) the UI shows an indexing banner and partial totals; before, the dashboard silently showed whatever was loaded | all | RA 1.1 |

## 9. Decisions

### 9.1 Resolved (the decision log answers them)

| id | decision | answered by |
|---|---|---|
| OD-1 | Cards expose opaque `nk` and `rootNk`; detail functions take `nk`; legacy routes keep `sessionId`+`parent` | R1-D5 (identity = dev+inode), DL D-DAT-5, RA F03/F04/section 3 (all keyed on `nk`) |
| OD-6 (page size part) | page size 50, max 200 | RA F02, E4 (measured 50) |
| OD-7 | `tz` handled in Rust with chrono-tz bucket CTEs, no ICU; unknown tz = 400 | DL D-14, D-ENG-1, RA 7 |
| (sort policy) | `created_ms DESC, nk` is the only fully paged order; activity/token/cost orders are capped top-N | DL D-5, E4, RA 3 |
| (quirks) | `latestSession` oldest-card, `dailyStats` input-only and $0 cost are fixed, not preserved | DL D-12 |
| (R1-D4) | archived-lines view exists; placement in ND-5 | R1-D4 |
| (R1-D10) | NOT resolved: under revision, see ND-4 | coordinator message, 2.8 |

### 9.2 Still open (options, recommendation, what would decide)

**OD-2 Per-session timeline size (F06 uncapped by CAT D5).** Options: (a) phase 1 ships the whole timeline of the ONE expanded session as a streamed response (RA 4.5), client folds over it as today; (b) page it with the RA `(byte_off)` leaf cursor and run the folds (keep-warm, waterfall, fileOps) progressively; (c) (a) now, add (b) only for sessions over a size threshold. Recommend (c): the folds in V2 need every turn, and (a) costs nothing to build; the browser byte budget (ND-2) already bounds how many such payloads are held. Decided by: the measured maximum and p99 timeline JSON size over the real corpus (one DuckDB query on `event` after FND-03, or a scan of the largest transcripts), and the browser heap measured with that payload expanded.

**OD-3 Does Q42 return a cause + wasted-$ + `kind::label` leaderboard?** Options: (a) it does, use `cache_break_events`/Q42 as is; (b) it does not, add one WIN function `cache_break_leaderboard` to card C23 (GROUP BY cause, top 20). Recommend verifying before choosing; default to (b) if the output keys are missing, because the V4 leaderboard needs wasted-$ per block. Decided by: the output field list of Q42 in R 3.B (`cbcauses_parity.rs` is the oracle), which neither revision of this spec re-read (revision 1 cited it as R 3.T, CAT says R 3.B: corrected).

**OD-4 Child whose parent is filtered out.** Options: (a) drop the promotion (filters match root rows; DD-4); (b) a root also matches when any descendant matches `q` (EXISTS over the root's tree); (c) keep today's promotion. Recommend (a) for `source`, `workspace`, `initiator` (children inherit them from the root) and (b) only for `q`, deferred to phase 2, because sub-agent prompts are their task text and a user searching for it expects its root. Decided by: owner product call, and the measured cost of the descendant EXISTS over `root_cache`/`spawn_edge` at 27k roots (RA bench).

**OD-5 Alerts outside the working set.** Options: (1) client rules over the working set (page 1 + active roots + overview totals), alerts for other sessions stop firing (DD-8); (2) evaluate the user's thresholds server-side (new catalog entry); (3) server evaluates the built-in thresholds already in F14/F15/F2 and the client keeps only localStorage-configured ones. Recommend (1) now with the UI saying "alerts evaluated on the N most recent and all active sessions", because thresholds are per-user localStorage (V11) and the burn alerts that matter already come from the server (F2/F3). Decided by: an inventory of which client rules (Alerts.tsx:378-392, Automation.tsx:457-460) need sessions outside that set, and the owner's tolerance for losing them.

**OD-6 (top-N size part).** Options: N = 50, 100, 200 (200 = the PAGE max, no new size class). Recommend 100: two screens of rows, one response well under RA's 2 MB page cap. Decided by: p95 latency of a top-N sort over 27k roots in the Rust bench (E4 measured no mutable-column top-N, only cursors).

**OD-8 `GET /api/summary` for non-dashboard callers.** Options: (a) page-only (CAT D6); (b) keep a legacy `?all=1`. Recommend (a): the only consumer is a bench script (CAT H2 consumers) and the owner rule forbids shipping the corpus; the script walks pages. Decided by: contract-delta card (RA OPEN-R4), which must confirm the bench script is the sole caller (grep) .

**ND-1 How is the `cost` sort computed in SQL?** Pricing is a Rust function, cost is "totals priced at now" (FND-04). Options: (a) Rust generates a rate VALUES CTE per request (the same pattern as the bucket CTE, RA 7) and SQL prices `node_rollup` totals; (b) store `cost_usd` on the rollup at ingest (stale after a scheduled price change); (c) price in Rust over streamed rollup rows. Recommend (a): no staleness, one rate source, scan of 27k narrow rows. Decided by: SPEC-method-bench (RA OPEN-R1) latency and whether per-model speed/1h-split pricing fits a CTE.

**ND-2 Byte budget of the query store.** Options: 32, 64, 128 MB of response text. Recommend 64 MB. Decided by: measured browser heap with N expanded sessions at the largest real timeline size (OD-2).

**ND-3 Is `source` cursor-paged?** Options: (a) top-N like the other derived sorts; (b) `(source, created_ms, nk)` cursor (source is immutable per node, R1-ORIGIN). Recommend (a) in phase 1 (RA defines only one cursor), (b) if the source sort proves used. Decided by: RA adding that cursor kind.

**ND-4 Clear semantics and any watermark UI.** OPEN pending decision-log revision 2 (coordinator message). Not designed here; revisit 2.8 when it lands.

**ND-5 Archived-lines placement.** Options: (a) per-session toggle in the Transcript sub-tab (recommended: gen bumps are rare, 0 in the corpus, and the view is per node); (b) a global Archived tab; (c) both. Decided by: owner preference, and by how common gen bumps turn out once the live ingest runs.

**ND-6 Day buckets over long windows.** RA F45 caps day buckets at 400 and `all` on a 218-day-old corpus will pass 400 within months. Options: (a) truncate with `truncated:true`; (b) the client sends `bucket=week` when the span exceeds a threshold (RA `buckets()` already supports Week). Recommend (b) above 365 days. Decided by: owner (changes chart granularity) and RA T10.

**ND-7 Shaping of new report functions.** Options: (a) FnSpec wrapper shapes the report (precedent F10); (b) client folds rows. Recommend (a) (section 5). Decided by: RA owner amending section 1.3.

**ND-8 Window grammar.** Add `<n>m` and `all` to RA's `window` type. Recommend yes. Decided by: RA owner.

## Revision log

Revision 2 (2026-10-03), fact-check against DL, R1, RA, CAT, E4 and the code. Method: read all six inputs in full; re-checked cited lines in media/src, media/index.html, src/test/browser/dashboardSmoke.test.ts and package.json by grep. No source file, git state or build was touched.

Contradictions and errors found, with the fix applied:
1. DD-1 claimed roots without a timestamp sort by file mtime; DL D-DAT-6 and R1-D5 say they are not listed, and the mtime fallback was only E4's experiment bias. Corrected; the 9,912 figure is 9,912 of 27,779 files, not "of 27,367 sessions".
2. V13 kept the `latestSession` = OLDEST-card quirk; DL D-12 fixes it. Corrected (DD-21). RA F46, RA F45 (`costUsd` 0, input-only) and CAT section 4/C34 still carry the old quirks: for their owners.
3. Revision 1 "extended" the legacy H32 routes (N2), contradicting RA 1.3 (existing contracts exact; `/api/q/*` is the additive path). All dashboard calls renamed to `/api/q/<fn>` with a mapping table (2.0).
4. Envelope and frame field names differed from RA (`nextCursor`/`capped`/`asOfMs` vs `next_cursor`/`top_n`/`truncated`; missing `boot_id`, `clear_epoch`, `since`, `reset`, `overflow`, `complete`, `backfill`; `changedRoots` are `nk`). Aligned; indexing banner added (DD-24).
5. Reconnect treated as "everything changed"; RA 6 defines `Last-Event-ID` replay and `reset`. Aligned; N1 polling function reuses the RA 6 frame builder.
6. RA 6 says the legacy `update` frame keeps its shape, contradicting CAT D6 and cutover-all-at-once. Followed CAT D6; RA 6 needs amending.
7. Window presets `15m` and `all` are outside RA's `window` grammar. Added N12/ND-8.
8. `prompt` and `source` sorts were called cursor-pageable with unbacked immutability. `prompt` demoted to top-N, `source` deferred (ND-3).
9. "LRU of 64 entries replacing DETAIL_CACHE_MAX=40" misdescribed the code (four LRUs of 40, state.ts:159/176/328/362/376) and a count cannot bound memory; replaced by a byte budget (ND-2).
10. N9 `turnFrom/turnTo` duplicated RA 3's `(byte_off)` leaf cursor; dropped (OD-2).
11. N3 numbering gap and "R 3.T Q41-Q42" citation (CAT says R 3.B). Fixed.
12. DD-1 style "R F1 data_version" wording: `v` is `max(ingest_batch.id)` read in the page transaction (RA 3). Fixed.
13. Line numbers off by one: state.ts:133->134, :158->159, :63, :12; index.html:82->83, :85->86, :88-93->89-93, :370-385->373-385; App.tsx:379->380, :380->381, :391->392, :411->412. Corrected where re-checked, others marked +-1.
14. The gate list omitted `check-single-expansion`, `check-duckdb-only`, `check-pricing-export`, `check-guards` (package.json:56 `compile` chain). Section 7.1 now runs `compile`.
15. The smoke suite readiness loop polls `/api/summary` (dashboardSmoke.test.ts:284), which D6 breaks; and `TAB_CONTENT` lacks `lifecycle` although the tab exists (App.tsx:47). Added to 7.2/V6.
16. Importer counts for `pricing.ts` (19 claimed) do not reproduce (a loose path grep gives 23); marked as not re-established (section 5).
17. RA 1.3 says the function layer returns rows only, but `cache_sli`, the Q27 report and `hot_files` need shaped output with no legacy adapter. Recorded as ND-7.
18. Day-bucket cap 400 (RA F45) vs a corpus already 218 days old. ND-6.
19. `cost`/`isUnpriced` "server columns" were asserted without a method for SQL cost sorting. ND-1.
20. Added missing contract deltas DD-21 to DD-24 and the archived-lines view (R1-D4, 2.7).
21. Cross-spec: RA F46 and RA F45 quirks, RA 6 legacy-frame sentence, RA window grammar, RA F02 filter params, RA leaf cursor `(gen, byte_off)`. Listed for the RA owner; this spec does not edit RA.

Decisions processed (the 8 open decisions of revision 1): OD-1 resolved (R1-D5/RA), OD-7 resolved (DL D-14), OD-6 split (page size resolved by RA F02/E4; top-N size open), OD-2, OD-3, OD-4, OD-5, OD-8 left open with options, recommendation and decider (section 9.2). DL D-5, D-12, D-14 and R1-D4 applied to the body. R1-D10 NOT applied: per coordinator instruction it is OPEN pending revision 2 of the decision log (2.8, ND-4). New decisions found: ND-1 to ND-8.

Test plan: section 7 rewritten (gates, fixture server changes, per-tab matrix with light and dark screenshots, cross-cutting guards). Not run; unverified items listed at the end of 7.3.
