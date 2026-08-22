// Regenerates logeventsink-expected.json from the COMPILED TS buildDroppedLogEventRecord (the
// parity oracle for build_dropped_log_event_record). 18 cases from
// ./c2b-log-event-sink-case-matrix.md — same ids, same order, in all three authors (this
// generator, the Rust builder, and logeventsink_parity.rs). ts is ALWAYS explicit — no Date.now().
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-logeventsink-expected.mjs
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { buildDroppedLogEventRecord } = require('../../../../../out/test/logEventSink.js')
const dir = new URL('.', import.meta.url).pathname

const S = (v) => ({ stringValue: v })
const I = (v) => ({ intValue: v })
const D = (v) => ({ doubleValue: v })
const B = (v) => ({ boolValue: v })
const attr = (key, value) => ({ key, value })

const cases = [
  {
    id: 'full',
    name: 'claude_code.user_prompt',
    bare: 'user_prompt',
    attrs: [
      attr('session.id', S('sess-1')),
      attr('count', I('9007199254740993')),
      attr('ratio', D(0.5)),
      attr('ok', B(true)),
    ],
    rec: {
      traceId: 'trace-1',
      spanId: 'span-1',
      timeUnixNano: '1700000000123456789',
      severityText: 'INFO',
      body: { stringValue: 'hello world' },
    },
    ts: 1700000000000,
  },
  {
    id: 'session-fallback',
    name: 'claude_code.tool_decision',
    bare: 'tool_decision',
    attrs: [attr('session_id', S('sess-2'))],
    rec: {},
    ts: 1700000000000,
  },
  {
    id: 'no-session',
    name: 'claude_code.tool_decision',
    bare: 'tool_decision',
    attrs: [attr('other', S('x'))],
    rec: {},
    ts: 1700000000000,
  },
  {
    id: 'session-empty',
    name: 'claude_code.tool_decision',
    bare: 'tool_decision',
    attrs: [attr('session.id', S(''))],
    rec: {},
    ts: 1700000000000,
  },
  {
    id: 'tun-number',
    name: 'claude_code.plugin_loaded',
    bare: 'plugin_loaded',
    attrs: [],
    // Above 2^53 ON PURPOSE — do NOT "fix" the editor's precision warning by shrinking it. A real
    // ns-since-epoch IS ~1.7e18, so this is the value the branch actually sees, and the TS reads
    // it through the same lossy double a JSON parse would produce. JSON.stringify then writes the
    // rounded double into the fixture, so Rust's `as_f64()` reads the identical double and the two
    // engines agree. Shrinking it below 2^53 would silence the warning and stop exercising the
    // path.
    rec: { timeUnixNano: 1700000000123456789 },
    ts: 1700000000000,
  },
  {
    id: 'tun-nonnumeric',
    name: 'claude_code.plugin_loaded',
    bare: 'plugin_loaded',
    attrs: [],
    rec: { timeUnixNano: '12x' },
    ts: 1700000000000,
  },
  {
    id: 'tun-zero',
    name: 'claude_code.plugin_loaded',
    bare: 'plugin_loaded',
    attrs: [],
    rec: { timeUnixNano: 0 },
    ts: 1700000000000,
  },
  {
    id: 'tun-absent',
    name: 'claude_code.plugin_loaded',
    bare: 'plugin_loaded',
    attrs: [],
    rec: {},
    ts: 1700000000000,
  },
  {
    id: 'ids-empty',
    name: 'claude_code.hook_registered',
    bare: 'hook_registered',
    attrs: [],
    rec: { traceId: '', spanId: '', severityText: '' },
    ts: 1700000000000,
  },
  {
    id: 'body-kvlist',
    name: 'claude_code.mcp_server_connection',
    bare: 'mcp_server_connection',
    attrs: [],
    rec: { body: { kvlistValue: { values: [attr('k', S('v'))] } } },
    ts: 1700000000000,
  },
  {
    id: 'body-plain-string',
    name: 'claude_code.mcp_server_connection',
    bare: 'mcp_server_connection',
    attrs: [],
    rec: { body: 'hello' },
    ts: 1700000000000,
  },
  {
    id: 'attr-array-kvlist-bytes',
    name: 'claude_code.skill_activated',
    bare: 'skill_activated',
    attrs: [
      attr('arr', { arrayValue: { values: [S('a'), S('b')] } }),
      attr('kv', { kvlistValue: { values: [attr('inner', S('x'))] } }),
      attr('by', { bytesValue: 'ZGVhZGJlZWY=' }),
    ],
    rec: {},
    ts: 1700000000000,
  },
  {
    id: 'attr-unknown-wrapper',
    name: 'claude_code.skill_activated',
    bare: 'skill_activated',
    attrs: [attr('weird', { weirdValue: 1 })],
    rec: {},
    ts: 1700000000000,
  },
  {
    id: 'attr-multi-wrapper',
    name: 'claude_code.skill_activated',
    bare: 'skill_activated',
    attrs: [attr('multi', { intValue: '5', stringValue: 'five' })],
    rec: {},
    ts: 1700000000000,
  },
  {
    id: 'attr-bad-shape',
    name: 'claude_code.subagent_completed',
    bare: 'subagent_completed',
    attrs: [
      { value: S('no-key') },
      attr('nullval', null),
      attr('numval', 5),
    ],
    rec: {},
    ts: 1700000000000,
  },
  {
    id: 'attr-duplicate-key',
    name: 'claude_code.subagent_completed',
    bare: 'subagent_completed',
    attrs: [attr('dup', S('first')), attr('dup', S('second'))],
    rec: {},
    ts: 1700000000000,
  },
  {
    id: 'attrs-empty',
    name: 'claude_code.subagent_completed',
    bare: 'subagent_completed',
    attrs: [],
    rec: {},
    ts: 1700000000000,
  },
  {
    id: 'attr-order',
    name: 'claude_code.subagent_completed',
    bare: 'subagent_completed',
    attrs: [attr('zeta', S('z')), attr('alpha', S('a')), attr('mid', S('m'))],
    rec: {},
    ts: 1700000000000,
  },
  {
    // The asymmetry the other cases hide: an empty traceId/spanId/severity/session is ABSENT
    // (falsy), but an empty BODY is PRESENT — the guard there is `typeof bodyStr === 'string'`,
    // not truthiness. A port that reuses one "non-empty string" helper for all of them passes
    // every case above and still drops `body: ""`.
    id: 'body-empty-string',
    name: 'claude_code.assistant_response',
    bare: 'assistant_response',
    attrs: [],
    rec: { body: { stringValue: '' } },
    ts: 1700000000000,
  },
]

const J = (v) => JSON.parse(JSON.stringify(v))
const out = cases.map((c) => ({
  id: c.id,
  name: c.name,
  bare: c.bare,
  attrs: J(c.attrs),
  rec: J(c.rec),
  ts: c.ts,
  expected: J(buildDroppedLogEventRecord(c.name, c.bare, c.attrs, c.rec, c.ts)),
}))

writeFileSync(join(dir, 'logeventsink-expected.json'), JSON.stringify({ cases: out }, null, 1))
console.log(`logeventsink-expected.json: ${out.length} cases: ${JSON.stringify(out.map((c) => c.id))}`)
