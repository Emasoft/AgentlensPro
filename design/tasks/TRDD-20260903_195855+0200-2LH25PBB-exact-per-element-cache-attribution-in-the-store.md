---
trdd-id: 2LH25PBB
title: Store the cache read-write boundary per body so every element is classified exactly
column: dev
created: 2026-09-03T19:58:55+0200
updated: 2026-09-03T19:58:55+0200
current-owner: claude-code
task-type: feature
severity: HIGH
labels: [store, duckdb, cache, attribution, trace]
relevant-files: [rust-core/crates/agentlens-store/src/api_call.rs, rust-core/crates/agentlens-store/src/lib.rs, rust-core/crates/agentlens-store/src/pass.rs, src/shared/tokenBuckets.ts]
parent-trdd:
npt: []
eht: []
release-via: publish
---

# Store the cache read-write boundary per body so every element is classified exactly

Phase 1 of the approved trace redesign (plan: redesign the trace around exact, reconciled token
accounting). Supersedes nothing; TRDD-0Y8BMVK2 fixed the three presentation defects that exposed
the underlying design flaw.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03 20:00

Design settled and measured; implementation starting. The owner's storage proposal is adopted in
its load-bearing part (precompute and store the boundary; never recompute per query) with two
corrections recorded below. NEXT ACTION: add the boundary columns to the store schema and the
ingest pass, with the key-aware snap, plus the classification unit tests.

## The rule, as measured

Classify every element of a request as cache-READ, cache-WRITE, fresh INPUT or OUTPUT by diffing
against the previous request of the same stream. Four facts establish it, all measured 2026-09-03:

