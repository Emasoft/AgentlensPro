// Regenerates cbreport-expected.json + the cbreport-* fixture tree from the COMPILED
// src/cacheBreakTimeline.ts — the parity oracle for SLICE 3 (TRDD-DMWOBWFH P4x.2k):
// buildCacheBreakTimeline, the bounded evidence scan, the sub-agent child resolver, and the
// compaction hook-evidence annotator. Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-cbreport-expected.mjs
//
// MTIME ORACLE: turn ORDER, the inter-turn GAP (which decides TTL_EXPIRY vs NORMAL_GROWTH) and the
// recency cap all come from spool file mtimes, and git does not preserve mtimes. So the generator
// STAMPS every fixture file and publishes the table as `mtimes`; the Rust test re-stamps from it
// before scanning. Without that the fixture is a different fixture on every clone.
//
// SPOOL-ONLY, and deliberately: `storeDir` points at a directory that does not exist, so the
// evidence union degenerates to the spool half. The store half already has its own end-to-end
// oracle (agentlens-store::bodies_evidence, tests/fixtures/evidence-store — a REAL Parquet store
// written by the TypeScript store), and reproducing one here would test DuckDB twice and this
// module's scan not at all.
//
// NO windowHours ANYWHERE, and that is a correctness constraint, not a gap: `tsFromMs` is
// `Date.now() - windowHours*3.6e6`, so a windowed fixture would pass on the day it was generated
// and silently start excluding every row once the stamped mtimes aged past the window. `windowHours`
// is still exercised — as the coverage field it echoes — via a case that passes it with no rows.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { buildCacheBreakTimeline } = await import(path.join(HERE, '../../../../../out/test/cacheBreakTimeline.js'))

const ROOT = path.join(HERE, 'cbreport')
fs.rmSync(ROOT, { recursive: true, force: true })
const SPOOL = path.join(ROOT, 'spool')
const HOOKS = path.join(ROOT, 'hooks')
const PROJECTS = path.join(ROOT, 'projects')
const EMPTY = path.join(ROOT, 'empty-spool')
const NOSTORE = path.join(ROOT, 'no-such-store')
for (const d of [SPOOL, HOOKS, PROJECTS, EMPTY]) fs.mkdirSync(d, { recursive: true })

const T0 = Date.parse('2026-08-20T10:00:00.000Z')
const mtimes = {}
const write = (rel, text, ms) => {
  const p = path.join(ROOT, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  const s = ms / 1000
  fs.utimesSync(p, s, s)
  mtimes[path.relative(HERE, p)] = ms
}

// ── body shapes ─────────────────────────────────────────────────────────────────
const tool = (name, desc = 'd') => ({ name, description: desc, input_schema: { type: 'object' } })
// `extra` appends N messages that carry NO cache_control, so `messages.length` (the lookback unit)
// grows while the cached message PREFIX stays byte-identical — the only shape in which
// LOOKBACK_OVERFLOW can be reached, since it requires an unchanged prefix.
const req = ({ session, prev, model = 'claude-opus-5', tools = [], sys = ['system prose'], msgs = ['hello'], extra = 0 }) => ({
  model,
  tools,
  system: sys.map((t, i) => ({ type: 'text', text: t, ...(i === sys.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) })),
  messages: [
    {
      role: 'user',
      content: msgs.map((t, i) => ({ type: 'text', text: t, ...(i === msgs.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) })),
    },
    ...Array.from({ length: extra }, (_, k) => ({ role: k % 2 === 0 ? 'assistant' : 'user', content: [{ type: 'text', text: `tail ${k}` }] })),
  ],
  metadata: { user_id: JSON.stringify({ session_id: session, account_uuid: 'acct-1', device_id: 'dev-1' }) },
  ...(prev ? { diagnostics: { previous_message_id: prev } } : {}),
})
const resp = ({ id, cacheCreate, cacheRead = 1000, model = 'claude-opus-5' }) => ({
  id,
  model,
  usage: {
    input_tokens: 12,
    output_tokens: 340,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheCreate },
  },
})

