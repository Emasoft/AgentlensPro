import * as assert from 'assert'
import { resolveCtx } from '../cli/setup'
import { alcoreServeArgs } from '../cli/serverControl'

// TRDD-99HUNXJS acceptance box 2: "a test table asserting all three sites agree on
// ['', '   ', 'abc', '0', '-1', '65536', '80.5', '3e3', '8080/evil']".
//
// The FIRST version of this file asserted `resolveCtx().uiPort === Number(envPort(raw, 3000))`.
// That assertion could not fail. `resolveCtx` IS `Number(envPort(process.env.UI_PORT, 3000))`
// (setup.ts:114), so the oracle was the subject: replace `envPort`'s body with `return '9999'`
// and all nine rows stayed green. A nine-row table of scary-looking inputs made it read as
// rigorous, which is worse than no table at all — it is what got acceptance box 2 checked.
//
// Two properties are asserted here instead, and NEITHER calls `envPort`:
//
//   1. LITERAL — each raw value maps to a hardcoded expected port. This catches a regression in
//      the parser itself, which a computed oracle structurally cannot.
//   2. CROSS-SITE — `resolveCtx` (which builds setup's health-check/status URLs) and
//      `alcoreServeArgs` (the argv the spawned server actually binds) are asked the same
//      question and must give the same answer. This is the "sites agree" half, and it is the
//      bug the card is about: the two disagreeing is what sent status to port 0 while the
//      server bound 3000.
//
// Do not "simplify" either oracle back into a call to `envPort`. That is the defect this file
// was rewritten to remove.

const FALLBACK = { UI_PORT: 3000, MCP_PORT: 4316, OTLP_PORT: 4318 } as const
type PortVar = keyof typeof FALLBACK

const CTX_FIELD = { UI_PORT: 'uiPort', MCP_PORT: 'mcpPort', OTLP_PORT: 'otlpPort' } as const
const ARG_FLAG = { UI_PORT: '--ui-port', MCP_PORT: '--mcp-port', OTLP_PORT: '--otlp-port' } as const

// Rejected -> that variable's OWN fallback. `Number('')` is 0 and `Number('8080/evil')` is NaN;
// both must fall back rather than bind port 0 or inject a path into a URL.
const REJECTED = ['', '   ', 'abc', '0', '-1', '65536', '80.5', '8080/evil']

// Accepted -> the number itself, regardless of that variable's fallback.
//
// `3e3` is the row that earns its place. It is ACCEPTED, not rejected: `Number('3e3')` is 3000,
// an integer in range. On UI_PORT that is indistinguishable from the 3000 fallback — which is
// exactly why it is also checked on MCP_PORT and OTLP_PORT, where "accepted" yields 3000 and
// "rejected" would yield 4316/4318. Without those two, the card's own table has a row whose
// outcome no assertion can distinguish.
//
// `8080` is the positive control. A table of nothing but fallbacks is satisfied by a parser that
// ignores its argument entirely, so at least one valid input must survive unchanged.
const ACCEPTED: Array<[string, number]> = [
  ['8080', 8080],
  ['3e3', 3000],
  ['1', 1],
  ['65535', 65535],
]

const PORT_VARS: PortVar[] = ['UI_PORT', 'MCP_PORT', 'OTLP_PORT']

/** Set exactly the three port vars for the duration of `fn`, restoring whatever was there.
 *  All three are always captured, so an ambient MCP_PORT in the developer's shell cannot leak
 *  into a case that only names UI_PORT. */
function withPortEnv(vars: Partial<Record<PortVar, string>>, fn: () => void) {
  const saved: Partial<Record<PortVar, string | undefined>> = {}
  for (const k of PORT_VARS) saved[k] = process.env[k]
  try {
    for (const k of PORT_VARS) {
      const v = vars[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fn()
  } finally {
    for (const k of PORT_VARS) {
      const v = saved[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** The port `alcoreServeArgs` would hand the spawned server for `v`. Reads the argv it builds
 *  rather than re-deriving it, so this is genuinely the other site's answer. */
function spawnedPort(v: PortVar): number {
  const argv = alcoreServeArgs(process.env, '/tmp/agentlenspro-test-data')
  const i = argv.indexOf(ARG_FLAG[v])
  assert.ok(i >= 0 && i + 1 < argv.length, `alcoreServeArgs did not pass ${ARG_FLAG[v]}`)
  return Number(argv[i + 1])
}

suite('port env vars resolve identically at every site (TRDD-99HUNXJS)', () => {
  for (const v of PORT_VARS) {
    const rows: Array<[string, number]> = [
      ...REJECTED.map((raw): [string, number] => [raw, FALLBACK[v]]),
      ...ACCEPTED,
    ]

    for (const [raw, expected] of rows) {
      test(`${v}=${JSON.stringify(raw)} -> ${expected} at both setup and the spawn path`, () => {
        withPortEnv({ [v]: raw }, () => {
          const ctx = resolveCtx({ home: '/tmp/agentlenspro-test-home', repoRoot: process.cwd() })
          assert.strictEqual(ctx[CTX_FIELD[v]], expected, `resolveCtx().${CTX_FIELD[v]}`)
          assert.strictEqual(spawnedPort(v), expected, `alcoreServeArgs ${ARG_FLAG[v]}`)
        })
      })
    }

    test(`an unset ${v} resolves to the documented default ${FALLBACK[v]} at both sites`, () => {
      withPortEnv({}, () => {
        const ctx = resolveCtx({ home: '/tmp/agentlenspro-test-home', repoRoot: process.cwd() })
        assert.strictEqual(ctx[CTX_FIELD[v]], FALLBACK[v])
        assert.strictEqual(spawnedPort(v), FALLBACK[v])
      })
    })
  }

  test('an explicit opts port still wins over the env var', () => {
    withPortEnv({ UI_PORT: '9999', MCP_PORT: '9998', OTLP_PORT: '9997' }, () => {
      const ctx = resolveCtx({
        home: '/tmp/agentlenspro-test-home',
        repoRoot: process.cwd(),
        uiPort: 1234,
        mcpPort: 1235,
        otlpPort: 1236,
      })
      assert.strictEqual(ctx.uiPort, 1234)
      assert.strictEqual(ctx.mcpPort, 1235)
      assert.strictEqual(ctx.otlpPort, 1236)
    })
  })
})