1. **Stream identity is `session_id` + sha of `messages[0]`.** One session id interleaves parent and
   sub-agent streams; keying on the id alone produced a confident false verdict ("the model flipped
   and the whole 840 KB prefix was lost") that dissolved under the correct key.
2. **The diff walks cache order, `tools → system → messages`, not wire order.** The wire body puts
   messages first (`messages[476]` at byte 1,581,228; `system[2]` at 1,582,883; `system[3]` at
   1,598,483). Diffing wire order would report a changed early message as invalidating all 84 tool
   schemas, which is false.
3. **THE BILLING HEADER IS NOT PART OF THE CACHE KEY.** `system[0]` carries
   `x-anthropic-billing-header: … cc_prev_req=…` and changes on **738/738** consecutive main-thread
   pairs, yet `cache_read` is never 0 on any of them — min 55,547, median 457,521, max 658,929, mean
   hit 0.99235. In cache order it sits at index 84, two elements before the earliest breakpoint
   (`system[3]`). A naive first-divergence index would therefore be 84 on EVERY turn and would mark
   every later element a burn. Key-excluded elements must be skipped.
4. **The boundary snaps back to a breakpoint.** `cache_control` markers sit on `system[3]`,
   `system[4]` and the last message. What survives is the prefix up to the last breakpoint at or
   before the first real divergence, not up to the divergence itself.

Reconciliation table (20 consecutive pairs, one linear stream): first divergence `system[0]` on
20/20 while `cache_read` climbs 303,201 → 315,507 and `cache_creation` stays 208–1,275.

## Pairing, which was the blocker

- **Response body → usage: exact, universal.** A response body's `src_name` is
  `<request_id>.response.json`, and `claude_code.api_request` spans carry that `request_id` plus
  `session.id`, usage and `cost_usd`. Joined 9,846 / 9,848 = **99.98%**.
- **Request body → its own request id: exact, conditional.** The successor rule
  `rid(Q_k) = cc_prev_req(Q_{k+1})` holds on a linear stream — 717/841 validated, every failure
  explained (missing span, or genuine fan-out where 17 siblings name one parent). The naive
  nearest-preceding heuristic is worse: 806 assigned, 206 conflicts.
- **No direct link exists between a request body and its response body.** The response carries only
  a `msg_` id, no session id, and shares no stem with the request. Sha-matching the response's
  content blocks against the next request's messages cannot work — different granularity.

## Storage decision (owner's proposal, adopted with corrections)

The owner proposed storing each element in its own parquet column so DuckDB's column compression
dedups unchanged values, with per-element order indices and a `cache_break_index` column.

**Adopted:** precompute the boundary once at ingest and store it, so a query classifies any element
by one integer comparison instead of re-diffing. This is the right call and it is what gets built.

**Measured before deciding** (2026-09-03, the whole store):

| measurement | value |
|---|---|
| raw bytes ingested | 469,253,051,136 (469 GB) |
| unique content after dedup (`Σ blobs.n`) | 6,279,012,480 (6.28 GB) |
| store on disk | 3.4 GB |
| blob references vs distinct shas | 184,591,743 vs 2,825,622 = **65.3×** |
| bodies | 930,109 |
| parts rows | 457,672,204, of which only 184,591,743 are blob refs |

**Correction 1 — keep content-addressing; column compression cannot replace it.** DuckDB chooses
compression **per column segment**, and dictionary/FSST extract repetitions *within* a segment
(<https://duckdb.org/2022/10/28/lightweight-compression>). The 84-tool catalog re-sent across 930,109
bodies over weeks would be re-dictionaried in every row group; content-addressing stores it once
across all of them. That is the measured 65.3× and it is not recoverable from RLE or FSST.

**Correction 2 — a column per element is not expressible, but the owner's real complaint is valid.**
Parquet needs a fixed schema while the element count is unbounded (84 tools, a few system blocks,
messages growing every turn), so a column per message cannot exist. The long form is how a
variable-length ordered list is expressed columnar. BUT the current long form stores only
`(sha, path, idx, n)` and leaves the content opaque, so no query can ask "group by tool name" or
"every request carrying skill X" without re-parsing JSON. **The element table gains semantic
columns** — `element_type, name, role, breakpoint, key_excluded, position, cls, cache_break_index` —
all low-cardinality and integer, i.e. exactly the RLE / bit-packing / dictionary cases the article
describes. Complex queries then run without touching the text; the blob join is display-only.

**Correction 2b — TYPED columns per data kind, measured at 8.2×.** The owner's sharper point: a raw
body mixes hashes, integer token counts, URLs, enum-ish strings and prose, and `blobs.data` puts all
of it in ONE VARCHAR, so DuckDB cannot adapt its scheme to the data. Measured over 200,000 real
`usage` records:

| storage | bytes |
|---|---|
| one heterogeneous VARCHAR of JSON (today) | 14,061,053 |
| typed columns | 1,722,860 |
| **reduction** | **8.2×** |

DuckDB then chose per column, exactly as predicted: dictionary for `cache_creation` /
`output_tokens` / `input_tokens`, plain for the high-cardinality `cache_read`, dictionary for
`service_tier` — **122 bytes for 200,000 rows**. Inside a JSON string those same values are
incompressible noise. So numeric and enum fields become real typed columns (`input_tokens`,
`cache_read_tokens`, `cache_creation_tokens`, `output_tokens`, `cost_usd`, `duration_ms`, `model`,
`role`, `stop_reason`, `service_tier`, `ttl_5m`, `ttl_1h`), timestamps become TIMESTAMP (delta), and
`blobs.data` is left holding ONLY homogeneous text — which also improves its own ratio.

**Correction 2c — a column's type is fixed once and forever, and that must be ENFORCED.** Per-column
compression is chosen from the column's type and content; a column whose type drifts across files
loses its scheme and the parquet grows. Verified 2026-09-03: no drift exists today — `bodies` 8
columns, `parts` 8, `blobs` 3, each with exactly one physical type across every file — but nothing
guards it, and the surface is about to widen. The Anthropic response shape keeps gaining fields
(`ephemeral_1h_input_tokens` arrived with the 1h tier, then `stop_details`, `inference_geo`,
`iterations`), so the rules are:

1. A column's type is set at creation and NEVER changed. Nullability may change; the type may not.
2. New semantics get a NEW column. A name is never reused for a different meaning or type.
3. An unknown or newly-appearing API field NEVER goes into an existing typed column. It lands in a
   dedicated overflow that is itself homogeneous (one JSON-text column), or in a typed key/value
   side table — never widened into a neighbour.
4. A migration that would re-type a column instead adds a new one and backfills.

Enforced by a schema guard that scans every parquet file and fails when any column carries more than
one physical type — the check run by hand above, made permanent, because an unguarded invariant of
this kind fails silently and only shows up as a store that quietly stopped compressing.

**Correction 3 — 273 million rows of JSON punctuation are waste, and that is the owner's point
landing.** Of 457.7M part rows only 184.6M carry content; the rest are commas, braces and field
names stored one row each — 60% of the largest table holding syntax that is reconstructable from the
element list. Drop them.

**Correction 4 — the stored index must be key-aware.** Per fact 3 above, storing a raw
first-difference index would be wrong on every turn. The column stores the snapped, key-aware
boundary; the raw divergence index is stored beside it so the snap is auditable, never hidden.

**Tension named:** computing the boundary needs the predecessor, so it IS a diff — moved from query
time to ingest time, which is the owner's actual point. When the predecessor is not yet ingested the
column is null and a backfill pass fills it. Null means "not yet computed", never "no break".

## Acceptance

- [ ] Boundary columns land in the store schema and are written by the ingest pass.
- [ ] Classification is key-aware (skips the billing header) and breakpoint-snapped.
- [ ] Over a corpus of consecutive pairs, the structural boundary reconciles with the billed
      `cache_read`/`cache_creation`; disagreements are surfaced, never resolved silently.
- [ ] A change confined to messages does not move tools or system out of the cached region.
- [ ] A null boundary is rendered as "not computed", distinct from a computed zero.
- [ ] Round-trip: every body used rebuilds to a matching sha256.
- [ ] Typed columns: numeric/enum/timestamp fields are real typed columns, never JSON text.
- [ ] Schema guard: a check fails the build when any column has more than one physical type across
      the store's files, and a new API field cannot land in an existing typed column.

## Notes and lessons learned

- **Heterogeneous data in one column defeats the database's main strength.** DuckDB adapts its
  compression per column, so a VARCHAR holding hashes, integers, URLs and prose together gets the
  scheme for "mixed text" — the worst available. Splitting by data kind measured 8.2× on real usage
  records, and the enum column fell to 122 bytes for 200,000 rows. The rule that follows: never
  store a value as JSON text when it has a type, and never mix types in one column to keep a schema
  simple. The schema is where the compression decision is made.

- **A mutating element is not necessarily a cache-breaking element.** The billing header changes on
  every request and costs nothing. Any attribution that assumes "changed ⇒ invalidated" reports a
  total prefix loss every turn while the account is measurably at 99% hit.
- **Two false verdicts this session came from the same class of error**: reasoning from structure
  without reconciling against the billed numbers. The billed usage is the oracle; the structural
  diff explains it. When they disagree, the disagreement is the finding.
