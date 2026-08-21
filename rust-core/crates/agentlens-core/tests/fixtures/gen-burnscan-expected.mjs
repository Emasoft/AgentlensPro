// Regenerates burnscan-expected.json — and every fixture dir it reads — from the COMPILED
// src/burnInvestigator.ts. The parity oracle for burnInvestigator SLICE 1, the corpus SCAN half
// (TRDD-DMWOBWFH P4x.2e). Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-burnscan-expected.mjs
//
// The generator WRITES its own fixture bodies so the corpus and the mtime table that gives it
// meaning have ONE source. MTIME ORACLE: the window filter, byHour, firstIso/lastIso and the
// coverage counts are all functions of mtime, and git does not preserve mtimes — stamped here,
// PUBLISHED, and re-stamped by the Rust test.
//
// os.homedir() is STUBBED to the fixtures dir: shortWs then abbreviates the scanned dir to
// `~/burnscan-bodies` in `note`/`verdict`, so those strings are deterministic AND carry no home
// path. Only `coverage.dirsScanned` / `dirsMissing` stay absolute and are redacted.
//
// What the fixture pins, and which file carries it:
//  - THE #1 TRAP: WS_RE is global. q4 quotes the regex's OWN SOURCE ("Primary working directory:
//    ([^") before the real "Primary working directory: /w/beta". Taking the first hit reports `([^`
//    as the top-burning workspace — measured, on this very file.
//  - Fingerprint identity: q1 and q2 share their first 2600 UTF-16 units after `"messages"`, so
//    they must hash EQUAL (slice 2's fork-storm detector keys on that). q6 has <2600 following
//    units, so its fingerprint must stay ''.
//  - UTF-16, not bytes: q2's padding is emoji, so a byte-indexed slice(i, i+2600) picks a
//    different substring and the two fingerprints stop matching.
//  - r5's `body` is a JSON STRING (the re-parse branch); r8 has no `body` key at all (`d.body ?? d`);
//    r4 is all-zeros (`u.x || 0`); r6 is MALFORMED — it is still counted in responseFilesScanned
//    but yields no record, so totals.calls < responseFilesScanned. That gap IS the coverage honesty.
//  - r7/q7 sit BEFORE the window and must vanish from `present` as well as from the scan.
//  - burnscan-cap/ holds 101 request files of ASCENDING size against the cap FLOOR of 100, so the
//    dropped file must be the SMALLEST. A reversed sort keeps the smallest 100 instead and no
//    other test would notice.
//  - burnscan-noresp/ has requests but no responses; a MISSING dir gives blind=no-bodies-dir.
//
// NOT COVERED, deliberately: blind='capture-off' is unreachable through investigateBurn's public
// API (the bodiesDir override hardcodes captureOn:true), so it is pinned by a Rust unit test
// instead and carries no oracle.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
os.homedir = () => HERE // stubbed BEFORE the module under test reads it

const { investigateBurn } = await import(path.join(HERE, '../../../../../out/burnInvestigator.js'))

const BODIES = path.join(HERE, 'burnscan-bodies')
const NORESP = path.join(HERE, 'burnscan-noresp')
const CAP = path.join(HERE, 'burnscan-cap')
const HOOKS = path.join(HERE, 'burnscan-hooks')
const MISSING = path.join(HERE, 'no-such-burnscan-dir')

const T = (iso) => Date.parse(iso)
const UNTIL = T('2026-08-20T12:00:00.000Z')

for (const d of [BODIES, NORESP, CAP, HOOKS]) {
  fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(d, { recursive: true })
}

const mtimes = {} // "<dir>/<name>" -> ms
function write(dir, name, body, whenIso) {
  fs.writeFileSync(path.join(dir, name), body)
  mtimes[`${path.basename(dir)}/${name}`] = T(whenIso)
}

// ── responses ────────────────────────────────────────────────────────────────
const resp = (model, cc, cr, out, inp) =>
  JSON.stringify({ body: { model, usage: { cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: out, input_tokens: inp } } })

write(BODIES, 'r1.response.json', resp('claude-opus-5', 150000, 20000, 500, 10), '2026-08-20T08:30:00Z')
write(BODIES, 'r2.response.json', resp('claude-opus-5', 200000, 5000, 300, 8), '2026-08-20T08:35:00Z')
write(BODIES, 'r3.response.json', resp('claude-sonnet-5', 1000, 400000, 100, 4), '2026-08-20T09:10:00Z')
write(BODIES, 'r4.response.json', resp('claude-sonnet-5', 0, 0, 0, 0), '2026-08-20T09:15:00Z')
// `body` as a JSON STRING — the re-parse branch.
write(BODIES, 'r5.response.json',
  JSON.stringify({ body: JSON.stringify(JSON.parse(resp('claude-opus-5', 90000, 1000, 50, 2)).body) }),
  '2026-08-20T08:40:00Z')
write(BODIES, 'r6.response.json', '{ not json at all', '2026-08-20T10:00:00Z')
// No `body` key — `d.body ?? d` falls through to the top level.
write(BODIES, 'r8.response.json', JSON.stringify({ model: 'claude-haiku-4-5-20251001', usage: { cache_creation_input_tokens: 700, cache_read_input_tokens: 0, output_tokens: 20 } }), '2026-08-20T09:20:00Z')
// BEFORE the window — must not appear even in `present`.
write(BODIES, 'r7.response.json', resp('claude-opus-5', 999999, 0, 0, 0), '2026-08-20T06:00:00Z')

