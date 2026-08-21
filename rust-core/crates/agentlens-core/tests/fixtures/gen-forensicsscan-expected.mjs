// Regenerates the forensicsscan fixture AND forensicsscan-expected.json from the COMPILED
// src/forensicsIndex.ts — the parity oracle for SLICE B2 (TRDD-DMWOBWFH): scanApiCallEvents and the
// previous_message_id join it is built on.
//
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-forensicsscan-expected.mjs
//
// WHY THIS GENERATOR WRITES THE BODIES TOO, instead of them being hand-authored files: the expected
// output and the inputs must not drift, and the mtimes are part of the input. A spool EvidenceRow
// carries ts_ms = null (a body's capture time is unknown until it is parsed, and by then the file
// may be gone), so resolveTs falls back to the file's mtime — which git does not preserve. Both
// sides therefore STAMP the mtimes from the manifest below rather than trusting the filesystem.
//
// EVERY MTIME IS DISTINCT, and that is load-bearing twice over. The spool half of listBodyEvidence
// is a readdir, whose order is filesystem-dependent and NOT guaranteed to agree between Node and
// Rust; selectRecent then sorts by ts descending with a STABLE sort, so equal timestamps would let
// readdir order leak into the result and the two implementations could disagree for a reason that
// is not a porting error. Distinct mtimes make the sort total, so the fixture pins what the CODE
// decides rather than what the directory handed it.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { scanApiCallEvents } = await import(path.join(HERE, '../../../../../out/test/forensicsIndex.js'))

const SPOOL = path.join(HERE, 'forensicsscan/spool')
fs.rmSync(SPOOL, { recursive: true, force: true })
fs.mkdirSync(SPOOL, { recursive: true })

// A fixed clock. windowHours is measured back from it, so the window boundary is pinned instead of
// drifting with the day the fixture is built.
const NOW_MS = 1_760_000_000_000
const MIN = 60_000

// user_id is the JSON-STRING blob Claude Code actually sends, not a bare id — parseUserId splits it.
// The ids are visibly fake (few distinct characters): a fixture is shipped, and a real session or
// account uuid in a shipped file is one machine's noise handed to everyone.
const uid = (sid, acct) => JSON.stringify({ device_id: 'dddddddd', account_uuid: acct, session_id: sid })

// Paths inside the bodies are rooted at /fixture, never a home directory — check-identities matches
// the SHAPE `/home/<user>`, so even an invented username fails it.
const bodies = [
  // ── an ATTRIBUTED call: request r1 declares previous_message_id msg_aaaa, response msg_aaaa joins.
  { name: 'call1.request.json', mtimeMs: NOW_MS - 10 * MIN, body: {
    model: 'claude-opus-5',
    thinking: { budget_tokens: 24576 },
    metadata: { user_id: uid('aaaaaaaa-1111-2222-3333-444444444444', 'bbbbbbbb-1111-2222-3333-444444444444') },
    diagnostics: { previous_message_id: 'msg_aaaa' },
    system: [{ type: 'text', text: 'Contents of /fixture/.claude/CLAUDE.md (project instructions):\nbe good' }],
    tools: [{ name: 'Bash' }],
    messages: [{ role: 'user', content: 'hi' }],
  } },
  { name: 'call1.response.json', mtimeMs: NOW_MS - 9 * MIN, body: {
    id: 'msg_aaaa', model: 'claude-opus-5',
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
             cache_creation: { ephemeral_5m_input_tokens: 25, ephemeral_1h_input_tokens: 15 } },
  } },

  // ── an UNATTRIBUTED call: no request declares msg_bbbb, so every link-derived key is OMITTED and
  //    effort falls back to 'none'. This is the row that catches a port emitting nulls.
  { name: 'call2.response.json', mtimeMs: NOW_MS - 8 * MIN, body: {
    id: 'msg_bbbb', model: 'claude-sonnet-5',
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
  } },

  // ── NO usage block → skipped entirely. A port that emitted a zeroed event would add a row here.
  { name: 'call3.response.json', mtimeMs: NOW_MS - 7 * MIN, body: { id: 'msg_cccc', model: 'claude-opus-5' } },

  // ── NO response id → call_id is a sha1 of the SRC_NAME, never of the ref (which is an absolute
  //    spool path before the drain and a bare src_name after — hashing it gave one physical call two
  //    primary keys across a drain and every aggregate double-counted it).
  { name: 'call4.response.json', mtimeMs: NOW_MS - 6 * MIN, body: {
    message: { model: 'claude-mythos-5' },
    usage: { input_tokens: 5, output_tokens: 6 },
  } },

  // ── model FALLBACK chain: the link carries no model, the body has none, so message.model wins.
  { name: 'call5.request.json', mtimeMs: NOW_MS - 5 * MIN, body: {
    metadata: { user_id: uid('cccccccc-1111-2222-3333-444444444444', 'bbbbbbbb-1111-2222-3333-444444444444') },
    diagnostics: { previous_message_id: 'msg_eeee' },
    system: [{ type: 'text', text: 'plain' }],
  } },
  { name: 'call5.response.json', mtimeMs: NOW_MS - 4 * MIN, body: {
    id: 'msg_eeee',
    message: { model: 'claude-opus-5' },
    usage: { input_tokens: 7, output_tokens: 8, cache_creation_input_tokens: 9 },
  } },

  // ── OUTSIDE a 1h window by a wide margin. Present in the no-window run, absent in the windowed
  //    one — the TS records that an earlier shape exempted spool rows from the window entirely, so a
  //    windowHours scan silently indexed days-old calls while its coverage note claimed otherwise.
  { name: 'old.response.json', mtimeMs: NOW_MS - 48 * 60 * MIN, body: {
    id: 'msg_dddd', model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 200 },
  } },
]

