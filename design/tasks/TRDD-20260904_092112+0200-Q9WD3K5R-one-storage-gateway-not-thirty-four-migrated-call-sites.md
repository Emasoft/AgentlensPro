---
trdd-id: Q9WD3K5R
title: DuckDB is the gateway — delete the layers between callers and it
column: todo
created: 2026-09-04T09:21:12+0200
updated: 2026-09-04T12:06:32+0200
current-owner: main-session
task-type: refactor
project-id: agentlenspro
scope: project
min-approval-requirement: manager
labels: [architecture, storage, duckdb]
priority: high
severity: high
relevant-rules: []
npt: []
eht: []
implementation-commits: []
external-refs: []
---

# DuckDB is the gateway — the work is deletion, not a new abstraction

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-04

**Supersedes the P2/P3/P4 "migrate each database" plan** encoded in
`scripts/check-duckdb-only.js`'s allowlist. That plan is not wrong so much as aimed one level too
low, and shipping it would have produced a green guard over an unchanged architecture. The guard,
the ratchet and the phase tags all stay — what changes is what "done" means.

**The rebuild-vs-convert question is ANSWERED — 2026-09-04T12:06:32+0200, main-session: REBUILD
from parquet.** Reasons, in the order that decided it:

1. A conversion carries forward data already known to be wrong (the 3,283 sonnet-5 rows overstated
   by $104.60). A rebuild recomputes them with current pricing, and that separate repair decision
   dissolves — as this card's own bottom section anticipated.
2. A conversion preserves the SQLite-shaped schema, which is the thing being deleted. It would
   bake today's model into the new engine and produce the "guard green, architecture unchanged"
   outcome twice over.
3. **A rebuild IS the acceptance test for the directive.** If a `forensics.db` column cannot be
   re-derived from parquet by DuckDB SQL, then parquet is not the memory — and that is a fact worth
   discovering on day one, not after the cutover. A conversion can never surface it.
4. A rebuild is idempotent and re-runnable; a conversion is a one-shot migration that must be
   correct the first time, with the old store gone.

**The risk this accepts, stated so it is checked and not assumed:** a column present ONLY in
`forensics.db` and derivable from nothing on disk would be silently lost. That is why the
derivability matrix (below) is the FIRST deliverable and gates every deletion — not a formality.

**AND THE BRANCH, because a decision with no failure path is a wish.** If the matrix returns a
column that cannot be re-derived, this card does NOT silently continue:

| matrix result | what happens |
|---|---|
| every column derivable | proceed: shared-SQL artifact, then delete the openers |
| derivable only by widening the parquet writer | widen the writer FIRST, backfill, re-run the matrix — still a rebuild |
| derivable from nothing on disk | **STOP and re-decide.** The column is a fact only SQLite holds, which falsifies "parquet is the memory" for that field. Options are: capture it at ingest going forward and accept a gap for history, or keep a DuckDB-native table fed by the same pass — NOT "keep forensics.db" |

Reason 3 above says a non-derivable column is a finding worth having on day one. A finding is not a
plan; this table is the plan.

