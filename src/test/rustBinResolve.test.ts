// src/test/rustBinResolve.test.ts — the third opt-in channel for the Rust binaries
// (TRDD-EAK9R8IY): resolving `alcore`/`alstore`/`alscan`/`allogscan` out of `bin-native/` INSIDE
// the one `agentlenspro` package a plain `npm i -g agentlenspro` installs.

import * as assert from 'assert'
import * as path from 'path'
import { npmPlatformBin } from '../rustBinResolve'

const BASE = '/fake/pkg/bin-native'

suite('rustBinResolve — in-package bin-native/ resolution', () => {
  test('unsupported platform/arch: nothing is shipped for it, the filesystem is never touched', () => {
    let called = false
    const result = npmPlatformBin('alcore', 'freebsd-x64', () => { called = true; return true }, BASE)
    assert.strictEqual(result, null)
    assert.strictEqual(called, false, 'a platform with no shipped binaries must short-circuit')
  })

  test('supported platform, binary present and executable: returns bin-native/<platform-arch>/<name>', () => {
    const result = npmPlatformBin('alcore', 'darwin-arm64',
      (p) => {
        assert.strictEqual(p, path.join(BASE, 'darwin-arm64', 'alcore'))
        return true
      }, BASE)
    assert.strictEqual(result, path.join(BASE, 'darwin-arm64', 'alcore'))
  })

  test('supported platform, binary absent (dev checkout, or bin-native/ pruned): null, never throws', () => {
    const result = npmPlatformBin('alcore', 'linux-x64', () => false, BASE)
    assert.strictEqual(result, null)
  })

  test('present but NOT executable reads as not shipped — the x-bit is lost by zip/artifact round-trips, and a non-executable binary must fall back rather than fail deep inside a spawn', () => {
    const result = npmPlatformBin('alstore', 'linux-arm64', () => false, BASE)
    assert.strictEqual(result, null)
  })

  test('every rust*Bin resolver name (alcore/alstore/alscan/allogscan) maps through the same layout', () => {
    for (const name of ['alcore', 'alstore', 'alscan', 'allogscan']) {
      const seen: string[] = []
      npmPlatformBin(name, 'linux-arm64', (p) => { seen.push(p); return true }, BASE)
      assert.deepStrictEqual(seen, [path.join(BASE, 'linux-arm64', name)])
    }
  })

  test('the real default probe is a genuine X_OK check: a directory is not an executable file', () => {
    // No injected predicate — exercises isExecutableFile against a path that exists but is a dir.
    const result = npmPlatformBin('.', 'darwin-arm64', undefined, path.dirname(__dirname))
    assert.strictEqual(result, null)
  })
})
