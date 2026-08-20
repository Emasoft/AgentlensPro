// Regenerates hbcost-expected.json — and the `hbcost-bodies/` fixture it reads — from the COMPILED
// src/heartbeatCost.ts. The parity oracle for get_heartbeat_cost (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-hbcost-expected.mjs
//
// MTIME ORACLE: the window filter, the fire ordering, the span and the duration are all functions
// of the mtime table, and git does not preserve mtimes — it is stamped here and PUBLISHED; the
// Rust test re-stamps from it.
//
// What the fixture pins, and which file carries it:
//  - THE #1 TRAP: `raw.includes(marker)` is wrong. f1r2's transcript HISTORY contains the marker
//    (its first user message is the fire's own prompt) while its current turn is a tool_result, so
//    it must NOT read as a fire start. Measured on the real spool: 1412 bodies contained the
//    literal marker and ZERO were fires.
//  - THE #2 TRAP: the LAST message is not the user's. f1r1 ends with a `UserPromptSubmit hook
//    additional context` message and f2r1 with a `<system-reminder>` — both must be walked PAST to
//    the real user message, which does start with the marker. A naive last-message check finds no
//    fire at all.
//  - f1r3's last message is an ASSISTANT message, so the walk stops immediately: the current
//    turn's user block has been left behind and no marker anywhere below it can count.
//  - Agent/Task spawns are counted in the LAST message ONLY: f1r1 carries an Agent tool_use in an
//    EARLIER message that must not be counted, f1r2 carries Agent + Task in its last.
//  - f1r3 has a DIFFERENT tool count (a sub-agent stream carries the parent session id), which is
//    the whole point of callsByToolSurface.
//  - WITHOUT a sessionId filter, another session's call that falls INSIDE the fire's index range
//    is counted as one of the fire's apiCalls AND reported under `concurrent`. That is the TS
//    behaviour and it is load-bearing: `candidates` is only session-filtered when asked. With the
//    filter it is concurrent-only, and the two runs differ by exactly that call.
//  - msg_b1 carries NO model, so the usage adopts the REQUEST's — and the adoption is a MUTATION
//    of the stored entry, visible to anything that joins the same response later.
//  - fire: 'current' takes the newest fire, whose final call has no successor and is therefore
//    UNSETTLED — excluded from the totals and disclosed under inFlight, never counted as zero.
//  - A 0.5h window sees only ONE fire, so 'last-complete' falls back to the newest with its
//    unsettled tail — the single-fire branch.
import { createRequire } from 'module'
import { writeFileSync, mkdirSync, utimesSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
const bodies = dir + 'hbcost-bodies'
mkdirSync(bodies, { recursive: true })

const { buildHeartbeatCost } = require('../../../../../out/test/heartbeatCost.js')

const NOW = Date.parse('2026-08-18T12:00:00.000Z')
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate

const MARKER = '[janitor-heartbeat]'
const SESS_A = 'aaaaaaaa-1111-1111-1111-111111111111'
const SESS_B = 'bbbb2222-3333-3333-3333-333333333333'
const S = (secs) => NOW - secs * 1000

const tools = (n) => Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, description: `d${i}`, input_schema: { type: 'object' } }))
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const userStr = (text) => ({ role: 'user', content: text })
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const toolResult = () => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] })
const spawns = (names) => ({ role: 'assistant', content: names.map((n, i) => ({ type: 'tool_use', id: `s${i}`, name: n, input: {} })) })

// `metadata` LAST — sessionIdOf searches for "user_id" from the END of the raw text.
const req = (session, model, prev, toolCount, messages) => ({
  model,
  ...(prev ? { diagnostics: { previous_message_id: prev } } : {}),
  tools: tools(toolCount),
  messages,
  metadata: { user_id: JSON.stringify({ session_id: session }) },
})
const resp = (id, model, u) => ({
  id, type: 'message', ...(model ? { model } : {}),
  usage: {
    input_tokens: u.input, output_tokens: u.output,
    cache_read_input_tokens: u.read, cache_creation_input_tokens: u.create,
    cache_creation: { ephemeral_5m_input_tokens: u.e5m, ephemeral_1h_input_tokens: u.e1h },
  },
})

const FILES = {}
const add = (name, body, ms) => { FILES[name] = [body, ms] }

