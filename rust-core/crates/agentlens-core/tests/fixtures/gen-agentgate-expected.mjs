// Regenerates agentgate-expected.json from the COMPILED TS agentGate module (the parity
// oracle for burn/agent_gate.rs). ONE case list drives BOTH engines: each case's inputs are
// plain JSON (the gate state is a JSON object in both engines by design), the TS evaluators
// produce `expected`, and the Rust test replays the same cases and deep-equals.
// Transcript fixtures get PINNED mtimes (git checkout clobbers mtimes, so the Rust test
// re-pins them from the recorded values before reading).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-agentgate-expected.mjs
import { createRequire } from 'module'
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const {
  evaluateAgentGate, evaluateSendMessageGate, evaluateImageReadGate, buildAdvisory,
  readTranscriptContext, resolveMessageTargetLiveness, isKeepWarmPinger,
} = require('../../../../../out/test/agentGate.js')
const { classifyTtlRegime } = require('../../../../../out/test/shared/cacheTtl.js')
const dir = new URL('.', import.meta.url).pathname
const root = join(dir, 'agentgate-tree')

const NOW = 1787000000000
const J = (v) => JSON.parse(JSON.stringify(v ?? null))

// ── Transcript fixtures (committed; mtimes pinned, re-pinned by the Rust test) ─────────────
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const transcripts = {}
const writeT = (name, text, mtimeMs) => {
  const p = join(root, name)
  writeFileSync(p, text)
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
  transcripts[name] = { mtimeMs }
}
// Walk-back gauntlet: trailing empty line, a no-usage line, a CORRUPT line that contains
// "usage" (parse fails → keep walking), then the real newest usage entry.
writeT('t-usage.jsonl', [
  '{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-08-19T10:00:00.000Z"}',
  '{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":12,"cache_read_input_tokens":180000,"cache_creation_input_tokens":900,"output_tokens":50}},"timestamp":"2026-08-19T10:00:05.000Z"}',
  '{"type":"assistant","message":{"role":"assistant","usage":{"input_tokens":20,"cache_read_input_tokens":200000,"cache_creation_input_tokens":1500,"output_tokens":80}},"timestamp":"2026-08-19T10:05:00.000Z"}',
  '{"corrupt":"usage" broken json',
  '{"type":"progress","note":"nothing here"}',
  '',
].join('\n'), NOW - 300_000)
// No usage anywhere → contextTokens null, idleMs still measured.
writeT('t-nousage.jsonl', '{"type":"user","message":{"role":"user"}}\n{"type":"progress"}\n', NOW - 120_000)
// Usage with a bad timestamp, and one with none → lastRequestAtMs null either way (the newest wins).
writeT('t-badts.jsonl', [
  '{"type":"assistant","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":10}},"timestamp":"2026-08-19T09:00:00.000Z"}',
  '{"type":"assistant","message":{"usage":{"input_tokens":7,"cache_read_input_tokens":20}},"timestamp":"not-a-date"}',
  '',
].join('\n'), NOW - 60_000)
// Bounded tail: a long first line whose usage must NOT be seen (partial first chunk line is
// dropped when the read starts mid-file), then the short real one inside the 256-byte tail.
writeT('t-tail.jsonl', [
  `{"type":"assistant","message":{"usage":{"input_tokens":999999,"cache_read_input_tokens":1,"cache_creation_input_tokens":1}},"pad":"${'x'.repeat(400)}","timestamp":"2026-08-19T08:00:00.000Z"}`,
  '{"type":"assistant","message":{"usage":{"input_tokens":42,"cache_read_input_tokens":58,"cache_creation_input_tokens":0}},"timestamp":"2026-08-19T08:30:00.000Z"}',
  '',
].join('\n'), NOW - 45_000)

