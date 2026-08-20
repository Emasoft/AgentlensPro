// Regenerates sbprofile-expected.json — and the `sbprofile-bodies/` fixture it reads — from the
// COMPILED src/sessionBurnProfile.ts. The parity oracle for get_session_burn_profile
// (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-sbprofile-expected.mjs
//
// THE BODIES ARE GENERATED HERE, not hand-written: every number in the profile is a function of
// the mtime SPACING and the usage chain, so the fixture and the table that gives it meaning must
// have one source.
//
// MTIME ORACLE: git does not preserve mtimes and the gap histogram is entirely a function of them —
// the table is stamped here and PUBLISHED; the Rust test re-stamps from it.
//
// What the fixture pins, and which file carries it:
//  - All five gap buckets fire (600s, 120s, 45s, 20s, 5s, and a second >5m).
//  - THE CHAIN IS OFF BY ONE BY DESIGN: turn i's usage lives on the response whose id equals turn
//    i+1's previous_message_id, so the LAST request is unusable by construction, not by omission —
//    7 requests, 6 usable.
//  - r4's conversation text MENTIONS a different session id. The profile must still be session A's:
//    the id comes from metadata.user_id searched from the END, never from message content. A naive
//    /"session_id":"…"/ over the raw body returned byte-identical profiles for two different
//    queries — this file is the regression.
//  - tools[] changes on 4 of 6 comparisons and each change has a DIFFERENT shape: an MCP tool
//    added, the same one removed, a pure REORDER of an identical set (which still invalidates the
//    prefix, so it must count), and a built-in added.
//  - The median cache_create (14,000) is BELOW the 20k floor while the p90 (150,000) is far above:
//    the session is stable-and-appending with the total concentrated in a few break events, which
//    is the diagnosis the median exists to separate from a per-turn rewrite.
//  - createWeighted (1.25x) beats readWeighted (0.1x) even though raw reads outnumber writes 3.5:1
//    — the weighted comparison is the only honest way to name the dominant term.
//  - Two calls read ZERO cache while writing a large prefix ⇒ coldCalls, but 33% < the 50% floor,
//    so the cold-loop remediation stays silent.
//  - The newest request is the ONLY body fully parsed: a deferred built-in gets its own bySource
//    bucket ('built-in (deferred)'), which `sourceOf` in the stability diff deliberately does not.
//  - Session B is excluded by id; an out-of-window file is not even counted in filesScanned; a
//    non-.json file is skipped entirely.
import { createRequire } from 'module'
import { writeFileSync, mkdirSync, utimesSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
const bodies = dir + 'sbprofile-bodies'
mkdirSync(bodies, { recursive: true })

const { buildSessionBurnProfile, extractToolNames, sessionIdOf } =
  require('../../../../../out/test/sessionBurnProfile.js')

const NOW = Date.parse('2026-08-18T12:00:00.000Z')
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate

const M = 60_000
const SESS_A = 'aaaaaaaa-1111-1111-1111-111111111111'
const SESS_B = 'bbbb2222-3333-3333-3333-333333333333'
const OTHER = 'cccc3333-4444-4444-4444-444444444444'

const tool = (name, description, schema, defer) => ({
  name, description, input_schema: schema, ...(defer ? { defer_loading: true } : {}),
})
const BASH = tool('Bash', 'Run a shell command', { type: 'object', properties: { command: { type: 'string' } } })
const READ = tool('Read', 'Read a file', { type: 'object', properties: { file_path: { type: 'string' } } })
const WRITE_DEFERRED = tool('Write', 'Write a file', { type: 'object', properties: { file_path: { type: 'string' } } }, true)
const MCP_ALPHA = tool('mcp__srv__alpha', 'Alpha op', { type: 'object' })
const MCP_BETA = tool('mcp__srv__beta', 'Beta op', { type: 'object' })

// `metadata` LAST, because sessionIdOf searches for "user_id" from the END of the raw text.
const req = (session, model, prev, tools, messages) => ({
  model,
  ...(prev ? { diagnostics: { previous_message_id: prev } } : {}),
  tools,
  messages,
  metadata: { user_id: JSON.stringify({ session_id: session, account_uuid: 'acct1111-2222-2222-2222-222222222222' }) },
})
const msg = (role, text) => ({ role, content: [{ type: 'text', text }] })
const useMsg = (names) => ({ role: 'assistant', content: names.map((n, i) => ({ type: 'tool_use', id: `tu${i}`, name: n, input: {} })) })
const resp = (id, read, create) => ({
  id, type: 'message', model: 'claude-opus-5',
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: read, cache_creation_input_tokens: create },
})

