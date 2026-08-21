// Regenerates transcriptsql-expected.json from the COMPILED src/transcriptSql.ts — the parity
// oracle for `run_transcript_sql` (TRDD-DMWOBWFH P4x.2o). Also (re)writes the small synthetic
// transcript tree the query runs over.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-transcriptsql-expected.mjs
//
// THE TRANSCRIPTS ARE SYNTHETIC, and that is not laziness: a real transcript carries the machine's
// own paths, session ids and prose, and this fixture is TRACKED. Everything here is invented and
// deliberately boring.
//
// MTIME ORACLE: file selection is an mtime window against `Date.now()` — inline in the TS, not
// injectable — and git does not preserve mtimes, so a checked-out tree would select whatever the
// clone time happens to make it select. The generator stamps each file at a fixed OFFSET from now
// and publishes the offsets; the Rust test re-stamps with the same offsets before it scans. What is
// pinned is therefore "which files a 24h window selects", which is the actual behaviour.
//
// PATH REDACTION: `filename=true` puts the ABSOLUTE path of each file into the result, and two
// presets select it. The fixture root is replaced by the token `<FIXTURES>` here and rewritten by
// the test — without it the oracle would embed a home path and `check-identities` would (correctly)
// refuse the commit the moment the file is staged.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TREE = path.join(HERE, 'transcriptsql')
const NOW = Date.now()

const { runTranscriptSql } = await import(path.join(HERE, '../../../../../out/test/transcriptSql.js'))

// hours BEFORE now that each file is stamped at. `old` sits outside the default 24h window and is
// the only reason `filesTotal` and `filesQueried` ever differ.
const OFFSETS = {
  'projA/aaaaaaaa.jsonl': 1,
  'projA/subagents/agent-bbbbbbbb.jsonl': 2,
  'projA/torn.jsonl': 3,
  'projB/cccccccc.jsonl': 100,
}

const rec = (o) => JSON.stringify(o)
const asst = (session, model, ts, usage) => rec({
  type: 'assistant', sessionId: session, timestamp: ts,
  message: { model, usage },
})
const u = (input, output, cc, cr) => ({
  input_tokens: input, output_tokens: output,
  cache_creation_input_tokens: cc, cache_read_input_tokens: cr,
})