for (const b of bodies) {
  const p = path.join(SPOOL, b.name)
  fs.writeFileSync(p, `${JSON.stringify(b.body, null, 2)}\n`)
  const secs = b.mtimeMs / 1000
  fs.utimesSync(p, secs, secs)
}

// storeDir points at a directory that does not exist: the spool-only path, where `<store>/bodies`
// is absent and the scan must still proceed on spool evidence alone.
const STORE = path.join(HERE, 'forensicsscan/no-such-store')

// withContent is OFF. deriveContentTags routes through buildCallComposition, which reads its own
// files and carries its own oracle (ctxcomp_parity) — pulling it in here would make this fixture
// depend on a second subsystem's behaviour and stop isolating the scan.
//
// THERE IS NO WINDOWED RUN HERE, AND THAT IS NOT AN OMISSION. scanApiCallEvents computes its window
// as `Date.now() - windowHours * 3_600_000` with no seam to inject a clock, so a windowed run
// pinned in a fixture would compare rows selected against the wall clock AT GENERATION TIME against
// rows selected against the wall clock at TEST time — it would pass only on the day it was built.
// (Generated with a windowHours:1 run it returned 0 events, because these fixture mtimes sit ~10
// months before the real now.) The window is therefore falsified natively in the Rust test, where
// now_ms IS a parameter; the runs below touch Date.now() nowhere, so they are stable forever.
const runs = []
for (const [label, opts] of [
  ['no window', { bodiesDir: SPOOL, storeDir: STORE, withContent: false }],
  ['cap 2', { bodiesDir: SPOOL, storeDir: STORE, withContent: false, scanCap: 2 }],
]) {
  const { events, coverage } = await scanApiCallEvents(opts)
  runs.push({ label, windowHours: opts.windowHours ?? null, scanCap: opts.scanCap ?? null, events, coverage })
}

// The missing-evidence branch: neither a spool nor a store exists. Its note names both paths, so it
// is checked as a shape with the paths substituted rather than pinned verbatim.
const absent = await scanApiCallEvents({ bodiesDir: path.join(HERE, 'forensicsscan/nope'), storeDir: STORE, withContent: false })

const out = {
  nowMs: NOW_MS,
  mtimes: Object.fromEntries(bodies.map((b) => [b.name, b.mtimeMs])),
  runs,
  absent: { events: absent.events, coverage: absent.coverage },
}
// The refs, bodiesDir and notes embed ABSOLUTE paths into this machine's checkout. Written
// verbatim they would (a) fail check-identities, which matches the shape of a home directory, and
// (b) only ever match on the machine that generated them. Both go away by tokenizing the two roots;
// the Rust side substitutes its own before parsing, so the comparison stays byte-exact.
const ROOT = path.join(HERE, 'forensicsscan')
const json = JSON.stringify(out, null, 2).split(JSON.stringify(ROOT).slice(1, -1)).join('<FIX>')
fs.writeFileSync(path.join(HERE, 'forensicsscan-expected.json'), `${json}\n`)
console.log(`wrote forensicsscan-expected.json — ${runs.map((r) => `${r.label}: ${r.events.length} events`).join(', ')}`)