// ── requests ─────────────────────────────────────────────────────────────────
const ENV = (ws) => `\\n<env>\\nPrimary working directory: ${ws}\\nIs a git repository: true\\n</env>`
// A shared first-2600 prefix after `"messages"` gives q1 and q2 the SAME fingerprint. The pad is
// emoji on purpose: a byte-indexed slice would take a different 2600 and break the match.
const SHARED = '🚀'.repeat(1400)
const req = (model, tailEnv, pad) =>
  `{"model":"${model}","messages":[{"role":"user","content":"${SHARED}${pad}"}]${tailEnv}}`

write(BODIES, 'q1.request.json', req('claude-opus-5', `,"env":"${ENV('/w/alpha')}"`, 'A'.repeat(500)), '2026-08-20T08:30:00Z')
write(BODIES, 'q2.request.json', req('claude-opus-5', `,"env":"${ENV('/w/alpha')}"`, 'B'.repeat(900)), '2026-08-20T08:31:00Z')
// No Environment block at all → subagent-shaped (workspace '').
write(BODIES, 'q3.request.json', req('claude-sonnet-5', '', 'C'.repeat(100)), '2026-08-20T09:10:00Z')
// THE TRAP: the regex's own source appears FIRST; the real workspace comes after.
write(BODIES, 'q4.request.json',
  req('claude-sonnet-5', `,"note":"Primary working directory: ([^ is the pattern","env":"${ENV('/w/beta')}"`, 'D'.repeat(50)),
  '2026-08-20T09:12:00Z')
// An image blob at the 20k floor.
write(BODIES, 'q5.request.json', `{"model":"claude-opus-5","messages":[{"role":"user","content":[{"type":"image","source":{"data":"${'A'.repeat(20005)}"}}]}],"env":"${ENV('/w/alpha')}"}`, '2026-08-20T09:14:00Z')
// Fewer than 2600 units after `"messages"` → fingerprint must stay ''.
write(BODIES, 'q6.request.json', '{"model":"claude-opus-5","messages":[{"role":"user","content":"tiny"}]}', '2026-08-20T08:32:00Z')
write(BODIES, 'q7.request.json', req('claude-opus-5', '', 'E'.repeat(10)), '2026-08-20T06:30:00Z')
// q8 is the ONLY fixture that can tell UTF-16 slicing from byte slicing. It matches q1 through
// byte 2600 (emoji #650) but DIFFERS at emoji #1000 — unit 2000, byte 4000. A correct slice(i,
// i+2600) UTF-16 window sees the difference and hashes differently; a 2600-BYTE window stops at
// emoji #650 and hashes q8 IDENTICAL to q1, silently merging two unrelated transcripts into one
// "shared transcript" family — which is precisely what slice 2's fork-storm detector keys on.
// A fingerprint value is never reported, so nothing else in the suite could observe this.
const DIVERGENT = '🚀'.repeat(1000) + '🎯' + '🚀'.repeat(399)
write(BODIES, 'q8.request.json',
  `{"model":"claude-opus-5","messages":[{"role":"user","content":"${DIVERGENT}${'A'.repeat(500)}"}],"env":"${ENV('/w/alpha')}"}`,
  '2026-08-20T08:33:00Z')

// ── the no-response and cap corpora ──────────────────────────────────────────
write(NORESP, 'n1.request.json', req('claude-opus-5', `,"env":"${ENV('/w/gamma')}"`, 'F'.repeat(20)), '2026-08-20T09:00:00Z')

// 101 files of ASCENDING size against the cap floor of 100: the SMALLEST must be the one dropped.
for (let i = 0; i < 101; i++) {
  write(CAP, `c${String(i).padStart(3, '0')}.request.json`, `{"model":"m","pad":"${'x'.repeat(i)}"}`, '2026-08-20T09:00:00Z')
}

// ── hook events (StopFailure correlation, consumed by slice 2) ────────────────
const hookTs = T('2026-08-20T08:25:00Z')
fs.writeFileSync(path.join(HOOKS, '2026-08-20.ndjsonl'), JSON.stringify({ ts: hookTs, ev: 'StopFailure', session: 's1' }) + '\n')

// ── stamp, then run the oracle ───────────────────────────────────────────────
for (const [rel, ms] of Object.entries(mtimes)) {
  const p = path.join(HERE, rel)
  fs.utimesSync(p, ms / 1000, ms / 1000)
}

const run = (opts) => investigateBurn({ hookEventsDir: HOOKS, untilMs: UNTIL, ...opts })

const cases = {
  main: run({ bodiesDir: BODIES }),
  clampedHigh: run({ bodiesDir: BODIES, windowHours: 100 }),
  clampedLow: run({ bodiesDir: BODIES, windowHours: 0.01 }),
  noResponses: run({ bodiesDir: NORESP }),
  missingDir: run({ bodiesDir: MISSING }),
  capHit: run({ bodiesDir: CAP, maxFiles: 1 }),
}

const redact = (v) =>
  JSON.parse(
    JSON.stringify(v)
      .split(JSON.stringify(BODIES).slice(1, -1)).join('<BODIES>')
      .split(JSON.stringify(NORESP).slice(1, -1)).join('<NORESP>')
      .split(JSON.stringify(CAP).slice(1, -1)).join('<CAP>')
      .split(JSON.stringify(MISSING).slice(1, -1)).join('<MISSING>')
  )

const out = { untilMs: UNTIL, hookStopFailureMs: hookTs, mtimes, cases: redact(cases) }
fs.writeFileSync(path.join(HERE, 'burnscan-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote burnscan-expected.json —', Object.keys(cases).length, 'cases')
for (const [k, v] of Object.entries(cases)) {
  console.log(` ${k}: calls=${v.totals.calls} reqs=${v.coverage.requestFilesScanned} blind=${v.coverage.blind ?? '-'} complete=${v.coverage.complete}`)
}