const FILES = {
  'projA/aaaaaaaa.jsonl': [
    // The per-type COUNTS are deliberately all DIFFERENT (assistant 4, user 3, summary 2, the torn
    // NULL 1). `record_type_histogram` orders by count, and ORDER BY ties are unspecified in SQL —
    // the two DuckDB builds resolved a three-way tie differently, which is a property of neither
    // engine's correctness. A fixture with ties asserts something no engine promises.
    rec({ type: 'user', sessionId: 'aaaaaaaa', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user' } }),
    rec({ type: 'user', sessionId: 'aaaaaaaa', timestamp: '2026-01-01T00:00:04.000Z', message: { role: 'user' } }),
    rec({ type: 'user', sessionId: 'aaaaaaaa', timestamp: '2026-01-01T00:00:05.000Z', message: { role: 'user' } }),
    asst('aaaaaaaa', 'claude-opus-5', '2026-01-01T00:00:01.000Z', u(10, 200, 5000, 100)),
    asst('aaaaaaaa', 'claude-opus-5', '2026-01-01T00:00:02.000Z', u(20, 300, 9000, 400)),
    // A record shape with NO `message` at all: union_by_name keeps it, and every preset that
    // touches message.usage must filter type='assistant' FIRST or bind against a NULL struct.
    rec({ type: 'summary', timestamp: '2026-01-01T00:00:03.000Z' }),
    rec({ type: 'summary', timestamp: '2026-01-01T00:00:06.000Z' }),
  ],
  'projA/subagents/agent-bbbbbbbb.jsonl': [
    // One level deeper than the project dir — pins the RECURSIVE walk. A non-recursive listing finds
    // three files instead of four and silently under-reports every count.
    asst('bbbbbbbb', 'claude-sonnet-5', '2026-01-01T00:01:00.000Z', u(7, 70, 700, 7000)),
  ],
  'projA/torn.jsonl': [
    asst('torn', 'claude-opus-5', '2026-01-01T00:02:00.000Z', u(1, 2, 3, 4)),
    // Deliberately unparseable. Under ignore_errors it lands as an all-NULL row rather than being
    // dropped, so count(*) alone would never notice it — the torn-line probe compares against
    // count(type) precisely because of this line.
    '{"type":"assistant","message":{"usage":{',
  ],
  'projB/cccccccc.jsonl': [
    asst('cccccccc', 'claude-opus-5', '2026-01-01T00:03:00.000Z', u(999, 999, 999999, 999)),
  ],
}

for (const [rel, lines] of Object.entries(FILES)) {
  const p = path.join(TREE, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, lines.join('\n') + '\n')
  const t = (NOW - OFFSETS[rel] * 3_600_000) / 1000
  fs.utimesSync(p, t, t)
}

const DIRS = [path.join(TREE, 'projA'), path.join(TREE, 'projB')]
const redact = (v) => JSON.parse(JSON.stringify(v).split(TREE).join('<FIXTURES>'))

const cases = {}
const run = async (name, opts) => {
  cases[name] = { opts, result: redact(await runTranscriptSql({ ...opts, projectsDirs: DIRS })) }
}

await run('list', {})
await run('both_given', { preset: 'record_type_histogram', sql: 'SELECT 1' })
await run('unknown_preset', { preset: 'nope' })
for (const p of ['record_type_histogram', 'usage_by_model', 'cache_heavy_turns', 'sessions_by_output']) {
  await run(`preset_${p}`, { preset: p })
}
await run('raw_sql', { sql: "SELECT type, count(*) AS n FROM transcripts GROUP BY type ORDER BY type" })
// The statement gate, three ways it must fail CLOSED.
await run('gate_ddl', { sql: 'DROP TABLE transcripts' })
await run('gate_two_statements', { sql: 'SELECT 1; SELECT 2' })
await run('gate_trailing_semicolon_ok', { sql: 'SELECT 42 AS answer;' })
await run('gate_comment_hidden_ddl', { sql: 'SELECT 1 /* x */ ; DROP TABLE transcripts' })
// limit+1 probing: the cap must be REPORTED in the note, not silently applied.
await run('limit_capped', { preset: 'record_type_histogram', limit: 1 })
await run('session_fast_path', { sessionId: 'cccccccc', preset: 'record_type_histogram' })
await run('session_missing', { sessionId: 'nosuchsession', preset: 'record_type_histogram' })
// A window that admits nothing — the error names the window rather than returning an empty table,
// because "no rows" and "no files" are different answers.
await run('window_empty', { windowHours: 0.001, preset: 'record_type_histogram' })
// Wide enough to admit the old file too: filesQueried goes 3 -> 4.
await run('window_wide', { windowHours: 200, preset: 'record_type_histogram' })
// TYPE PROBE — what `getRowObjectsJson()` actually produces per DuckDB type. This exists because
// the answer is NOT what a reasonable port would assume: a BIGINT comes back as a JSON **string**,
// not a number, so an implementation that maps integers to JSON numbers is wrong on every count(*)
// in the preset library while looking perfectly sensible.
await run('type_probe', {
  sql: "SELECT 42 AS i32, 42::BIGINT AS i64, 1.5 AS dec21, 1.5::FLOAT AS flt, 1.5::DOUBLE AS dbl, "
    + "(-12.340)::DECIMAL(8,3) AS dec83, 0.1::DOUBLE + 0.2::DOUBLE AS dbl_ulp, true AS b, NULL AS n, "
    + "'x' AS s, [1,2] AS lst, {'a': 1} AS strct, 42::HUGEINT AS huge, TIMESTAMP '2026-01-01 00:00:00' AS ts, "
    + "TIMESTAMP '2026-01-01 00:00:00.25' AS ts_frac, DATE '2026-01-02' AS dt",
})
// A column that exists in no record: the binder error surfaces honestly instead of an empty result.
await run('binder_error', { sql: 'SELECT nosuchcolumn FROM transcripts' })

const out = { now: NOW, offsets: OFFSETS, cases }
fs.writeFileSync(path.join(HERE, 'transcriptsql-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote transcriptsql-expected.json')
for (const [k, v] of Object.entries(cases)) {
  const r = v.result
  console.log(` ${k}: mode=${r.mode} rows=${r.rowCount ?? '-'} files=${r.coverage.filesQueried}/${r.coverage.filesTotal} err=${r.error ? JSON.stringify(r.error.slice(0, 48)) : '-'}`)
}