// ── The shared state pieces ────────────────────────────────────────────────────────────────
const ttlMain1h = J(classifyTtlRegime('main', { auth: 'subscription', force5m: false, enable1h: false }))
const base = (over = {}) => ({
  now: NOW,
  mode: 'enforce',
  parent: { contextTokens: null, idleMs: null },
  startsLast60s: 0,
  startsLast2min: 0,
  spawners: [],
  lastStopFailureMs: null,
  stall: null,
  stallRecovered: false,
  thrash: null,
  premiumShare: null,
  premiumModel: null,
  ttl: ttlMain1h,
  caller: { session: 'sess-caller-1', cwd: '/tmp/projA' },
  thresholds: {},
  ...over,
})
const thrash = (over = {}) => ({
  active: true, count: 6, rebilledTokens: 1_800_000, model: 'claude-fable-5', windowMs: 300_000,
  suspects: [{ file: 'r1.request.json', bytes: 1_100_000, model: 'claude-fable-5' }],
  topSource: { session: 'sess-caller-1', count: 6, rebilledTokens: 1_800_000 },
  unattributed: { count: 0, rebilledTokens: 0 }, coldStartSessions: 0, coldStartRebilledTokens: 0,
  ...over,
})
const ownSpawners = [
  { session: 'sess-caller-1', cwd: '/tmp/projA', count: 6, agentTypes: ['explore×3', 'fork'] },
  { session: 'other-sess', cwd: '/tmp/other', count: 3, agentTypes: ['explore×3'] },
]
const liveEvents = [
  { ts: NOW - 500_000, ev: 'SubagentStart', session: 's', payload: { agent_id: 'abc123', agent_type: 'fork' } },
  { ts: NOW - 400_000, ev: 'SubagentStop', session: 's', payload: { agent_id: 'abc123' } },
  { ts: NOW - 300_000, ev: 'SubagentStart', session: 's', payload: { agent_id: 'def456' } },
  { ts: NOW - 300_000, ev: 'SubagentStop', session: 's', payload: { agent_id: 'tie789' } },
  { ts: NOW - 300_000, ev: 'SubagentStart', session: 's', payload: { agent_id: 'tie789' } }, // equal ts — later entry wins (>=)
  { ts: NOW - 200_000, ev: 'Stop', session: 's', payload: { agent_id: 'abc123' } }, // not a Subagent* event — ignored
]

