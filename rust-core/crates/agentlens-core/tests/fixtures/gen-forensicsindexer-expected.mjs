// Regenerates the forensicsindexer fixture AND forensicsindexer-expected.json from the COMPILED
// src/forensicsIndex.ts — the parity oracle for SLICE B4 (TRDD-DMWOBWFH): indexApiCalls, i.e. what
// actually lands in the api_calls / call_injections / index_state tables.
//
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-forensicsindexer-expected.mjs
//
// IT HAS ITS OWN SPOOL rather than reusing the SLICE B2 one, for one reason: that fixture contains
// claude-sonnet-5, the single model carrying a `scheduledChange` (introductory pricing ends
// 2026-08-31). B2 never computed a cost so it did not matter; B4 writes cost_usd and
// billable_weight columns, and calcTokenCostUsd resolves rates against Date.now() with no seam — so
// a fixture priced on sonnet-5 would silently change its expected numbers on 2026-09-01. Every
// model here is time-independent.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { indexApiCalls } = await import(path.join(HERE, '../../../../../out/test/forensicsIndex.js'))
const { openForensicsDb, loadSqlJs } = await import(path.join(HERE, '../../../../../out/test/forensicsDb.js'))

const ROOT = path.join(HERE, 'forensicsindexer')
const SPOOL = path.join(ROOT, 'spool')
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(SPOOL, { recursive: true })

const NOW_MS = 1_760_000_000_000
const MIN = 60_000
const uid = (sid) => JSON.stringify({ device_id: 'dddddddd', account_uuid: 'bbbbbbbb-1111-2222-3333-444444444444', session_id: sid })

const bodies = [
  // An attributed call whose response carries the TIER SUB-OBJECT: tier_5m_tokens is stored as the
  // real 25 and the weight uses it directly.
  { name: 'a.request.json', mtimeMs: NOW_MS - 9 * MIN, body: {
    model: 'claude-opus-5',
    thinking: { budget_tokens: 8192 },
    metadata: { user_id: uid('aaaaaaaa-1111-2222-3333-444444444444') },
    diagnostics: { previous_message_id: 'msg_aaaa' },
    system: [{ type: 'text', text: 'Contents of /fixture/.claude/CLAUDE.md (project instructions):\nx' }],
  } },
  { name: 'a.response.json', mtimeMs: NOW_MS - 8 * MIN, body: {
    id: 'msg_aaaa', model: 'claude-opus-5',
    usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 40,
             cache_creation: { ephemeral_5m_input_tokens: 25, ephemeral_1h_input_tokens: 15 } },
  } },

  // THE HEADLINE TRAP: a FLAT cache_creation total with NO tier sub-object, so both tiers read 0.
  // billable_weight must attribute that flat total to the 5-MINUTE tier (its default weight) or the
  // priciest bucket is dropped and the weight disagrees with cost_usd, which already counts it.
  // The STORED tier_5m_tokens column must stay 0 — only the weight sees the synthesized value.
  { name: 'b.response.json', mtimeMs: NOW_MS - 7 * MIN, body: {
    id: 'msg_bbbb', model: 'claude-opus-5',
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 },
  } },

  // An unattributed call on a DIFFERENT model — proves the rate is looked up per row, and that an
  // unattributed row still lands as an honest 'unresolved' bucket rather than being dropped.
  { name: 'c.response.json', mtimeMs: NOW_MS - 6 * MIN, body: {
    id: 'msg_cccc', model: 'claude-mythos-5',
    usage: { input_tokens: 1, output_tokens: 1 },
  } },

  // An UNPRICED model: lookupRates returns null, so cost_usd and billable_weight are both 0 —
  // fail-soft, never a throw and never a guessed rate.
  { name: 'd.response.json', mtimeMs: NOW_MS - 5 * MIN, body: {
    id: 'msg_dddd', model: 'no-such-model-xyz',
    usage: { input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 1000 },
  } },
]

for (const b of bodies) {
  const p = path.join(SPOOL, b.name)
  fs.writeFileSync(p, `${JSON.stringify(b.body, null, 2)}\n`)
  fs.utimesSync(p, b.mtimeMs / 1000, b.mtimeMs / 1000)
}

// A REAL main agentlens.db, so the spawn join is exercised against an actual file that rusqlite
// reads back — not a stub. Its row makes msg_aaaa's session resolve 'direct' with every spawn column
// populated, which is what catches a column-ORDER slip in the 28-placeholder INSERT: with an empty
// map every spawn column would be null and a swap would be invisible.
const SQL = await loadSqlJs()
const main = new SQL.Database()
main.run(`CREATE TABLE sessions (session_id TEXT, spawn_kind TEXT, spawn_model_override TEXT,
  spawn_isolation TEXT, is_sidechain INTEGER, parent_session_id TEXT, model TEXT, spawn_subagent_type TEXT);
  INSERT INTO sessions VALUES ('aaaaaaaa-1111-2222-3333-444444444444','task','claude-opus-5','worktree',1,'eeeeeeee','claude-opus-5','spark');`)
const MAIN_DB = path.join(ROOT, 'agentlens.db')
fs.writeFileSync(MAIN_DB, Buffer.from(main.export()))
main.close()

const FDB = path.join(ROOT, 'forensics.db')
const STORE = path.join(ROOT, 'no-such-store')
const opts = { bodiesDir: SPOOL, storeDir: STORE, withContent: false, forensicsDbPath: FDB, mainDbPath: MAIN_DB }
const result = await indexApiCalls(opts)

// Dump what landed. indexed_at and last_run_ms are Date.now() and are EXCLUDED — they are the only
// non-deterministic values written, and pinning them would make the oracle expire immediately.
const db = await openForensicsDb(FDB)
const dump = (sql) => {
  const r = db.raw.exec(sql)[0]
  return r ? r.values.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))) : []
}
const out = {
  nowMsNote: 'indexed_at / last_run_ms are Date.now() and are deliberately not pinned',
  mtimes: Object.fromEntries(bodies.map((b) => [b.name, b.mtimeMs])),
  inserted: result.inserted,
  apiCalls: dump(`SELECT call_id, request_ref IS NOT NULL AS has_request_ref, ts, session_id, account_uuid, model, effort,
      spawn_kind, subagent_type, spawn_model_override, spawn_isolation, is_sidechain, parent_session, spawn_resolution,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tier_5m_tokens, tier_1h_tokens,
      break_cause, culprit_fingerprint, gap_minutes, frontmatter_fp, cost_usd, billable_weight
    FROM api_calls ORDER BY call_id`),
  callInjections: dump('SELECT call_id, kind, name, tokens FROM call_injections ORDER BY call_id, kind, name'),
  indexState: dump("SELECT k, v FROM index_state WHERE k <> 'last_run_ms' ORDER BY k"),
}
db.close()

// The refs embed absolute paths into this checkout; tokenize the fixture root so the committed file
// carries no home directory and matches on any machine (same reason as the SLICE B2 fixture).
const json = JSON.stringify(out, null, 2).split(JSON.stringify(ROOT).slice(1, -1)).join('<FIX>')
fs.writeFileSync(path.join(HERE, 'forensicsindexer-expected.json'), `${json}\n`)
console.log(`wrote forensicsindexer-expected.json — inserted ${result.inserted}, ${out.apiCalls.length} rows, ${out.callInjections.length} injections`)