// A turn is (request at t, response whose id the NEXT request cites). The cache_creation billed on
// turn i is read from turn i's RESPONSE — so the LAST turn of a stream is always unclassifiable.
const MIN = 100

// ── session S1: five turns, three of them the SAME tool churn (a SYSTEMATIC offender) ──
// t1 cold start; t2/t3/t4 each add a tool (same culpritId shape, different tool names -> three
// DIFFERENT culpritIds) — so t2..t4 exercise the histogram while the repeat-offender rollup needs
// one element repeating, which the model switch at t5 does not give. `bumped` repeats ONE culprit.
const S1 = 'sess-alpha'
const s1 = [
  { r: req({ session: S1, tools: [tool('Bash')] }), respId: 'msg_a1', cc: 40000 },
  { r: req({ session: S1, prev: 'msg_a1', tools: [tool('Bash'), tool('Grep')] }), respId: 'msg_a2', cc: 30000 },
  // Same tool set as t2 but a changed DESCRIPTION — TOOLSET_CHANGED on the SAME culpritId (Bash),
  // twice, which is what makes a repeat offender.
  { r: req({ session: S1, prev: 'msg_a2', tools: [tool('Bash', 'v2'), tool('Grep')] }), respId: 'msg_a3', cc: 20000 },
  { r: req({ session: S1, prev: 'msg_a3', tools: [tool('Bash', 'v3'), tool('Grep')] }), respId: 'msg_a4', cc: 25000 },
  { r: req({ session: S1, prev: 'msg_a4', tools: [tool('Bash', 'v4'), tool('Grep')] }), respId: 'msg_a5', cc: 15000 },
]
s1.forEach((t, i) => {
  write(`spool/s1-${i}.request.json`, JSON.stringify(t.r), T0 + i * 60_000)
  write(`spool/s1-${i}.response.json`, JSON.stringify(resp({ id: t.respId, cacheCreate: t.cc })), T0 + i * 60_000 + 500)
})

// ── session S2: lighter, so the heaviest-session resolver must NOT pick it; also the scope case ──
const S2 = 'other-beta'
const s2 = [
  { r: req({ session: S2 }), respId: 'msg_b1', cc: 900 },
  { r: req({ session: S2, prev: 'msg_b1', msgs: ['hello', 'more'] }), respId: 'msg_b2', cc: 800 },
]
s2.forEach((t, i) => {
  write(`spool/s2-${i}.request.json`, JSON.stringify(t.r), T0 + 600_000 + i * 60_000)
  write(`spool/s2-${i}.response.json`, JSON.stringify(resp({ id: t.respId, cacheCreate: t.cc })), T0 + 600_000 + i * 60_000 + 500)
})