// ── The case list (name → dispatch + inputs; ONE source for both engines) ──────────────────
const cases = [
  { name: 'quiet allow', fn: 'evaluateAgentGate', toolInput: null, state: base() },
  { name: 'thrash fork deny', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'fork', prompt: 'do x' }, state: base({ thrash: thrash() }) },
  { name: 'thrash fresh warn', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'explore', prompt: 'scan' }, state: base({ thrash: thrash() }) },
  { name: 'thrash keepwarm advisory', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'fork', prompt: 'keep-warm ping' }, state: base({ thrash: thrash() }) },
  { name: 'thrash no-model no-suspects', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'fork' }, state: base({ thrash: thrash({ model: null, suspects: [] }) }) },
  { name: 'runaway deny', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'explore' }, state: base({ startsLast60s: 9, startsLast2min: 9, spawners: ownSpawners }) },
  { name: 'runaway warn-mode downgrade', fn: 'evaluateAgentGate', toolInput: {}, state: base({ mode: 'warn', startsLast60s: 9, spawners: ownSpawners }) },
  { name: 'cold-resume fanout deny own stall', fn: 'evaluateAgentGate', toolInput: {}, state: base({ lastStopFailureMs: NOW - 120_000, startsLast2min: 1, stall: { session: 'sess-caller-1', cwd: '/tmp/projA' } }) },
  { name: 'cold-resume disarmed by warm evidence', fn: 'evaluateAgentGate', toolInput: {}, state: base({ lastStopFailureMs: NOW - 120_000, startsLast2min: 1, stall: { session: 'sess-caller-1', cwd: '/tmp/projA' }, stallRecovered: true }) },
  { name: 'cold-resume foreign stall unnamed', fn: 'evaluateAgentGate', toolInput: {}, state: base({ lastStopFailureMs: NOW - 540_000, startsLast2min: 2, stall: { session: 'zzz-other', cwd: '/tmp/elsewhere' } }) },
  { name: 'cold-resume stall via worktree session match', fn: 'evaluateAgentGate', toolInput: {}, state: base({ lastStopFailureMs: NOW - 60_000, startsLast2min: 1, stall: { session: 'sess-caller-1', cwd: '/tmp/projA/.claude/worktrees/x' } }) },
  { name: 'fork storm 1h ttl', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'fork' }, state: base({ parent: { contextTokens: 350_000, idleMs: 4_000_000 }, startsLast2min: 3, spawners: ownSpawners }) },
  { name: 'warm 1h ttl is only fat', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'fork' }, state: base({ parent: { contextTokens: 350_000, idleMs: 400_000 }, startsLast2min: 3 }) },
  { name: 'explicit coldIdleMs override beats ttl', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'fork' }, state: base({ parent: { contextTokens: 350_000, idleMs: 400_000 }, startsLast2min: 3, thresholds: { coldIdleMs: 330_000 } }) },
  { name: 'cold fork single', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'fork' }, state: base({ parent: { contextTokens: 350_000, idleMs: 4_000_000 }, startsLast2min: 1 }) },
  { name: 'fork fat parent warm', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'fork' }, state: base({ parent: { contextTokens: 350_000, idleMs: 10_000 } }) },
  { name: 'fork fat via threshold override', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'fork' }, state: base({ parent: { contextTokens: 150_000, idleMs: 10_000 }, thresholds: { forkFatTokens: 100_000 } }) },
  { name: 'fanout headsup premium hint', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'explore' }, state: base({ startsLast2min: 6, spawners: ownSpawners, premiumShare: 0.8, premiumModel: 'claude-opus-5' }) },
  { name: 'fanout headsup model pinned', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'explore', model: 'sonnet' }, state: base({ startsLast2min: 6, spawners: ownSpawners, premiumShare: 0.8, premiumModel: 'claude-opus-5' }) },
  { name: 'fanout unattributable stays silent', fn: 'evaluateAgentGate', toolInput: {}, state: base({ startsLast2min: 9, spawners: ownSpawners, caller: { session: null, cwd: null } }) },
  { name: 'sessionless spawner never matches ? caller', fn: 'evaluateAgentGate', toolInput: {}, state: base({ startsLast2min: 9, spawners: [{ session: '?', cwd: '/tmp/projB', count: 9, agentTypes: ['explore'] }], caller: { session: '?', cwd: null } }) },
  { name: 'keepwarm skips warn tier', fn: 'evaluateAgentGate', toolInput: { prompt: 'keepwarm pinger' }, state: base({ parent: { contextTokens: 350_000, idleMs: 4_000_000 } }) },
  { name: 'assumed ttl cold fork', fn: 'evaluateAgentGate', toolInput: { subagent_type: 'fork' }, state: (() => { const st = base({ parent: { contextTokens: 350_000, idleMs: 400_000 } }); delete st.ttl; return st })() },

  { name: 'message live target always passes', fn: 'evaluateSendMessageGate', state: base({ thrash: thrash(), messageTarget: 'agent-abc123', targetLiveness: 'live' }) },
  { name: 'message dead thrash deny', fn: 'evaluateSendMessageGate', state: base({ thrash: thrash(), messageTarget: 'agent-abc123', targetLiveness: 'dead' }) },
  { name: 'message unknown thrash warn downgrade', fn: 'evaluateSendMessageGate', state: base({ thrash: thrash(), messageTarget: 'worker', targetLiveness: 'unknown' }) },
  { name: 'message dead cold-resume deny', fn: 'evaluateSendMessageGate', state: base({ lastStopFailureMs: NOW - 240_000, stall: { session: 'sess-caller-1', cwd: '/tmp/projA' }, messageTarget: 'agent-abc123', targetLiveness: 'dead' }) },
  { name: 'message quiet dead allow', fn: 'evaluateSendMessageGate', state: base({ messageTarget: 'agent-abc123', targetLiveness: 'dead' }) },
  { name: 'message dead thrash warn-mode', fn: 'evaluateSendMessageGate', state: base({ mode: 'warn', thrash: thrash(), messageTarget: 'agent-abc123', targetLiveness: 'dead' }) },
  { name: 'message no target no liveness', fn: 'evaluateSendMessageGate', state: base({ thrash: thrash() }) },

  { name: 'img non-image allow', fn: 'evaluateImageReadGate', toolInput: { file_path: '/a/b.txt' }, state: base({ parent: { contextTokens: 400_000, idleMs: 0 } }) },
  { name: 'img svg deliberately allowed', fn: 'evaluateImageReadGate', toolInput: { file_path: '/a/diagram.svg' }, state: base({ parent: { contextTokens: 400_000, idleMs: 0 } }) },
  { name: 'img small session allow', fn: 'evaluateImageReadGate', toolInput: { file_path: '/a/b.png' }, state: base({ parent: { contextTokens: 30_000, idleMs: 0 } }) },
  { name: 'img warn uppercase ext', fn: 'evaluateImageReadGate', toolInput: { file_path: '/shots/Screen Shot.PNG' }, state: base({ parent: { contextTokens: 120_000, idleMs: 0 } }) },
  { name: 'img dominating pdf', fn: 'evaluateImageReadGate', toolInput: { file_path: '/x/y.pdf' }, state: base({ parent: { contextTokens: 350_000, idleMs: 0 } }) },
  { name: 'img null ctx no claim', fn: 'evaluateImageReadGate', toolInput: { file_path: '/a/b.png' }, state: base() },
  { name: 'img no path allow', fn: 'evaluateImageReadGate', toolInput: {}, state: base({ parent: { contextTokens: 400_000, idleMs: 0 } }) },

  { name: 'advisory thrash', fn: 'buildAdvisory', state: base({ thrash: thrash() }) },
  { name: 'advisory fanout premium', fn: 'buildAdvisory', state: base({ startsLast2min: 6, spawners: ownSpawners, premiumShare: 0.8, premiumModel: 'claude-opus-5' }) },
  { name: 'advisory quiet null', fn: 'buildAdvisory', state: base() },

  { name: 'liveness main', fn: 'resolveMessageTargetLiveness', target: 'main', events: liveEvents },
  { name: 'liveness dead after stop', fn: 'resolveMessageTargetLiveness', target: 'agent-abc123', events: liveEvents },
  { name: 'liveness bare id live', fn: 'resolveMessageTargetLiveness', target: 'def456', events: liveEvents },
  { name: 'liveness equal-ts later wins', fn: 'resolveMessageTargetLiveness', target: 'tie789', events: liveEvents },
  { name: 'liveness name unknown', fn: 'resolveMessageTargetLiveness', target: 'worker', events: liveEvents },
  { name: 'liveness non-string unknown', fn: 'resolveMessageTargetLiveness', target: 42, events: liveEvents },
  { name: 'liveness empty unknown', fn: 'resolveMessageTargetLiveness', target: '', events: liveEvents },

  { name: 'pinger plain', fn: 'isKeepWarmPinger', input: { prompt: 'keep warm please' } },
  { name: 'pinger fork', fn: 'isKeepWarmPinger', input: { subagent_type: 'fork', prompt: 'the pinger' } },
  { name: 'pinger typed agent never', fn: 'isKeepWarmPinger', input: { subagent_type: 'explore', prompt: 'keep-warm' } },
  { name: 'pinger dot matches any char', fn: 'isKeepWarmPinger', input: { prompt: 'keepXwarm' } },
  { name: 'pinger dot excludes newline', fn: 'isKeepWarmPinger', input: { prompt: 'keep\nwarm' } },
  { name: 'pinger empty type', fn: 'isKeepWarmPinger', input: { subagent_type: '', prompt: 'pinger' } },
  { name: 'pinger no prompt', fn: 'isKeepWarmPinger', input: { subagent_type: 'fork' } },
  { name: 'pinger case-insensitive', fn: 'isKeepWarmPinger', input: { prompt: 'KEEP-WARM' } },

  { name: 'transcript usage walk-back', fn: 'readTranscriptContext', file: 't-usage.jsonl', now: NOW, tailBytes: 262144 },
  { name: 'transcript no usage', fn: 'readTranscriptContext', file: 't-nousage.jsonl', now: NOW, tailBytes: 262144 },
  { name: 'transcript bad timestamp', fn: 'readTranscriptContext', file: 't-badts.jsonl', now: NOW, tailBytes: 262144 },
  { name: 'transcript bounded tail drops partial first line', fn: 'readTranscriptContext', file: 't-tail.jsonl', now: NOW, tailBytes: 256 },
  { name: 'transcript missing file', fn: 'readTranscriptContext', file: 'no-such.jsonl', now: NOW, tailBytes: 262144 },
]

// ── Evaluate through the COMPILED TS and emit ──────────────────────────────────────────────
const expected = cases.map((c) => {
  switch (c.fn) {
    case 'evaluateAgentGate': return J(evaluateAgentGate(c.toolInput, c.state))
    case 'evaluateSendMessageGate': return J(evaluateSendMessageGate(c.state))
    case 'evaluateImageReadGate': return J(evaluateImageReadGate(c.toolInput, c.state))
    case 'buildAdvisory': return J(buildAdvisory(c.state))
    case 'resolveMessageTargetLiveness': return J(resolveMessageTargetLiveness(c.target, c.events))
    case 'isKeepWarmPinger': return J(isKeepWarmPinger(c.input))
    case 'readTranscriptContext': return J(readTranscriptContext(join(root, c.file), c.now, c.tailBytes))
    default: throw new Error(`unknown fn ${c.fn}`)
  }
})

writeFileSync(join(dir, 'agentgate-expected.json'), JSON.stringify({ cases: J(cases), expected, transcripts }, null, 1))
console.log(`agentgate-expected.json: ${cases.length} cases`)