// ── fire 1 (older, COMPLETE) ─────────────────────────────────────────────────
// The real user message carries the marker; a UserPromptSubmit hook message follows it and must be
// walked past. The Agent spawn here is in an EARLIER message and must NOT be counted.
add('f1r1.request.json', req(SESS_A, 'claude-opus-5', null, 5, [
  spawns(['Agent']),
  user(`${MARKER}\n/path/to/dispatcher-stub.py`),
  user('UserPromptSubmit hook additional context: repo is clean'),
]), S(2400))
// History CONTAINS the marker, current turn is a tool_result ⇒ NOT a fire start. Its last message
// carries the Agent + Task spawns that DO count.
add('f1r2.request.json', req(SESS_A, 'claude-sonnet-5', 'msg_a1', 5, [
  user(`${MARKER}\n/path/to/dispatcher-stub.py`),
  assistant('running the stub'),
  toolResult(),
  spawns(['Agent', 'Task']),
]), S(2340))
// ANOTHER session, inside fire 1's index range.
add('o1.request.json', req(SESS_B, 'claude-opus-5', 'msg_b1', 5, [user('unrelated work')]), S(2310))
// A sub-agent stream: parent session id, DIFFERENT tool count. Its last message is an ASSISTANT
// message, so the fire-start walk stops there regardless of the marker below it.
add('f1r3.request.json', req(SESS_A, 'claude-haiku-4-5', 'msg_a2', 2, [
  user(`${MARKER}\nsub-agent work`),
  assistant('sub-agent replying'),
]), S(2280))

// ── fire 2 (newest, its tail unsettled) ──────────────────────────────────────
// A <system-reminder> trails the real marker message and must be walked past.
add('f2r1.request.json', req(SESS_A, 'claude-opus-5', 'msg_a3', 5, [
  user(`${MARKER}\n/path/to/dispatcher-stub.py`),
  userStr('<system-reminder>injected context</system-reminder>'),
]), S(600))
add('f2r2.request.json', req(SESS_A, 'claude-opus-5', 'msg_a4', 5, [
  user(`${MARKER}\n/path/to/dispatcher-stub.py`),
  assistant('working'),
  toolResult(),
]), S(540))

// Responses. msg_b1 has NO model ⇒ the usage adopts the REQUEST's (claude-sonnet-5).
add('m_a1.response.json', resp('msg_a1', 'claude-opus-5', { input: 120, output: 800, read: 50000, create: 32000, e5m: 2000, e1h: 30000 }), S(2395))
add('m_b1.response.json', resp('msg_b1', null, { input: 10, output: 40, read: 1000, create: 9000, e5m: 9000, e1h: 0 }), S(2335))
add('m_a2.response.json', resp('msg_a2', 'claude-opus-5', { input: 5, output: 20, read: 300, create: 4000, e5m: 4000, e1h: 0 }), S(2305))
add('m_a3.response.json', resp('msg_a3', 'claude-haiku-4-5', { input: 7, output: 11, read: 900, create: 1500, e5m: 1500, e1h: 0 }), S(2275))
add('m_a4.response.json', resp('msg_a4', 'claude-opus-5', { input: 3, output: 9, read: 77000, create: 12000, e5m: 0, e1h: 12000 }), S(595))

// Outside a 3h window ⇒ not scanned at all.
add('old.request.json', req(SESS_A, 'claude-opus-5', null, 5, [user(`${MARKER}\nancient fire`)]), S(5 * 3600))
// Wrong suffix ⇒ skipped before it is ever read.
FILES['notes.txt'] = ['not a body\n', S(100)]

const MTIMES = {}
for (const [name, [body, ms]] of Object.entries(FILES)) {
  writeFileSync(bodies + '/' + name, typeof body === 'string' ? body : JSON.stringify(body) + '\n')
  MTIMES[name] = ms
}
for (const [name, ms] of Object.entries(MTIMES)) utimesSync(bodies + '/' + name, ms / 1000, ms / 1000)

const MISSING = dir + 'no-such-hbcost-dir'
const strip = (o) => JSON.parse(JSON.stringify(o).split(bodies).join('<BODIES>').split(MISSING).join('<MISSING>'))
const report = async (o = {}) => strip(await buildHeartbeatCost({ bodiesDir: bodies, ...o }))

writeFileSync(dir + 'hbcost-expected.json', JSON.stringify({
  nowMs: NOW,
  mtimes: MTIMES,
  marker: MARKER,
  sessions: { a: SESS_A, b: SESS_B },

  // The default: the LAST COMPLETE fire. Unfiltered, so session B's call inside the span counts
  // as one of the fire's apiCalls AND is reported under concurrent.
  reportDefault: await report({}),
  // Session-filtered: the same fire WITHOUT session B's call — the two runs differ by exactly it.
  reportBySession: await report({ sessionId: SESS_A }),
  // A short unique prefix resolves the same session.
  reportByPrefix: await report({ sessionId: 'aaaaaaaa' }),
  // The newest fire, whose final call has no successor ⇒ unsettled, disclosed under inFlight.
  reportCurrent: await report({ fire: 'current' }),
  reportCurrentBySession: await report({ fire: 'current', sessionId: SESS_A }),
  // A 0.5h window sees only ONE fire ⇒ 'last-complete' falls back to the newest with its tail.
  reportNarrowWindow: await report({ windowHours: 0.5 }),
  // No fire matches this marker: the empty report, with the scan note preserved.
  reportUnknownMarker: await report({ marker: '[no-such-marker]' }),
  // No such dir: the empty report with the env-var note.
  reportMissingDir: strip(await buildHeartbeatCost({ bodiesDir: MISSING })),
}, null, 2) + '\n')
console.log('wrote hbcost-expected.json + hbcost-bodies/')
