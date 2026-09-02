---
trdd-id: DCWJY2JJ
title: Expose a cache-state verb (warm or cold) over the already-persisted status-line prompt_cache block
column: ai_review
created: 2026-09-02T01:31:14+0200
updated: 2026-09-02T06:46:03+0200
current-owner: claude-agentlenspro
task-type: feature
project-id: agentlenspro
blocked-by: []
npt: []
eht: []
external-refs: [https://github.com/Emasoft/AgentlensPro/issues/19]
---

# Expose a cache-state verb over the persisted prompt_cache block

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

**Shipped, unpushed.** `4c3480eb` (verb + tests), docs in the following commit. The verb is
`src/cli/cacheStateCli.ts`, dispatched from `main.ts` (classified hot-path 1,500 ms, recipe added
to `cliHotPathLatency.test.ts`); it calls the SAME `authoritativeFromWals` reader `cache-expired`
uses, which gained a `promptCache` field (every `prompt_cache_*` key verbatim). Gates first-hand:
check-types 0, eslint 0, mocha 15/15 (cacheStateCli 6 + cacheExpiredAuthoritative 5 + latency guard
4), esbuild 0, and the PATH binary (`standalone/cli.js`, the dev link) run live: `warm` exit 0,
`--json` echoes 12 `prompt_cache_*` fields, `--session zzzz` exit 2 stdout empty, `--bogus` exit 64.

**Formula, decided on MEASURED rows, not on the card's prose:** 26,690 rows with the block in
the 2026-09-01 parquet parts (DuckDB, read-only): `warm:false` ⇒ `expires_at` already past in
4,141/4,141 rows (lead −1.4 s … −43 min); `warm:true` ⇒ future deadline in 22,398/22,398. The bit is
a snapshot of the clock comparison, so `cold iff now >= expires_at OR warm !== true` agrees with
every observed row and reads cold in the one unobserved combination. 151 rows had no block
(other projects' sessions) — the exit-2 case, live.

**Deliberately NOT built:** a parquet/DuckDB fall-through (WAL-only by design, per the body) and a
server-inference fall-through (unlike `cache-expired`) — an idle session is exit 2, never `cold`.

**NEXT ACTION:** none — all 5 boxes ticked, in `ai_review`. Ships with 2.33.2 (changelog entry
under Added; the release push still awaits the USER's go, see TRDD-1B98LCVR).

Intake of GitHub issue #19 (opened 2026-09-02 01:24 local by the janitor project's session,
consumer TRDD-POA0157J there). The ask has two halves; one is already done.

## What already exists (read 2026-09-02, verify on pickup)

- **Persistence is DONE.** `src/statuslineStore.ts:214-229` declares twelve `prompt_cache_*`
  columns (`warm`, `caching_observed`, `ttl`, `expires_at`, `requests`, `misses`,
  `expected_rebuilds`, `hit_ratio`, `cache_write_tokens`, `miss_recache_tokens`, `last_miss_at`,
  `recache_tokens_if_cold`) captured from the status-line payload's `prompt_cache` block
  (Claude Code 2.1.251/252) on every refresh, under `~/.agentlens/statusline/`. Not a schema
  claim — READ from the live store on 2026-09-02 (CC 2.1.258): the live server's main WAL
  (`statusline/main/2026-09-01/wal-73156.ndjson`) carries `"prompt_cache_warm":true` ×4561,
  `false` ×470 and `"prompt_cache_ttl":"1h"` ×5031. The mapping is the generic flattener
  (`flattenSample`, `statuslineStore.ts:66`: nested objects → `<block>_<field>` keys, arrays kept),
  so there is no per-field extraction to add. The issue author's "nothing under `~/.agentlens/`
  carries warm/cold" did not match this machine's store; the keys are flat (`prompt_cache_warm`),
  and the parquet parts are binary — grep the `wal-*.ndjson` files.
- **Reader-verified, not just writer-verified.** Compaction keeps the VALUES, not just the
  column: rows read from the newest parquet part with the installed DuckDB binding —
  `rows 10014, prompt_cache_warm non-NULL 9990, ttl non-NULL 9990, warm=true 6319`. The 24 NULLs
  were READ, not assumed: single `StatusLineSample` rows from other projects' sessions on CC
  **2.1.257** that arrived without the block — so a modern harness can still send a sample with no
  `prompt_cache`, and NULL → exit 2 is a live case, not a legacy one. The 2026-08-01 part has no
  such column at all — those samples
  predate CC 2.1.252, the store's trap-5 case, and must read as cannot-answer. And
  `agentlenspro cache-expired --json --project "$PWD"` ALREADY prints
  `{"source":"statusline-prompt-cache","expired":false,"sessionId":…,"expiresAtMs":…,"ttl":"1h","sampleTs":…,"warm":true}`
  — `src/cli/cacheExpiredCli.ts:139` `warm: row.prompt_cache_warm === true`. Its selectors
  `--project DIR` / `--session ID` exist (`:40-41`, `:156`). So the whole ask reduces to a
  one-word PROJECTION of a row this verb already resolves.
- **That resolver is WAL-ONLY, by design — keep it so.** `authoritativeFromWals`
  (`cacheExpiredCli.ts:91-93`): "the newest sample of any RUNNING session is in a WAL within
  seconds (~3 s cadence). A session whose newest row was already sealed into parquet has been idle
  long enough that the server-side inference answers it fine — not worth a DuckDB dependency here."
  Measured: `cache-expired --json --session 8a50f82b-…` (idle 2h27m, rows only in parquet) fell
  through to the `doc-matrix` TTL inference. For `cache-state` that fall-through is exactly the
  issue's "fall through to the existing probe only when the signal is stale or absent": a session
  with no WAL sample is **exit 2 with EMPTY stdout**, never `cold`. Do not add a parquet reader
  for this verb.
- **The verb is MISSING everywhere:** `src/cli/main.ts` dispatches `cache-expired` (`:242`) and no
  `cache-state`; 0 hits in the built `standalone/cli.js` and in `skills/*/SKILL.md`.

## What to build

`agentlenspro cache-state [--session ID] [--project DIR] [--json]` printing exactly one word,
`warm` | `cold`, for the selected session/project; exit 0 = warm, 1 = cold, 2 = cannot answer with
EMPTY stdout (no WAL sample, or a sample without the block). **Anchor the verdict on the DEADLINE,
not on the raw `warm` bit**: `prompt_cache_warm` is the harness's verdict AT SAMPLE TIME, and the
status line refreshes only on activity, so an idle session's newest row keeps saying `warm:true`
past its `expires_at` — stale in exactly one direction, toward the wrong action ("hold"). The
existing verb already separates the two: `expired` is `prompt_cache_expires_at` vs the clock
(`cacheExpiredCli.ts:122`), `warm` is the raw bit (`:139`), and `--json` prints both. So:
`cold` iff `expired`; `warm` iff `!expired && warm`; i.e. `cache-expired -q` with the 0/1 exit codes
swapped plus the word on stdout. `--json` prints the last
object verbatim plus capture timestamp and session id, so the consumer pins its reader to what the
harness actually sends, not to changelog prose. Same tri-state contract as `cache-expired`: never
`cold`/`false` for a question that could not be resolved.

Reuse: the selector parsing (`--project`/`--session`, `cacheExpiredCli.ts:156-157`) and the
newest-row resolution behind `cache-expired --json`, which already yields `warm`, `ttl`,
`expiresAtMs`, `sampleTs`, `sessionId`. `cache-state` is that row projected to one word plus the
exit-code contract; a row whose `prompt_cache_warm` is NULL (pre-2.1.252 sample) is exit 2, never
`cold`. Do not duplicate the selection logic — factor the row resolver out of `cacheExpiredCli.ts`
and have both verbs call it.

## Acceptance

- [x] `agentlenspro cache-state` on this machine prints `warm` or `cold` with the matching exit code
      while a session is live, and exits 2 with EMPTY stdout when no post-2.1.252 sample exists.
      (2026-09-02: live `warm`/0 on this session; `--session zzzz` → 2, stdout empty — `4c3480eb`)
- [x] `--json` output contains the stored `prompt_cache` fields verbatim (field names from the live
      object) plus `captured_at` and `session_id`. (12 `prompt_cache_*` keys echoed live)
- [x] One unit test per exit code, on a fixture statusline store (no live server).
      (`src/test/cacheStateCli.test.ts`: 0, 1 ×2, 2, 64 + the `--json` shape; 6/6)
- [x] Documented in the `agentlenspro-diagnostics` skill and CLAUDE.md's CLI block next to
      `cache-expired`; CHANGELOG entry. (skill reinstalled to `~/.claude/skills/`)
- [x] Reply on issue #19 with the verb's contract (self-identification line, no bare `@`).
      (posted 2026-09-02, issuecomment-5504521568; passed the identity-leak guard)

## Notes and lessons learned
