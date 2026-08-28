// Regenerates burnguard-expected.json from the COMPILED TS bodiesActivity + causingToolCall +
// burnGuard (the parity oracle). Builds a throwaway bodies dir + hook-event buckets + a Claude
// transcript tree under a temp root, so both engines see byte-identical inputs.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-burnguard-expected.mjs
import { createRequire } from 'module'
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { join, relative } from 'path'
const require = createRequire(import.meta.url)
const { BodiesActivityTracker, fmtFatSenders, extractResponseUsage } = require('../../../../../out/test/bodiesActivity.js')
const { checkBurnRisk } = require('../../../../../out/test/burnGuard.js')
const { causingToolCalls, composition } = require('../../../../../out/test/causingToolCall.js')
const { projectSlugOf, resolveProjectSlugs } = require('../../../../../out/test/projectSlug.js')
const dir = new URL('.', import.meta.url).pathname
const root = join(dir, 'burnguard-tree')

// ── Build the fixture tree (committed, so the Rust test reads the SAME bytes) ──────────────
const NOW = 1787000000000
const bodies = join(root, 'bodies')
const hooks = join(root, 'hook-events')
const projects = join(root, 'projects')
const proj = join(projects, '-tmp-wsA')
rmSync(root, { recursive: true, force: true })
mkdirSync(bodies, { recursive: true }); mkdirSync(hooks, { recursive: true }); mkdirSync(proj, { recursive: true })

// Pinned mtimes are fixture DATA: git checkout clobbers them, so record them for the Rust test to re-pin.
const mtimes = {}
const touch = (p, ms) => { utimesSync(p, new Date(ms), new Date(ms)); mtimes[relative(root, p)] = ms }
// A fat request from session S1 chaining to msg_a, and a huge one; plus a same-size request
// from S2 on a different model (the model-mismatch suspect filter).
const fatBody = (session, model, prevMsg, pad) =>
  `{"model":"${model}","messages":[{"role":"user","content":"${'x'.repeat(pad)}"}],` +
  `"diagnostics":{"previous_message_id":"${prevMsg}"},` +
  `"metadata":{"user_id":"acct__session_\\"session_id\\":\\"${session}\\""}}`
const write = (name, text, ms) => { const p = join(bodies, name); writeFileSync(p, text); touch(p, ms) }
write('r1.request.json', fatBody('11111111-aaaa-bbbb-cccc-000000000001', 'claude-fable-5', 'msg_a', 1_100_000), NOW - 30_000)
write('r2.request.json', fatBody('11111111-aaaa-bbbb-cccc-000000000001', 'claude-fable-5', 'msg_b', 1_100_000), NOW - 40_000)
write('r3.request.json', fatBody('11111111-aaaa-bbbb-cccc-000000000001', 'claude-fable-5', 'msg_c', 1_100_000), NOW - 50_000)
write('r4.request.json', fatBody('22222222-aaaa-bbbb-cccc-000000000002', 'claude-opus-5', 'msg_d', 450_000), NOW - 60_000)
// Responses: three big prefix re-writes with ~no cache read, all attributed to S1 via the chain.
const resp = (id, model, cc, cr) => JSON.stringify({ id, model, usage: { cache_creation_input_tokens: cc, cache_read_input_tokens: cr } })
write('a.response.json', resp('msg_a', 'claude-fable-5', 300000, 1000), NOW - 25_000)
write('b.response.json', resp('msg_b', 'claude-fable-5', 250000, 500), NOW - 35_000)
write('c.response.json', resp('msg_c', 'claude-fable-5', 220000, 400), NOW - 45_000)
// A warm response (big read, tiny write) for the sessionWarmSince probe.
write('d.response.json', resp('msg_d', 'claude-opus-5', 900, 200000), NOW - 20_000)
// Junk that must be skipped: not JSON, and a non-body name.
write('e.response.json', '{truncated mid-wr', NOW - 15_000)
write('notes.txt', 'ignored', NOW - 15_000)