// ── session S3: a compaction + an unlocalised break, both inside a hook-attested window ──
// t1 -> t2 rewrites msg[0] into a compaction summary (COMPACTION, text-shape). t2 -> t3 changes
// nothing at all in the prefix, so it lands UNCLASSIFIED — and its ts sits inside the PreCompact/
// PostCompact window, which is the ONLY thing that may upgrade it.
const S3 = 'sess-gamma'
const T3 = Date.parse('2026-08-20T12:00:00.000Z')
const s3 = [
  { r: req({ session: S3, msgs: ['conversation opening'] }), respId: 'msg_c1', cc: 50000 },
  { r: req({ session: S3, prev: 'msg_c1', msgs: ['This session is being continued from a previous conversation.'] }), respId: 'msg_c2', cc: 60000 },
  { r: req({ session: S3, prev: 'msg_c2', msgs: ['This session is being continued from a previous conversation.'] }), respId: 'msg_c3', cc: 70000 },
  { r: req({ session: S3, prev: 'msg_c3', msgs: ['This session is being continued from a previous conversation.'] }), respId: 'msg_c4', cc: 5000 },
]
s3.forEach((t, i) => {
  write(`spool/s3-${i}.request.json`, JSON.stringify(t.r), T3 + i * 30_000)
  write(`spool/s3-${i}.response.json`, JSON.stringify(resp({ id: t.respId, cacheCreate: t.cc })), T3 + i * 30_000 + 500)
})
// PreCompact 20s before t2, PostCompact 20s after t3 — so t2 AND t3 are inside the window.
write(
  'hooks/2026-08-20.ndjsonl',
  [
    { ts: T3 + 10_000, ev: 'PreCompact', session: S3, payload: {} },
    { ts: T3 + 80_000, ev: 'PostCompact', session: S3, payload: {} },
    // A hook event with no session must be DROPPED — corroboration may never guess whose it was.
    { ts: T3 + 10_000, ev: 'PreCompact', session: null, payload: {} },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n',
  T3,
)

// ── a sub-agent child: its calls carry the PARENT's session id ──────────────────
// The child's transcript lives at <projects>/<mangled>/<parentSessionId>/subagents/agent-kid.jsonl
// and its assistant message ids ARE the child's API response ids. Turn ch2 cites msg_k1, so the
// chain identifies it; ch1 is the stream HEAD, recovered by its msg[0] fingerprint.
const KID_HEAD = 'child task prompt — audit the thing'
const PARENT = 'sess-parent'
const kid = [
  { r: req({ session: PARENT, msgs: [KID_HEAD] }), respId: 'msg_k1', cc: 45000 },
  { r: req({ session: PARENT, prev: 'msg_k1', msgs: [KID_HEAD, 'second child turn'] }), respId: 'msg_k2', cc: 35000 },
  { r: req({ session: PARENT, prev: 'msg_k2', msgs: [KID_HEAD, 'second child turn', 'third'] }), respId: 'msg_k3', cc: 25000 },
]
const TK = Date.parse('2026-08-20T14:00:00.000Z')
kid.forEach((t, i) => {
  write(`spool/kid-${i}.request.json`, JSON.stringify(t.r), TK + i * 60_000)
  write(`spool/kid-${i}.response.json`, JSON.stringify(resp({ id: t.respId, cacheCreate: t.cc })), TK + i * 60_000 + 500)
})
write(
  `projects/-w-proj/${PARENT}/subagents/agent-kid.jsonl`,
  [
    { type: 'assistant', message: { id: 'msg_k1' } },
    { type: 'assistant', message: { id: 'msg_k2' } },
    { type: 'user', message: { id: 'msg_ignored' } },
    'not json at all',
  ]
    .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
    .join('\n') + '\n',
  TK,
)

// ── session S4: the LOOKBACK bookkeeping, which only ONE shape can observe ───────
// `lastWriteMessageCount` must be updated for EVERY turn that carried usage — INCLUDING the ones
// the minTokens floor drops — or the lookback distance is measured from the last *reported* write
// instead of the last real one. Nothing else in this fixture can see that: the counter is only ever
// read by LOOKBACK_OVERFLOW, which needs cache_read 0 AND an unchanged prefix AND >= 20 blocks
// appended since the last write, and every other response here reads 1000.
//
// t1 writes 50k (classified). t2 writes 50 — BELOW the floor, so it is dropped from the report but
// is still a real write. t3 reads NOTHING with an unchanged prefix. Measuring from t2 (correct)
// gives a 4-message distance and a plain cold read; measuring from t1 (the bug) gives 29 and
// manufactures a LOOKBACK_OVERFLOW. The two verdicts are different words, so the case cannot pass
// by accident.
const S4 = 'sess-delta'
const T4 = Date.parse('2026-08-20T16:00:00.000Z')
const s4 = [
  { r: req({ session: S4, msgs: ['root'] }), respId: 'msg_d1', cc: 50000, read: 1000 },
  { r: req({ session: S4, prev: 'msg_d1', msgs: ['root'], extra: 25 }), respId: 'msg_d2', cc: 50, read: 1000 },
  { r: req({ session: S4, prev: 'msg_d2', msgs: ['root'], extra: 29 }), respId: 'msg_d3', cc: 500000, read: 0 },
  { r: req({ session: S4, prev: 'msg_d3', msgs: ['root'], extra: 29 }), respId: 'msg_d4', cc: 1000, read: 1000 },
]
s4.forEach((t, i) => {
  write(`spool/s4-${i}.request.json`, JSON.stringify(t.r), T4 + i * 60_000)
  write(`spool/s4-${i}.response.json`, JSON.stringify(resp({ id: t.respId, cacheCreate: t.cc, cacheRead: t.read })), T4 + i * 60_000 + 500)
})

// ── run the cases ───────────────────────────────────────────────────────────────
const base = { bodiesDir: SPOOL, storeDir: NOSTORE, hookEventsDir: HOOKS, minTokens: MIN }
const cases = {
  // No sessionId: the heaviest session by cache_creation wins (S1 at 130k, not S2 at 1.7k).
  heaviest: await buildCacheBreakTimeline({ ...base }),
  // scope narrows the candidate set to the lighter one.
  scoped: await buildCacheBreakTimeline({ ...base, scope: 'other-' }),
  explicit_session: await buildCacheBreakTimeline({ ...base, sessionId: S1 }),
  // topN truncates `events` and adds eventsNote; the histogram/offenders stay over the FULL set.
  topn2: await buildCacheBreakTimeline({ ...base, sessionId: S1, topN: 2 }),
  // topN clamps to >= 1 and <= 100.
  topn_clamped_low: await buildCacheBreakTimeline({ ...base, sessionId: S1, topN: 0 }),
  // The minTokens floor drops small breaks — but never a no-cache-activity diagnosis.
  high_floor: await buildCacheBreakTimeline({ ...base, sessionId: S1, minTokens: 26000 }),
  lookback_bookkeeping: await buildCacheBreakTimeline({ ...base, sessionId: S4 }),
  hooks_evidence: await buildCacheBreakTimeline({ ...base, sessionId: S3 }),
  // Same session with the hook store pointed at nothing: every COMPACTION falls back to 'inferred'
  // and the UNCLASSIFIED is NOT upgraded. The pair is what proves the hook half does the work.
  hooks_absent: await buildCacheBreakTimeline({ ...base, hookEventsDir: path.join(ROOT, 'no-hooks'), sessionId: S3 }),
  subagent: await buildCacheBreakTimeline({ ...base, sessionId: 'agent-kid', projectsDirs: [PROJECTS] }),
  subagent_missing: await buildCacheBreakTimeline({ ...base, sessionId: 'agent-nope', projectsDirs: [PROJECTS] }),
  // A plain unknown session id is NOT the agent path: no note is appended.
  unknown_session: await buildCacheBreakTimeline({ ...base, sessionId: 'sess-nope' }),
  // Neither spool nor store exists -> the "no evidence" base report.
  no_evidence: await buildCacheBreakTimeline({ ...base, bodiesDir: path.join(ROOT, 'no-such-spool') }),
  // An EMPTY spool dir exists: the scan runs and finds nothing (a different note from the above).
  empty_spool: await buildCacheBreakTimeline({ ...base, bodiesDir: EMPTY }),
  // windowHours is echoed into coverage. Passed on the EMPTY spool so the result cannot depend on
  // how long ago the fixture was generated (see the header note).
  window_echo: await buildCacheBreakTimeline({ ...base, bodiesDir: EMPTY, windowHours: 24 }),
}

// The absolute fixture paths differ per machine and per clone; the test rewrites its own before
// comparing, so publish the token to replace rather than the path.
const out = { root: ROOT, spool: SPOOL, mtimes, cases }
fs.writeFileSync(path.join(HERE, 'cbreport-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote cbreport-expected.json —', Object.keys(cases).length, 'cases,', Object.keys(mtimes).length, 'stamped files')
for (const [k, v] of Object.entries(cases)) {
  console.log(` ${k}: sid=${v.sessionId ?? '-'} turns=${v.turnsInSession} classified=${v.turnsClassified} causes=${v.causeHistogram.map((h) => h.cause + ':' + h.events).join(',') || '-'} offenders=${v.repeatOffenders.length}`)
}
