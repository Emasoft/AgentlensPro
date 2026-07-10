import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadHookRuntimeConfig, saveHookRuntimeConfig, HOOK_CONFIG_DEFAULTS } from '../hookRuntimeConfig'

// ── realtime hook switches (TRDD-O981ZJKV follow-on) — real-fs tests ─────────

let seq = 0
function tmpFile(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-hookcfg-${process.pid}-${seq++}-`))
  return { file: path.join(dir, 'hook-config.json'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

suite('hookRuntimeConfig — load/save (TRDD-O981ZJKV)', () => {
  test('absent file: defaults, env AGENTLENS_GATE_MODE honored as the pre-file default', () => {
    const { file, cleanup } = tmpFile()
    try {
      assert.deepStrictEqual(loadHookRuntimeConfig(file, undefined), HOOK_CONFIG_DEFAULTS)
      assert.strictEqual(loadHookRuntimeConfig(file, 'warn').gateMode, 'warn')
    } finally { cleanup() }
  })

  test('save merges a partial patch, persists atomically, and round-trips', () => {
    const { file, cleanup } = tmpFile()
    try {
      const applied = saveHookRuntimeConfig(file, HOOK_CONFIG_DEFAULTS, { gateEnabled: false, gateMode: 'warn' })
      assert.strictEqual(applied.gateEnabled, false)
      assert.strictEqual(applied.gateMode, 'warn')
      assert.strictEqual(applied.captureEnabled, true, 'untouched keys keep their value')
      const back = loadHookRuntimeConfig(file, undefined)
      assert.deepStrictEqual(back, applied, 'the file wins over env once saved')
      assert.strictEqual(loadHookRuntimeConfig(file, 'enforce').gateMode, 'warn', 'env must NOT override the file')
    } finally { cleanup() }
  })

  test('junk values never brick the hooks: unknown keys ignored, bad types fall back', () => {
    const { file, cleanup } = tmpFile()
    try {
      const applied = saveHookRuntimeConfig(file, HOOK_CONFIG_DEFAULTS, {
        gateMode: 'yolo', captureEnabled: 'maybe', totallyUnknown: 42,
      })
      assert.strictEqual(applied.gateMode, 'enforce', 'invalid mode keeps the current one')
      assert.strictEqual(applied.captureEnabled, true, 'non-boolean falls back')
      assert.strictEqual((applied as unknown as Record<string, unknown>).totallyUnknown, undefined)
    } finally { cleanup() }
  })

  test('unparseable file degrades to defaults instead of crashing the server boot', () => {
    const { file, cleanup } = tmpFile()
    try {
      fs.writeFileSync(file, '{ truncated mid-wri')
      assert.deepStrictEqual(loadHookRuntimeConfig(file, undefined), HOOK_CONFIG_DEFAULTS)
    } finally { cleanup() }
  })
})
