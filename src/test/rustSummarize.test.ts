// src/test/rustSummarize.test.ts — the P4d end-to-end cross-engine harness (TRDD-DMWOBWFH):
// the SAME span array through TS summarizeSpans and the Rust `alsummarize` bin, results
// deepStrictEqual on the JSON wire shape.
//
// The binary comes from the repo's own cargo build (rust-core/target/release/alsummarize). CI
// has no Rust toolchain, so the parity tests surface as PENDING there (visible, never silently
// green); on this machine they run for real. The real-window sweep additionally needs the live
// span store (~/.agentlens/spans) and skips on machines without one.

import * as assert from 'assert'
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { summarizeSpans } from '../spanSummarizer'
import type { Span } from '../shared/telemetryTypes'

const BIN = path.join(__dirname, '..', '..', '..', 'rust-core', 'target', 'release', 'alsummarize')
const haveBin = fs.existsSync(BIN)
const FIXTURE = path.join(
  __dirname, '..', '..', '..', 'rust-core', 'crates', 'agentlens-core', 'tests', 'fixtures', 'summarize-spans.json',
)

function runBin(spans: unknown[]): Promise<unknown> {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alsum-')), 'spans.json')
  fs.writeFileSync(tmp, JSON.stringify(spans))
  return new Promise((resolve, reject) => {
    execFile(BIN, [tmp], { maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`alsummarize failed: ${err.message}\n${stderr}`)); return }
      resolve(JSON.parse(stdout))
    })
  })
}

/** The wire shape both consumers see: the JSON round-trip drops undefined-valued fields. */
function tsWire(spans: Span[]): unknown {
  return JSON.parse(JSON.stringify(summarizeSpans(spans)))
}

suite('rustSummarize — end-to-end engine parity', () => {
  const fixtureTest = haveBin ? test : test.skip
  fixtureTest('🐌 cross-engine parity on the cross-source fixture', async function () {
    this.timeout(30_000)
    const spans = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Span[]
    assert.deepStrictEqual(await runBin(spans), tsWire(spans),
      'sessions, backgroundSpans and efficiency must match field-for-field')
  })

  const spansDir = path.join(os.homedir(), '.agentlens', 'spans')
  const realDays = fs.existsSync(spansDir)
    ? fs.readdirSync(spansDir).filter(f => f.endsWith('.ndjson')).sort()
    : []
  const realTest = haveBin && realDays.length > 0 ? test : test.skip
  realTest('🐌 cross-engine parity on a REAL captured span window', async function () {
    this.timeout(120_000)
    // The newest day's tail — a real, adversarial mix of every provider's span shapes. The cap
    // bounds runtime, not coverage claims: both engines see the SAME slice.
    const lines = fs.readFileSync(path.join(spansDir, realDays[realDays.length - 1]), 'utf8')
      .split('\n').filter(Boolean).slice(-20_000)
    const spans: Span[] = []
    for (const line of lines) {
      try { spans.push(JSON.parse(line) as Span) } catch { /* corrupt tail — same skip both sides */ }
    }
    assert.ok(spans.length > 0, 'the live store should yield at least one span')
    assert.deepStrictEqual(await runBin(spans), tsWire(spans),
      `parity over ${spans.length} real spans`)
  })
})