// Hook events: 6 SubagentStart (over the default threshold 5) + a StopFailure + a PreCompact.
const day = new Date(NOW).toISOString().slice(0, 10)
const ev = (ts, name, payload) => JSON.stringify({ ts, ev: name, session: payload.session_id, payload })
const lines = []
for (let i = 0; i < 6; i++) {
  lines.push(ev(NOW - 60_000 + i * 1000, 'SubagentStart', {
    session_id: i < 4 ? 'spawner-1111' : 'spawner-2222', cwd: '/tmp/wsA', agent_type: i % 2 === 0 ? 'explorer' : 'fixer',
  }))
}
lines.push(ev(NOW - 300_000, 'StopFailure', { session_id: 'spawner-1111' }))
lines.push(ev(NOW - 120_000, 'PreCompact', { session_id: 'spawner-1111', trigger: 'auto' }))
writeFileSync(join(hooks, `${day}.ndjsonl`), lines.join('\n') + '\n')

// A transcript with spawn tool_use blocks inside the causing-call window, plus a torn line.
const iso = ms => new Date(ms).toISOString()
const asst = (ms, blocks) => JSON.stringify({ type: 'assistant', timestamp: iso(ms), message: { content: blocks } })
const tl = [
  asst(NOW - 90_000, [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'general-purpose', model: 'sonnet', prompt: 'go' } }]),
  asst(NOW - 80_000, [{ type: 'tool_use', name: 'Workflow', input: { script: 'x' } },
                      { type: 'tool_use', name: 'Agent', input: { subagent_type: 'general-purpose', model: 'sonnet' } }]),
  asst(NOW - 70_000, [{ type: 'text', text: 'not a tool_use' }]),
  asst(NOW - 20 * 60_000, [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'too-old' } }]),
  '{torn line',
  JSON.stringify({ type: 'user', timestamp: iso(NOW - 75_000) }),
]
const jsonl = join(proj, 'spawner-1111.jsonl')
writeFileSync(jsonl, tl.join('\n') + '\n')
touch(jsonl, NOW - 10_000)

// ── Oracle outputs ─────────────────────────────────────────────────────────────────────────
const tracker = new BodiesActivityTracker(bodies)
tracker.poll(NOW)
const report = tracker.report(NOW)
const risk = checkBurnRisk({
  now: NOW, bodiesDir: bodies, hookEventsDir: hooks, bodiesActivity: report,
  burnStatus: { accountWindows: [
    { accountUuid: 'acct-1111', accountLabel: 'a@example.com', fiveMinTokensPerMin: 400000,
      budget: { fiveHour: { minutesToExhaustion: 42 }, sevenDay: { minutesToExhaustion: 120 } } },
    { accountUuid: null, fiveMinTokensPerMin: 10 },
  ] },
})
const causing = await causingToolCalls({ workspace: '/tmp/wsA', atMs: NOW - 60_000, projectsDirs: [projects] })
const expected = {
  mtimes,
  report,
  warmSince: {
    s1: tracker.sessionWarmSince('11111111-aaaa-bbbb-cccc-000000000001', NOW - 600_000),
    s2: tracker.sessionWarmSince('22222222-aaaa-bbbb-cccc-000000000002', NOW - 600_000),
  },
  fmtSenders: [fmtFatSenders([]), fmtFatSenders(report.hugeRequests90s.senders), fmtFatSenders(report.thrash.suspects, 1)],
  usage: [
    extractResponseUsage(JSON.parse(resp('msg_x', 'm', 1, 2))),
    extractResponseUsage({ response: { id: 'r', model: 'm2', usage: { cache_creation_input_tokens: 5 } } }),
    extractResponseUsage({ nothing: true }),
    extractResponseUsage('str'),
  ],
  risk,
  causing,
  composition: composition(causing.calls),
  slugs: [projectSlugOf('/tmp/wsA'), projectSlugOf('already-a-slug'), projectSlugOf('  '), resolveProjectSlugs('/tmp/wsA', [projects])],
}
writeFileSync(dir + 'burnguard-expected.json', JSON.stringify(JSON.parse(JSON.stringify(expected)), null, 1) + '\n')
console.log('wrote report + risk(' + risk.activeCount + ' active) + ' + causing.calls.length + ' causing call(s)')