const T = (mins, secs = 0) => NOW - mins * M + secs * 1000
// gaps, in order: 600s (>5m) · 120s (1-5m) · 45s (30-60s) · 20s (10-30s) · 5s (<10s) · 3350s (>5m)
const TS = [T(70), T(60), T(58), T(58, 45), T(58, 65), T(58, 70), T(1)]

const FILES = {}
const add = (name, body, ms) => { FILES[name] = [body, ms] }

const STABLE = [BASH, READ, MCP_ALPHA]
add('r1.request.json', req(SESS_A, 'claude-opus-5', null, STABLE, [msg('user', 'start the audit')]), TS[0])
add('r2.request.json', req(SESS_A, 'claude-opus-5', 'msg_1', STABLE, [msg('user', 'keep going')]), TS[1])
// +MCP_BETA ⇒ an MCP tool ADDED.
add('r3.request.json', req(SESS_A, 'claude-opus-5', 'msg_2', [BASH, READ, MCP_ALPHA, MCP_BETA], [msg('user', 'and again')]), TS[2])
// −MCP_BETA ⇒ the same MCP tool REMOVED. This body also MENTIONS another session id in its
// conversation text — the profile must ignore it and read metadata.user_id.
add('r4.request.json', req(SESS_A, 'claude-opus-5', 'msg_3', STABLE, [
  msg('user', `investigating the burn on "session_id":"${OTHER}" reported by another agent`),
]), TS[3])
// Same SET, different ORDER ⇒ still a prefix invalidation, so it must count as a change.
add('r5.request.json', req(SESS_A, 'claude-opus-5', 'msg_4', [READ, BASH, MCP_ALPHA], [msg('user', 'reordered')]), TS[4])
add('r6.request.json', req(SESS_A, 'claude-opus-5', 'msg_5', [READ, BASH, MCP_ALPHA], [msg('user', 'unchanged')]), TS[5])
// The NEWEST — the only body fully parsed. A deferred built-in earns its own bySource bucket.
add('r7.request.json', req(SESS_A, 'claude-opus-5', 'msg_6', [BASH, READ, MCP_ALPHA, WRITE_DEFERRED], [
  msg('user', 'wrap up'),
  useMsg(['Bash', 'Read', 'Bash', 'mcp__srv__alpha', 'Bash', 'Read']),
  msg('assistant', 'done'),
]), TS[6])

// Turn i's usage is on the response whose id == turn i+1's previous_message_id.
add('m1.response.json', resp('msg_1', 0, 150000), TS[0])       // COLD: read 0, big write
add('m2.response.json', resp('msg_2', 200000, 3000), TS[1])
add('m3.response.json', resp('msg_3', 210000, 2500), TS[2])
add('m4.response.json', resp('msg_4', 220000, 25000), TS[3])   // large (>20k)
add('m5.response.json', resp('msg_5', 230000, 1200), TS[4])
add('m6.response.json', resp('msg_6', 0, 60000), TS[5])        // COLD + large

// Another session entirely — excluded by id, not by timing.
add('b1.request.json', req(SESS_B, 'claude-opus-5', null, STABLE, [msg('user', 'other session')]), T(30))
// Outside a 6h window ⇒ not even counted in filesScanned.
add('old.request.json', req(SESS_A, 'claude-opus-5', null, STABLE, [msg('user', 'ancient')]), T(600))
// Wrong suffix ⇒ skipped before it is ever read.
FILES['notes.txt'] = ['not a body at all\n', T(5)]

