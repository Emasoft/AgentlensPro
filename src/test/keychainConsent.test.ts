import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  KEYCHAIN_ENV, KEYCHAIN_KEY, keychainConsentWithSource, keychainReadAllowed, loadKeychainConsent,
  setKeychainConsent,
} from '../keychainConsent'

// ── Keychain consent — real config.json on a real tmp dir ────────────────────
// The bug this module fixes is not a wrong value, it is a value that DISAPPEARS: consent lived only
// in AGENTLENS_READ_KEYCHAIN_USAGE, so any restart that did not carry it silently revoked the
// opt-in and the account-usage archive stopped refreshing while its rows kept ageing. The test that
// matters is therefore "consent survives with NO environment at all".

let seq = 0
function tmpDataDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-keychain-${process.pid}-${seq++}-`))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')) as Record<string, unknown>
}

suite('keychainConsent — a decision that survives a restart', () => {
  test('defaults to OFF: reading a credential store is never started on the user behalf', () => {
    const { dir, cleanup } = tmpDataDir()
    try {
      const { allowed, source } = keychainConsentWithSource(dir, {})
      assert.strictEqual(allowed, false)
      assert.strictEqual(source, 'default')
    } finally { cleanup() }
  })

  test('persisted consent holds with NO environment — the whole point of the fix', () => {
    const { dir, cleanup } = tmpDataDir()
    try {
      setKeychainConsent(dir, true)
      // An empty env is exactly what a hook-spawned or launchd-revived server gets.
      assert.strictEqual(keychainReadAllowed(dir, {}), true)
      assert.strictEqual(keychainConsentWithSource(dir, {}).source, 'file')
    } finally { cleanup() }
  })

  test('env wins over the file, in BOTH directions', () => {
    const { dir, cleanup } = tmpDataDir()
    try {
      setKeychainConsent(dir, false)
      assert.strictEqual(keychainReadAllowed(dir, { [KEYCHAIN_ENV]: '1' }), true, 'env on beats file off')
      setKeychainConsent(dir, true)
      assert.strictEqual(keychainReadAllowed(dir, { [KEYCHAIN_ENV]: 'off' }), false, 'env off beats file on')
    } finally { cleanup() }
  })

  test('a typo in the env variable is NOT consent — it falls through to the file', () => {
    const { dir, cleanup } = tmpDataDir()
    try {
      setKeychainConsent(dir, false)
      assert.strictEqual(keychainReadAllowed(dir, { [KEYCHAIN_ENV]: 'yess' }), false)
      assert.strictEqual(keychainConsentWithSource(dir, { [KEYCHAIN_ENV]: 'yess' }).source, 'file')
      // and with no file either, a typo lands on the safe default rather than enabling
      const fresh = tmpDataDir()
      try {
        assert.strictEqual(keychainReadAllowed(fresh.dir, { [KEYCHAIN_ENV]: 'sure' }), false)
      } finally { fresh.cleanup() }
    } finally { cleanup() }
  })

  test('writing consent PRESERVES every other key in config.json', () => {
    const { dir, cleanup } = tmpDataDir()
    try {
      fs.writeFileSync(path.join(dir, 'config.json'),
        JSON.stringify({ spansRetentionDays: 45, capture: { rawBodies: true, spoolDir: '/Volumes/X' } }, null, 2))
      setKeychainConsent(dir, true)
      const cfg = readConfig(dir)
      assert.strictEqual(cfg.spansRetentionDays, 45, 'retention knob survived')
      assert.deepStrictEqual(cfg.capture, { rawBodies: true, spoolDir: '/Volumes/X' }, 'capture section survived')
      assert.deepStrictEqual(cfg.usage, { [KEYCHAIN_KEY]: true })
    } finally { cleanup() }
  })

  test('THROWS on an existing non-JSON config instead of clobbering it', () => {
    const { dir, cleanup } = tmpDataDir()
    try {
      const p = path.join(dir, 'config.json')
      fs.writeFileSync(p, 'not json — a user edited this by hand\n')
      assert.throws(() => setKeychainConsent(dir, true))
      assert.strictEqual(fs.readFileSync(p, 'utf-8'), 'not json — a user edited this by hand\n',
        'the unparseable file is untouched — a "start fresh" writer once destroyed a real settings file')
    } finally { cleanup() }
  })

  test('leaves no .tmp behind — the write is temp+rename, not in place', () => {
    const { dir, cleanup } = tmpDataDir()
    try {
      setKeychainConsent(dir, true)
      const strays = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
      assert.deepStrictEqual(strays, [])
    } finally { cleanup() }
  })

  test('a corrupt config reads as "no persisted consent", never as a crash', () => {
    const { dir, cleanup } = tmpDataDir()
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), '{ truncated')
      assert.strictEqual(loadKeychainConsent(dir), undefined)
      assert.strictEqual(keychainReadAllowed(dir, {}), false, 'falls to the safe default')
    } finally { cleanup() }
  })

  test('a non-boolean persisted value is ignored rather than coerced', () => {
    const { dir, cleanup } = tmpDataDir()
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ usage: { [KEYCHAIN_KEY]: 'yes' } }))
      assert.strictEqual(loadKeychainConsent(dir), undefined, '"yes" is not a boolean — not consent')
      assert.strictEqual(keychainReadAllowed(dir, {}), false)
    } finally { cleanup() }
  })
})
