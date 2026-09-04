import * as assert from 'assert'
import { resolveCtx } from '../cli/setup'
import { envPort } from '../cli/cliCore'

// TRDD-99HUNXJS: `setup.ts` used to parse UI_PORT/MCP_PORT/OTLP_PORT with a bare
// `Number(process.env.X ?? default)` — `Number('')` is 0, so an empty env var silently bound
// health-check/status URLs to a kernel-assigned port while the real server (serverControl.ts,
// same `envPort`) fell back to its documented default. `resolveCtx` now shares `envPort` with
// the spawn path; this asserts they agree on the exact malformed-input table the card names.

suite('setup ctx port resolution shares envPort with the spawn path (TRDD-99HUNXJS)', () => {
  const BAD_VALUES = ['', '   ', 'abc', '0', '-1', '65536', '80.5', '3e3', '8080/evil']

  function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const saved: Record<string, string | undefined> = {}
    for (const k of Object.keys(vars)) saved[k] = process.env[k]
    try {
      for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      fn()
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  }

  for (const bad of BAD_VALUES) {
    test(`UI_PORT=${JSON.stringify(bad)} resolves to the same port envPort would give the spawn path`, () => {
      withEnv({ UI_PORT: bad, MCP_PORT: undefined, OTLP_PORT: undefined }, () => {
        const ctx = resolveCtx({ home: '/tmp/al-test-home', repoRoot: process.cwd() })
        assert.strictEqual(ctx.uiPort, Number(envPort(bad, 3000)))
      })
    })
  }

  test('an unset UI_PORT resolves to the documented default 3000', () => {
    withEnv({ UI_PORT: undefined }, () => {
      const ctx = resolveCtx({ home: '/tmp/al-test-home', repoRoot: process.cwd() })
      assert.strictEqual(ctx.uiPort, 3000)
    })
  })

  test('an explicit opts.uiPort still wins over the env var', () => {
    withEnv({ UI_PORT: '' }, () => {
      const ctx = resolveCtx({ home: '/tmp/al-test-home', repoRoot: process.cwd(), uiPort: 9999 })
      assert.strictEqual(ctx.uiPort, 9999)
    })
  })
})