const MTIMES = {}
for (const [name, [body, ms]] of Object.entries(FILES)) {
  writeFileSync(bodies + '/' + name, typeof body === 'string' ? body : JSON.stringify(body) + '\n')
  MTIMES[name] = ms
}
for (const [name, ms] of Object.entries(MTIMES)) utimesSync(bodies + '/' + name, ms / 1000, ms / 1000)

const MISSING = dir + 'no-such-sbprofile-dir'
const strip = (o) => JSON.parse(JSON.stringify(o).split(bodies).join('<BODIES>').split(MISSING).join('<MISSING>'))
const profile = async (o) => strip(await buildSessionBurnProfile({ bodiesDir: bodies, ...o }))

// The two exported primitives, in isolation.
const RAW_WITH_TOOLS = JSON.stringify({ tools: [{ name: 'A', description: 'has ] and [ inside' }, { name: 'B' }], x: 1 })
const RAW_NESTED = JSON.stringify({ tools: [{ name: 'A', input_schema: { items: [{ name: 'nested' }] } }] })

writeFileSync(dir + 'sbprofile-expected.json', JSON.stringify({
  nowMs: NOW,
  mtimes: MTIMES,
  sessions: { a: SESS_A, b: SESS_B, other: OTHER },

  extractToolNames: {
    // Brackets inside a STRING must not end the bracket match.
    withBracketsInString: extractToolNames(RAW_WITH_TOOLS),
    // A nested array inside a schema is matched to the OUTER close, so the nested name is included
    // — the extractor is a fingerprint, not a parser, and that is the fingerprint it takes.
    nested: extractToolNames(RAW_NESTED),
    noToolsKey: extractToolNames('{"messages":[]}'),
    emptyArray: extractToolNames('{"tools":[]}'),
    unterminated: extractToolNames('{"tools":[{"name":"A"}'),
  },
  sessionIdOf: {
    ok: sessionIdOf(JSON.stringify({ metadata: { user_id: JSON.stringify({ session_id: SESS_A }) } })),
    // The regression: a session id in CONVERSATION TEXT must not win over metadata.user_id.
    textMention: sessionIdOf(JSON.stringify({
      messages: [{ content: `see "session_id":"${OTHER}"` }],
      metadata: { user_id: JSON.stringify({ session_id: SESS_A }) },
    })),
    noUserId: sessionIdOf(JSON.stringify({ messages: [] })),
    // Fail-CLOSED on an unparseable blob: null, never a guess.
    badBlob: sessionIdOf(JSON.stringify({ metadata: { user_id: 'not-json' } })),
    noSessionField: sessionIdOf(JSON.stringify({ metadata: { user_id: JSON.stringify({ account_uuid: 'x' }) } })),
  },

  profileDefault: await profile({ sessionId: SESS_A }),
  // A short unique PREFIX resolves the same session.
  profileByPrefix: await profile({ sessionId: 'aaaaaaaa' }),
  // The other session is a different profile, not a filtered view of the same one.
  profileSessionB: await profile({ sessionId: SESS_B }),
  // A narrow window drops the older turns AND the files they would have been scanned from.
  profileNarrowWindow: await profile({ sessionId: SESS_A, windowHours: 0.5 }),
  // No such session: the empty profile, with dirExists TRUE (the dir was there, the session wasn't).
  profileUnknownSession: await profile({ sessionId: 'no-such-session' }),
  // No such dir: the empty profile with dirExists FALSE and the env-var note.
  profileMissingDir: strip(await buildSessionBurnProfile({ bodiesDir: MISSING, sessionId: SESS_A })),
}, null, 2) + '\n')
console.log('wrote sbprofile-expected.json + sbprofile-bodies/')
