import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  RETENTION_META, configPath, findMeta, loadRetentionConfig, resolveKnob, resolveKnobWithSource,
  resolveRetention, setRetentionKey,
} from '../retentionConfig'

// A fresh empty DATA_DIR per call so each test is isolated (config.json state never leaks between them).
function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-retcfg-'))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
const spans = findMeta('spansRetentionDays')! // present by construction; the meta table is the source of truth

suite('retentionConfig (TRDD-ZAV74M8Q — persistent, discoverable retention config)', () => {
  test('RETENTION_META has 6 knobs with unique keys and env names', () => {
    // The single source of truth both server and CLI read — a duplicate key/env would silently shadow.
    assert.strictEqual(RETENTION_META.length, 6)
    assert.strictEqual(new Set(RETENTION_META.map((m) => m.key)).size, 6)
    assert.strictEqual(new Set(RETENTION_META.map((m) => m.env)).size, 6)
    for (const m of RETENTION_META) assert.ok(m.def >= m.min, `${m.key} default must be ≥ its min`)
    // TRDD-AMEA4O4Z: the log-event sink's retention knob must exist with the documented default.
    const le = RETENTION_META.find((m) => m.key === 'logEventsRetentionDays')
    assert.ok(le, 'logEventsRetentionDays knob missing')
    assert.strictEqual(le.env, 'AGENTLENS_LOG_EVENTS_RETENTION_DAYS')
    assert.strictEqual(le.def, 31)
  })

  test('precedence: env var wins over file wins over default', () => {
    const file = { spansRetentionDays: 10 }
    // default (nothing set)
    assert.deepStrictEqual(resolveKnobWithSource(spans, {}, {}), { value: 30, source: 'default' })
    // file over default
    assert.deepStrictEqual(resolveKnobWithSource(spans, file, {}), { value: 10, source: 'file' })
    // env over file
    assert.deepStrictEqual(
      resolveKnobWithSource(spans, file, { AGENTLENS_SPANS_RETENTION_DAYS: '99' }),
      { value: 99, source: 'env' },
    )
  })

  test('min floor is applied to env, file, and default alike', () => {
    // spansRetentionDays min is 1; a below-min value from any source is floored, not trusted verbatim.
    assert.strictEqual(resolveKnob(spans, { spansRetentionDays: -5 }, {}), 1)
    assert.strictEqual(resolveKnob(spans, {}, { AGENTLENS_SPANS_RETENTION_DAYS: '0' }), 1)
    // bodiesMaxGb has a fractional min (0.5) — a smaller file value floors to 0.5.
    const gb = findMeta('bodiesMaxGb')!
    assert.strictEqual(resolveKnob(gb, { bodiesMaxGb: 0.1 }, {}), 0.5)
    assert.strictEqual(resolveKnob(gb, { bodiesMaxGb: 4 }, {}), 4)
  })

  test('a non-numeric or empty env value is ignored (falls through to file/default)', () => {
    // Number('') === 0 and Number('abc') === NaN — neither may be treated as a real override.
    assert.deepStrictEqual(resolveKnobWithSource(spans, { spansRetentionDays: 12 }, { AGENTLENS_SPANS_RETENTION_DAYS: '' }), { value: 12, source: 'file' })
    assert.deepStrictEqual(resolveKnobWithSource(spans, {}, { AGENTLENS_SPANS_RETENTION_DAYS: 'abc' }), { value: 30, source: 'default' })
  })

  test('loadRetentionConfig is fail-soft: missing file, corrupt JSON, and bad values all yield safe results', () => {
    const { dir, cleanup } = tmpDir()
    try {
      // Missing file → {}
      assert.deepStrictEqual(loadRetentionConfig(dir), {})
      // Corrupt JSON → {} (never crashes boot)
      fs.writeFileSync(configPath(dir), '{ this is not json', 'utf-8')
      assert.deepStrictEqual(loadRetentionConfig(dir), {})
      // Non-numeric / non-finite knob values are dropped; only valid numbers survive.
      fs.writeFileSync(configPath(dir), JSON.stringify({ retention: { spansRetentionDays: 'x', summaryWindowHours: 5, bodiesMaxGb: null } }), 'utf-8')
      assert.deepStrictEqual(loadRetentionConfig(dir), { summaryWindowHours: 5 })
    } finally { cleanup() }
  })

  test('resolveRetention resolves all 6 knobs at once (defaults when nothing set)', () => {
    const { dir, cleanup } = tmpDir()
    try {
      assert.deepStrictEqual(resolveRetention(dir, {}), {
        spansRetentionDays: 30, summaryWindowHours: 24, bodiesMaxAgeHours: 72, bodiesMaxGb: 8, bodiesRetentionDays: 31,
        logEventsRetentionDays: 31, // TRDD-AMEA4O4Z — the log-event sink's bucket lifetime
      })
    } finally { cleanup() }
  })

  test('resolveRetention layers env over the on-disk file', () => {
    const { dir, cleanup } = tmpDir()
    try {
      setRetentionKey(dir, 'spansRetentionDays', 7)
      setRetentionKey(dir, 'bodiesMaxGb', 2)
      const r = resolveRetention(dir, { AGENTLENS_SPANS_RETENTION_DAYS: '90' })
      assert.strictEqual(r.spansRetentionDays, 90) // env wins
      assert.strictEqual(r.bodiesMaxGb, 2)         // file wins over default
      assert.strictEqual(r.summaryWindowHours, 24) // untouched default
    } finally { cleanup() }
  })

  test('setRetentionKey persists atomically and the file is valid JSON afterwards', () => {
    const { dir, cleanup } = tmpDir()
    try {
      setRetentionKey(dir, 'spansRetentionDays', 45)
      const raw = fs.readFileSync(configPath(dir), 'utf-8')
      assert.deepStrictEqual(JSON.parse(raw), { retention: { spansRetentionDays: 45 } })
      assert.ok(!fs.existsSync(`${configPath(dir)}.tmp`), 'the temp file is renamed away, not left behind')
    } finally { cleanup() }
  })

  test('setRetentionKey PRESERVES other retention keys and any non-retention top-level keys', () => {
    const { dir, cleanup } = tmpDir()
    try {
      // A pre-existing config with an unrelated top-level section the CLI must not destroy.
      fs.writeFileSync(configPath(dir), JSON.stringify({ someOtherTool: { x: 1 }, retention: { spansRetentionDays: 5 } }), 'utf-8')
      setRetentionKey(dir, 'summaryWindowHours', 12)
      const obj = JSON.parse(fs.readFileSync(configPath(dir), 'utf-8'))
      assert.deepStrictEqual(obj.someOtherTool, { x: 1 }, 'unrelated section preserved')
      assert.deepStrictEqual(obj.retention, { spansRetentionDays: 5, summaryWindowHours: 12 }, 'both knobs present')
    } finally { cleanup() }
  })

  test('setRetentionKey rejects a below-min value and an unknown key (fail-fast, no write)', () => {
    const { dir, cleanup } = tmpDir()
    try {
      assert.throws(() => setRetentionKey(dir, 'spansRetentionDays', 0), /must be ≥ 1/)
      assert.throws(() => setRetentionKey(dir, 'bogusKey' as never, 5), /unknown retention key/)
      assert.throws(() => setRetentionKey(dir, 'spansRetentionDays', Number.NaN), /finite number/)
      assert.ok(!fs.existsSync(configPath(dir)), 'nothing was written on any rejected set')
    } finally { cleanup() }
  })

  test('setRetentionKey REFUSES to write when the existing file is corrupt — never clobbers it', () => {
    // The load-bearing anti-regression: a "start fresh on parse failure" path once wiped a real
    // 57.8KB settings.json. setRetentionKey must throw and leave the corrupt file byte-for-byte intact.
    const { dir, cleanup } = tmpDir()
    try {
      const corrupt = '{ "retention": { OOPS not json'
      fs.writeFileSync(configPath(dir), corrupt, 'utf-8')
      assert.throws(() => setRetentionKey(dir, 'spansRetentionDays', 9))
      assert.strictEqual(fs.readFileSync(configPath(dir), 'utf-8'), corrupt, 'corrupt file left untouched')
    } finally { cleanup() }
  })
})
