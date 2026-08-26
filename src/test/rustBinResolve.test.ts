// src/test/rustBinResolve.test.ts — the third opt-in channel for the Rust binaries
// (TRDD-EAK9R8IY): resolving `alcore`/`alstore`/`alscan`/`allogscan` out of the
// `agentlenspro-<platform>` optionalDependency a plain `npm i -g agentlenspro` installs.

import * as assert from 'assert'
import { npmPlatformBin } from '../rustBinResolve'

suite('rustBinResolve — npm platform package fallback', () => {
  test('unsupported platform/arch: no package for it, resolve is never even attempted', () => {
    let called = false
    const result = npmPlatformBin('alcore', 'freebsd-x64', () => { called = true; return '/should/not/happen' })
    assert.strictEqual(result, null)
    assert.strictEqual(called, false, 'a platform with no agentlenspro-<platform> entry must short-circuit')
  })

  test('supported platform, binary present: returns the resolved path', () => {
    const result = npmPlatformBin('alcore', 'darwin-arm64',
      (id) => {
        assert.strictEqual(id, 'agentlenspro-darwin-arm64/bin/alcore')
        return '/fake/node_modules/agentlenspro-darwin-arm64/bin/alcore'
      })
    assert.strictEqual(result, '/fake/node_modules/agentlenspro-darwin-arm64/bin/alcore')
  })

  test('supported platform, binary absent (--omit=optional stripped it, or a MODULE_NOT_FOUND): falls back to null, never throws', () => {
    const result = npmPlatformBin('alcore', 'linux-x64', () => {
      throw Object.assign(new Error("Cannot find module 'agentlenspro-linux-x64/bin/alcore'"), { code: 'MODULE_NOT_FOUND' })
    })
    assert.strictEqual(result, null)
  })

  test('every rust*Bin resolver name (alcore/alstore/alscan/allogscan) maps through the same platform table', () => {
    for (const name of ['alcore', 'alstore', 'alscan', 'allogscan']) {
      const seen: string[] = []
      npmPlatformBin(name, 'linux-arm64', (id) => { seen.push(id); return `/fake/${id}` })
      assert.deepStrictEqual(seen, [`agentlenspro-linux-arm64/bin/${name}`])
    }
  })
})
