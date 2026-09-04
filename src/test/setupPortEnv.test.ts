import * as assert from 'assert'
import { resolveCtx } from '../cli/setup'
import { alcoreServeArgs } from '../cli/serverControl'

// TRDD-99HUNXJS acceptance box 2: "a test table asserting all three sites agree on
// ['', '   ', 'abc', '0', '-1', '65536', '80.5', '3e3', '8080/evil']".
//
// THE INVARIANT, first, because it is the one thing that must survive every future edit:
// **the oracle must never be a call to the code under test.** The 2026-09-03 version of this
// file asserted `resolveCtx().uiPort === Number(envPort(raw, 3000))` while `resolveCtx` IS
// `Number(envPort(process.env.UI_PORT, 3000))` (setup.ts:114) — f(x) === f(x), green for every
// input AND every possible body of `envPort`. Stub the parser to `return '9999'` and all nine
// rows passed. That is what got acceptance box 2 checked.

const VARS = [
  { env: 'UI_PORT', field: 'uiPort', flag: '--ui-port', fallback: 3000 },
  { env: 'MCP_PORT', field: 'mcpPort', flag: '--mcp-port', fallback: 4316 },
  { env: 'OTLP_PORT', field: 'otlpPort', flag: '--otlp-port', fallback: 4318 },
] as const

type PortVar = (typeof VARS)[number]['env']
const PORT_VARS: readonly PortVar[] = VARS.map(v => v.env)

// Rejected -> that variable's OWN fallback. `Number('')` is 0 and `Number('8080/evil')` is NaN;
// both must fall back rather than bind port 0 or inject a path into a URL.
//
// The expected column pins `envPort`'s fallback-on-malformed semantics, which TRDD-BSDR4TRM
// ratified and TRDD-99HUNXJS's STATE block explicitly declined to re-litigate. If that decision
// is ever revisited (refuse-and-exit instead of fallback) these rows are SUPPOSED to go red —
// update them alongside the decision; do not soften the oracle back into a call.
const REJECTED = ['', '   ', 'abc', '0', '-1', '65536', '80.5', '8080/evil']

// Accepted -> the number itself, regardless of that variable's fallback.
const ACCEPTED: Array<[string, number]> = [
  ['8080', 8080], // positive control: a table of nothing but fallbacks is satisfied by a parser
  //                 that ignores its argument entirely, so one valid input must survive intact.
  ['3e3', 3000], // see the note below — accepted today, not necessarily correctly.
  ['1', 1], // boundary: with '0'/'-1' above, the only rows exercising `n > 0`.
  ['65535', 65535], // boundary: with '65536' above, the only rows exercising `n < 65536`.
]

// `3e3` is ACCEPTED, not rejected: `Number('3e3')` is 3000, an integer in range. On UI_PORT that
// is indistinguishable from the 3000 fallback, which is why the row is also checked on MCP_PORT
// and OTLP_PORT — there, accepted yields 3000 and rejected would yield 4316/4318, so those two
// rows are the ones carrying information.
//
// Whether it SHOULD be accepted is NOT settled, and this row is a record of today's behaviour,
// not an endorsement of it. Measured: `envPort` also accepts '0x1F80' -> 8064, '0b11' -> 3 and
// '+8080' -> 8080, because it delegates to bare `Number()`. A `/^\d+$/` guard would reject all
// of them. That is a behaviour change to a ratified parser, so it is TRDD-EGGERLEO, not this
// card. If EGGERLEO lands, this row moves to REJECTED.

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

/** The port `alcoreServeArgs` would hand the spawned server for `flag`. Reads the argv it builds
 *  rather than re-deriving it, so this really is the other site's answer. */
function spawnedPort(flag: string): number {
  const argv = alcoreServeArgs(process.env, '/tmp/agentlenspro-test-data')
  const i = argv.indexOf(flag)
  // Turns a renamed/missing flag into a named failure instead of Number(undefined) -> NaN and a
  // baffling inequality.
  assert.ok(i >= 0 && i + 1 < argv.length, `alcoreServeArgs did not pass ${flag}`)
  return Number(argv[i + 1])
}

suite('port env vars resolve identically at every site (TRDD-99HUNXJS)', () => {
  for (const { env, field, flag, fallback } of VARS) {
    const rows: Array<[string, number]> = [
      ...REJECTED.map((raw): [string, number] => [raw, fallback]),
      ...ACCEPTED,
    ]

    for (const [raw, expected] of rows) {
      test(`${env}=${JSON.stringify(raw)} -> ${expected} at both setup and the spawn path`, () => {
        withPortEnv({ [env]: raw }, () => {
          const ctx = resolveCtx({ home: '/tmp/agentlenspro-test-home', repoRoot: process.cwd() })

          // 1. LITERAL — hardcoded expected value, so a regression INSIDE the parser fails here.
          //    This is the assertion a computed oracle structurally could not make.
          assert.strictEqual(ctx[field], expected, `resolveCtx().${field}`)

          // 2. CROSS-SITE — what `alcoreServeArgs` actually hands the spawned server. Be precise
          //    about what this does and does not catch: both sides call `envPort`, so under a
          //    stubbed parser every cross-site assertion stays GREEN (they move together). It
          //    catches WIRING drift — a site that stops calling `envPort` (which is exactly the
          //    original TRDD-99HUNXJS bug: `Number(process.env.UI_PORT ?? 3000)`), a transposed
          //    variable name, or a fallback constant changed in one file only. Parser regressions
          //    are assertion 1's job, not this one's.
          assert.strictEqual(spawnedPort(flag), expected, `alcoreServeArgs ${flag}`)
        })
      })
    }

    test(`an unset ${env} resolves to the documented default ${fallback} at both sites`, () => {
      withPortEnv({}, () => {
        const ctx = resolveCtx({ home: '/tmp/agentlenspro-test-home', repoRoot: process.cwd() })
        assert.strictEqual(ctx[field], fallback)
        assert.strictEqual(spawnedPort(flag), fallback)
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
