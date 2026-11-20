import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { stopHolderFromLog } from '../cli/serverControl'

// TRDD-N60JUWU3 box 3 — the CLI's "stuck behind <holder>" text is read back out of server.log with
// a regex; these tests run it against the line alcore.rs really prints (bin/alcore.rs, the
// Outcome::TimedOut arm of the stop sequence), built from the same format string.
const ts = '2026-11-19T10:00:00+0100'
const site = 'rust-core/crates/agentlens-core/src/ui.rs:1234 (holding for 7500 ms)'
const timedOut = (holder: string, ms = 8000): string =>
  `${ts} alcore: stop timed out after ${ms} ms waiting on ${holder} — skipping the flush, releasing the pid lock anyway`

suite('stopHolderFromLog — the alcore stop-timeout line (TRDD-N60JUWU3)', () => {
  test('a real "stop timed out ... waiting on <holder>" line yields the holder only, without the " — skipping the flush" tail', () => {
    assert.strictEqual(
      stopHolderFromLog(timedOut(site) + '\n'),
      site)
  })

  test('the line format in alcore.rs itself is matched and yields the holder only (no hand-copied template: a format edit there turns this red)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../rust-core/crates/agentlens-core/src/bin/alcore.rs'), 'utf8')
    const fmt = src.split('\n').map(l => l.trim()).filter(l => !l.startsWith('//') && l.includes('alcore: stop timed out after'))
    assert.strictEqual(fmt.length, 1, `expected exactly one "stop timed out after" format line in alcore.rs, found ${fmt.length}`)
    const m = /^"(.*)",$/.exec(fmt[0])
    assert.ok(m, `unexpected shape of the alcore.rs format line: ${fmt[0]}`)
    const sample = m[1].replace('{}', ts).replace('{}', '8000').replace('{holder}', site)
    assert.strictEqual(stopHolderFromLog(sample), site)
  })

  test('a holder text that itself contains "waiting on" is captured whole', () => {
    assert.strictEqual(stopHolderFromLog(timedOut('x.rs:1 waiting on y')), 'x.rs:1 waiting on y')
  })

  test('the "unknown" holder alcore prints when no site was recorded is returned', () => {
    assert.strictEqual(stopHolderFromLog(timedOut('unknown')), 'unknown')
  })

  test('a line with no " — " tail returns the whole rest of the line', () => {
    assert.strictEqual(stopHolderFromLog(`${ts} alcore: stop timed out after 8000 ms waiting on ${site}\n`), site)
    assert.strictEqual(stopHolderFromLog(`${ts} alcore: stop waiting on ${site}`), site)
  })

  test('the sweeper line "stop gave up waiting on the sweeper thread" is not a holder line', () => {
    const sweeper = `${ts} alcore: stop gave up waiting on the sweeper thread's own flush — the shared stop budget elapsed`
    assert.strictEqual(stopHolderFromLog(sweeper), null)
  })

  test('a log with no stop line returns null', () => {
    assert.strictEqual(stopHolderFromLog(`${ts} alcore: MCP listening on 127.0.0.1:3000\n${ts} alcore: boot done\n`), null)
    assert.strictEqual(stopHolderFromLog(''), null)
  })

  test('with two matching lines the FIRST one wins (String.match without the g flag)', () => {
    const log = `${timedOut('first.rs:1 (holding for 1 ms)')}\nnoise\n${timedOut('second.rs:2 (holding for 2 ms)')}\n`
    assert.strictEqual(stopHolderFromLog(log), 'first.rs:1 (holding for 1 ms)')
  })

  test('a matching line among unrelated lines is found', () => {
    const log = `${ts} alcore: sweep done\n${timedOut(site)}\n${ts} alcore: pid lock released\n`
    assert.strictEqual(stopHolderFromLog(log), site)
  })
})