**NEXT ACTION:** land the derivability matrix
(`reports/duckdb-gateway/*-forensics-derivability-matrix.md`), take the branch it selects, then
build the shared-SQL artifact and delete handle-passing so callers query DuckDB directly. Do NOT
start by swapping engines file-by-file, and do NOT build a gateway object — DuckDB already is one.
Read the resident-data inventory (`*-alcore-resident-data-inventory.md`, TRDD-7YPQWKPG's evidence)
BEFORE finalising the shared-SQL artifact, not after: a resident cache that exists because its
caller cannot express the question in SQL is a constraint on the query set, and it arrives too late
if read afterwards.

### Measured 2026-09-04T12:0x, VERIFIED — these supersede the guesses this card shipped with

- **`api_calls/` holds 184 `part-*.parquet` files, flat, no subdirectories; 3,624 rows; 26
  columns.** Method: `find -maxdepth 1 -type f -name '*.parquet' | wc -l` for the count, and
  DuckDB `DESCRIBE` + `count(DISTINCT filename)` over `read_parquet(..., union_by_name=true,
  filename=true)`. The earlier "182 parts" in this card was `ls -la`'s **link count** read as a
  file count — a directory listing standing in for a measurement, which is the exact defect class
  this card is about.
- **The schema is HOMOGENEOUS across all 184 parts.** `DESCRIBE` without `union_by_name` binds
  successfully at 26 columns, so no generation carries a different column set. Schema drift across
  writer generations would have broken a rebuild specifically (a rebuild reads every part; a
  conversion reads only today's rows) — it does not exist here.
- Columns: `stem, kind, ts_ms, model, raw_bytes, session_id, billing_header, cc_prev_req,
  previous_message_id, system_fps, tools_fp, first_user_fp, breakpoint_positions, tool_choice,
  thinking_config, msg_id, stop_reason, input_tokens, output_tokens, cache_read_tokens,
  cache_creation_tokens, tier_5m_tokens, tier_1h_tokens, cache_missed_input_tokens,
  cache_miss_reason, service_tier`. **There is no cost column** — cost is derived, which is why a
  rebuild recomputes pricing for free.
- **The `duckdb` CLI is NOT installed on this machine** (`command -v duckdb` → empty, exit 127).
  Every DuckDB measurement here ran through the repo's own `@duckdb/node-api`, and the import only
  resolves from the repo root. Any future card that writes `duckdb -c …` as a verification step is
  writing a command that cannot run here.
- **There are THREE SQLite databases, not one:** `forensics.db`, `agentlens.db` (ours) and
  `opencode.db` (OpenCode's — explicitly out of scope, see Non-goals). This card's "the fact table"
  phrasing hid the second one. Any deletion plan that names only `forensics.db` is incomplete.
- **`.pass-state.json` (8.7 MB) is read and written directly, not through DuckDB** — by
  `src/rustStorePass.ts:126`, `src/cli/storeAdmin.ts:77` and Rust `agentlens-store/src/pass.rs`
  (`PASS_STATE_FILE`). It is on-disk state under the store root that the directive's "read only via
  DuckDB" would cover on a plain reading. This card does NOT resolve it; it is filed separately so
  it is not lost.

## Why this exists

USER, 2026-09-04, on being shown a 34-entry exemption allowlist:

> exemptions are code smells. they are the clear sign of a bad architecture.

Correct in direction. The engine a file uses is a symptom; the number of places that reach disk is
the defect.

**But the "34" is NOT that number, and the first version of this card said it was.** Measured
2026-09-04 by counting actual open sites (`initSqlJs(`/`new SQL.Database` in TS, `Connection::open`
in Rust) rather than files that merely mention SQLite:

| | count | files |
|---|---|---|
| TS, opens a SQLite store | **5** | `forensicsDb.ts`, `forensicsIndex.ts`, `database/db.ts`, `database/reader.ts`, `cli/setup.ts` |
| Rust, opens a SQLite store | **2** | `forensics_db.rs`, `opencode.rs` (the latter is OpenCode's own file) |
| Rust, opens **DuckDB** | 3 | `agentlens-store/{bodies_evidence,lib,transcript_sql}.rs` — already correct |

So **~7 real SQLite open sites, not 34** — and more precisely: **4 files OWN the construction**
(`forensicsDb.ts`, `database/db.ts`, `forensics_db.rs`, `opencode.rs`), **3 open through those
helpers** (`forensicsIndex.ts`, `database/reader.ts`, `cli/setup.ts`), **~14 are tests and parity
fixtures** that construct stores because that is what test setup does, and the rest hold a handle
someone else opened or mention SQLite only in a doc comment. That split drives the plan: the 4
owners are what changes, the 3 become query sites, the handle-holders are the ACTUAL coupling, and
the test scaffolding is a separate question. The defect is real and the
USER's point stands — 7 is still not 1 — but it is roughly a fifth the size this card first claimed,
and asserting 34 without counting openers was the same unverified-number habit this session has been
correcting elsewhere.

**And a gateway PARTLY EXISTS.** `agentlens-store` is already a DuckDB layer over parquet with three
open sites and a documented division of labour ("SELECTION is DuckDB over Parquet (pushdown on
session/ts/kind)"). This card is therefore **extend and route through the existing store crate**, not
build a new abstraction beside it — a materially smaller and less speculative job.

The P2/P3/P4 plan would still have been wrong in shape: migrating each file's engine one-for-one
lands N files each opening their own DuckDB connection — exemption count zero, guard green,
architecture unchanged. It would have *looked* like completion.

This is the same defect class the guard itself hit twice while being written (see its header): **a
check whose scope is narrower than the invariant it claims to guard.** `check-duckdb-only.js` asks
"which engine?" and never "how many places?", so it certifies the post-migration tree as clean while
the smell is untouched.

The original directive already said the right thing (TRDD-7YPQWKPG, USER 2026-09-02, IMPERATIVE):

> duckdb is your memory! the rust code should only make queries and report the ephemeral answers to
> the cli! never storing anything!

That is one storage boundary. It was flattened into a per-database checklist.

## What to build

- **`agentlens-store` owns every on-disk read** — parquet, JSONL, the fact table, everything. It
  already owns parquet; extend it rather than introduce a second abstraction. It exposes SQL and
  nothing else. No other file opens any store.
- **THE GATEWAY IS DUCKDB ITSELF — there is no gateway OBJECT to build.** Two thin bindings over one engine,
  one schema, one set of SQL. "One gateway" means one set of QUERIES both languages execute against
  the same parquet, not one code object.
  **But the shared schema and query set IS an artifact, and it does not maintain itself** — that is
  this card's real work, and calling the job purely subtractive would mislead whoever picks it up.
  Today each side holds its own SQL strings; after the deletion they still will, unless something
  makes them share. Open design content: where the SQL text lives, how a schema change reaches both
  sides in one commit, and what stops drift BETWEEN commits — currently nothing, since the parity
  fixtures catch drift in RESULTS, never in queries. The predictable failure is someone reading
  "deletion", removing the handle-passing, and ending with two languages issuing independently
  authored SQL against the same parquet — the same "guard green, architecture unchanged" outcome
  this card exists to prevent, one level up.
  So: **delete the handle-passing, BUILD the shared-SQL artifact.** Two readings must be ruled out explicitly, because both
  are the obvious interpretation of "one gateway" in a two-language repo and both are worse than
  today:
  - **NOT two gateway objects that must agree.** That adds a second parity surface (gateway
    semantics) on top of the existing one (query results) — strictly worse on the axis this card
    cares about.
  - **NOT TS calling into Rust.** The parity fixtures work BECAUSE the TS side is an independent
    reimplementation. Route it through Rust's store and `forensicsindexer_parity` compares Rust
    against itself — a green suite proving nothing, which is the exact failure this session caught
    four times in tests and would here be baked into the architecture. The first draft of this card
    listed that as the PREFERRED option; it is disqualifying.
  - **Open question, do not answer now:** if the shared artifact is SQL text, where does it live — a
    `.sql` file both languages load, or duplicated strings that can drift?
- **Callers hold no handle and no resident data.** They ask a question, get an ephemeral answer, and
  keep nothing — which is the half of the directive about memory residency, not about engines.
- **The engine swap becomes a schema change in one place**, not coordinated edits across two languages.
- **Endpoint: the openers ratchet toward 1.** Stated as a target, not a pass/fail oath — ~14 of the
  34 exemptions are tests and parity fixtures, which may legitimately need to CONSTRUCT a store, and
  whether they can route through the gateway is an open question. Committing to "1 or it was
  bookkeeping" would set a future session up to either declare failure or quietly redefine the
  metric — the same trap the ratchet in `check-duckdb-only.js` had before it was corrected. Decide
  the test/fixture question as part of this card; until then the honest target is "no NON-TEST file
  outside the store crate opens anything".

## Derived work this exposes

- **`check-duckdb-only.js` measures the wrong invariant** and must gain a second cap: how many files
  may OPEN a store at all, regardless of engine. Without it the guard cannot distinguish "migrated"
  from "fixed". Seed the cap at the measured 7 and ratchet down — that number is immediately
  actionable and is a better framing than the 34 this card first led with.
- **The allowlist is defensible only as a countdown.** As a migration ledger with a ratchet to zero
  it earns its place; as a standing list of 34 permanent carve-outs it is exactly the smell the USER
  named. Keep it only while it is shrinking.

## Open question, to answer FIRST — ANSWERED 2026-09-04: REBUILD

**Does the gateway rebuild the fact table from parquet, or convert it in place?** This is the first
design decision, not an implementation detail, and it has a consequence outside this card: if it
rebuilds from parquet, the 3,283 sonnet-5 rows currently overstated by $104.60 are recomputed with
correct pricing as a side effect, and that separate repair decision dissolves. That is a *reason to
decide the rebuild question early* — it is NOT a finding that the rows are already handled.

**Answer: REBUILD.** The rationale, the accepted risk, the failure branch and every measured fact
live in the STATE block above, which is authoritative — deliberately NOT restated here, because two
copies of one answer drift and the STATE block is the single source of truth by rule.

One clarification this section is the right home for: **`api_calls` is already parquet; the SQLite
fact table in question is the derived index `forensics.db`.** A card that says "the fact table"
without naming which one invites exactly the wrong migration, and this one did.

## Non-goals

- Do NOT migrate `opencode.db` off SQLite — OpenCode owns that file. The gateway reads it through
  DuckDB's `sqlite_scanner`; the file stays as it is.
- Do NOT delete `check-duckdb-only.js` because its allowlist looks like a smell. The allowlist is
  the smell's *measurement*; removing the thermometer does not lower the fever.

## Approval log

- 2026-09-04T12:06:32+0200 — **DECIDED rebuild-vs-convert → REBUILD**, by main-session, under a
  direct USER instruction ("decide yourself, but complete all", 2026-09-04). This card carries
  `min-approval-requirement: manager` and main-session is not a MANAGER; the USER outranks MANAGER,
  so the decision is authorized — but it was taken without a MANAGER, and recording only the
  decision would have left the card asserting a governance tier it did not go through. That is why
  this line exists. The field is left at `manager` deliberately: the tier the card NEEDS has not
  changed just because one decision was authorized around it.
