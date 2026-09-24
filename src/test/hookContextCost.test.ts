import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { sumHookContextCost, runHookContextCostCli, CHARS_PER_TOKEN_ESTIMATE } from '../cli/hookContextCostCli'

// Synthetic log-event sink in the exact persisted shape (logEventSink.buildDroppedLogEventRecord):
// attrs values are strings, as OTLP intValue arrives. Guards TRDD-ZQQYRYBO I15.
function writeSink(dir: string, day: string, recs: object[]): void {
  fs.writeFileSync(path.join(dir, `${day}.ndjsonl`), recs.map(r => JSON.stringify(r)).join('\n') + '\n')
}
function hookRec(ts: number, hookEvent: string, hookName: string, ctx: number, stdout = 0): object {
  return {
    ts, ev: 'hook_execution_complete', name: 'claude_code.hook_execution_complete',
    attrs: {
      hook_event: hookEvent, hook_name: hookName, additional_context_chars: String(ctx),
      stdout_chars: String(stdout), system_message_chars: '0', num_outputs_persisted: '0',
    },
  }
}

suite('hook-context-cost — sums hook_execution_complete size attributes', () => {
  let dir: string
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookcost-')) })
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  test('sums per (hook_event, hook_name), ignores other events and out-of-window records', async () => {
    const now = Date.parse('2026-09-24T12:00:00Z')
    writeSink(dir, '2026-09-24', [
      hookRec(now - 1000, 'SubagentStart', 'SubagentStart', 5200, 5300),
      hookRec(now - 2000, 'SubagentStart', 'SubagentStart', 5000, 5100),
      hookRec(now - 3000, 'PreToolUse', 'PreToolUse:Bash', 10),
      hookRec(now - 30 * 3_600_000, 'SubagentStart', 'SubagentStart', 99999), // outside a 24 h window
      { ts: now - 500, ev: 'user_prompt', name: 'claude_code.user_prompt', attrs: { additional_context_chars: '777' } },
    ])
    writeSink(dir, '2026-09-23', [hookRec(now - 25 * 3_600_000, 'SubagentStart', 'SubagentStart', 88888)])

    const res = await sumHookContextCost(dir, now - 24 * 3_600_000, now)
    assert.strictEqual(res.events, 3)
    const sub = res.rows.find(r => r.hookEvent === 'SubagentStart')
    assert.ok(sub)
    assert.strictEqual(sub.fires, 2)
    assert.strictEqual(sub.additionalContextChars, 10200)
    assert.strictEqual(sub.stdoutChars, 10400)
    assert.strictEqual(sub.estContextTokens, Math.round(10200 / CHARS_PER_TOKEN_ESTIMATE))
    assert.strictEqual(res.rows[0].hookEvent, 'SubagentStart', 'rows are ordered by injected context, largest first')
    assert.strictEqual(res.rows.find(r => r.hookName === 'PreToolUse:Bash')?.additionalContextChars, 10)
  })

  test('a torn tail line and non-numeric attributes do not poison the sums', async () => {
    const now = Date.now()
    fs.writeFileSync(path.join(dir, `${new Date(now).toISOString().slice(0, 10)}.ndjsonl`),
      JSON.stringify(hookRec(now - 1000, 'Stop', 'Stop', 40)) + '\n' +
      JSON.stringify({ ts: now - 900, ev: 'hook_execution_complete', attrs: { hook_event: 'Stop', hook_name: 'Stop', additional_context_chars: 'n/a' } }) + '\n' +
      '{"ts":1,"ev":"hook_execution_complete","attrs":{"hook_ev')
    const res = await sumHookContextCost(dir, now - 3_600_000, now)
    assert.strictEqual(res.events, 2)
    assert.strictEqual(res.rows[0].additionalContextChars, 40)
  })

  test('no events in the window is cannot-answer (exit 2), never a zero-cost success', async () => {
    const code = await runHookContextCostCli(['--hours', '1'], dir)
    assert.strictEqual(code, 2)
  })
})
