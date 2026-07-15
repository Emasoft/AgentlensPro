import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildDroppedLogEventRecord, appendDroppedLogEvent, purgeLogEventBuckets, logEventsDiskUsage,
  type DroppedLogEventRecord,
} from '../logEventSink'

// ── Log-event sink (TRDD-AMEA4O4Z) — real-filesystem tests ──────────────────
// The sink persists every OTEL log event the rich-event gate rejects (user_prompt,
// assistant_response, tool_decision, hook_execution_*, ...) instead of dropping it. Real tmpdir,
// real appends — the sink IS a filesystem contract, a mocked fs would test nothing.

let seq = 0
function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-les-${process.pid}-${seq++}-`))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function bucketName(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 10)}.ndjsonl`
}

/** Wire-format attribute as both OTLP ingest paths carry it at the gate. */
function wa(key: string, value: Record<string, unknown>): { key: string; value: Record<string, unknown> } {
  return { key, value }
}

suite('logEventSink — buildDroppedLogEventRecord', () => {
  test('flattens wire attrs (string/int/bool), extracts session + trace/span ids + event time + severity', () => {
    const rec = buildDroppedLogEventRecord(
      'claude_code.user_prompt', 'user_prompt',
      [
        wa('session.id', { stringValue: 'sess-1' }),
        wa('prompt_length', { intValue: '42' }),
        wa('redacted', { boolValue: false }),
        wa('prompt', { stringValue: 'hello there' }),
      ],
      { traceId: 'aaaa', spanId: 'bbbb', timeUnixNano: '1752537600000000000', severityText: 'INFO' },
      1_752_537_601_234,
    )
    assert.strictEqual(rec.ts, 1_752_537_601_234)
    assert.strictEqual(rec.ev, 'user_prompt')
    assert.strictEqual(rec.name, 'claude_code.user_prompt')
    assert.strictEqual(rec.session, 'sess-1')
    assert.strictEqual(rec.traceId, 'aaaa')
    assert.strictEqual(rec.spanId, 'bbbb')
    assert.strictEqual(rec.tsEvent, 1_752_537_600_000) // ns → ms
    assert.strictEqual(rec.severity, 'INFO')
    assert.strictEqual(rec.attrs['prompt'], 'hello there')
    assert.strictEqual(rec.attrs['prompt_length'], '42') // OTLP JSON intValue arrives as a string — kept verbatim, lossless
    assert.strictEqual(rec.attrs['redacted'], false)
  })

  test('persists a plain string body; omits the body field for kvlist bodies (already merged into attrs upstream)', () => {
    const withString = buildDroppedLogEventRecord('tool_decision', 'tool_decision', [],
      { body: { stringValue: 'decision: allow' } }, 1)
    assert.strictEqual(withString.body, 'decision: allow')
    const withKv = buildDroppedLogEventRecord('tool_decision', 'tool_decision', [],
      { body: { kvlistValue: { values: [] } } }, 1)
    assert.strictEqual(withKv.body, undefined)
  })

  test('session_id (snake) works; missing ids/times leave the fields absent, never NaN/empty-string', () => {
    const rec = buildDroppedLogEventRecord('plugin_loaded', 'plugin_loaded',
      [wa('session_id', { stringValue: 's-2' })], {}, 5)
    assert.strictEqual(rec.session, 's-2')
    assert.strictEqual(rec.traceId, undefined)
    assert.strictEqual(rec.spanId, undefined)
    assert.strictEqual(rec.tsEvent, undefined)
    assert.strictEqual(rec.severity, undefined)
    assert.strictEqual(rec.body, undefined)
  })
})

suite('logEventSink — append / purge / disk usage', () => {
  test('append writes one JSON line to the day bucket that round-trips to the record; repeated appends accumulate', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const now = Date.now()
      const rec = buildDroppedLogEventRecord('assistant_response', 'assistant_response',
        [wa('session.id', { stringValue: 's-3' })], {}, now)
      const r1 = appendDroppedLogEvent(dir, rec)
      assert.ok(r1.bytes > 0)
      const bucket = path.join(dir, bucketName(now))
      assert.ok(fs.existsSync(bucket))
      appendDroppedLogEvent(dir, rec)
      const lines = fs.readFileSync(bucket, 'utf-8').trim().split('\n')
      assert.strictEqual(lines.length, 2)
      const back = JSON.parse(lines[0]) as DroppedLogEventRecord
      assert.deepStrictEqual(back, JSON.parse(JSON.stringify(rec))) // exact round-trip — nothing lost
    } finally { cleanup() }
  })

  test('purge removes buckets past retention, keeps recent ones, never touches foreign or non-calendar files', () => {
    const { dir, cleanup } = tmpDir()
    try {
      fs.mkdirSync(dir, { recursive: true })
      const old = Date.now() - 40 * 86_400_000
      fs.writeFileSync(path.join(dir, bucketName(old)), '{"ts":1}\n')
      fs.writeFileSync(path.join(dir, bucketName(Date.now())), '{"ts":2}\n')
      fs.writeFileSync(path.join(dir, 'README.txt'), 'not a bucket')
      fs.writeFileSync(path.join(dir, '2026-13-99.ndjsonl'), 'bad date — must never be scanned or purged')
      const r = purgeLogEventBuckets(dir, 31)
      assert.deepStrictEqual(r.removed, [bucketName(old)])
      assert.ok(r.freedBytes > 0)
      assert.ok(fs.existsSync(path.join(dir, bucketName(Date.now()))))
      assert.ok(fs.existsSync(path.join(dir, 'README.txt')))
      assert.ok(fs.existsSync(path.join(dir, '2026-13-99.ndjsonl')))
    } finally { cleanup() }
  })

  test('disk usage counts only bucket files; empty/missing dir reports zero', () => {
    const { dir, cleanup } = tmpDir()
    try {
      assert.deepStrictEqual(logEventsDiskUsage(path.join(dir, 'absent')), { files: 0, bytes: 0 })
      fs.writeFileSync(path.join(dir, bucketName(Date.now())), '{"ts":1}\n')
      fs.writeFileSync(path.join(dir, 'foreign.log'), 'xxxx')
      const u = logEventsDiskUsage(dir)
      assert.strictEqual(u.files, 1)
      assert.ok(u.bytes > 0 && u.bytes < 20)
    } finally { cleanup() }
  })
})
