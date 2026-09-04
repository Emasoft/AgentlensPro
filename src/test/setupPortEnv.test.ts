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
const ACCEPTED_TODAY: Array<[string, number]> = [
  ['8080', 8080], // positive control: a table of nothing but fallbacks is satisfied by a parser
  //                 that ignores its argument entirely, so one valid input must survive intact.
  ['3e3', 3000], // ACCEPTED_TODAY (Number('3e3') === 3000). Only carries information on MCP/OTLP, where
  //                accepted (3000) differs from the fallback. Whether it SHOULD be: TRDD-EGGERLEO.
  ['1', 1], // boundary: with '0'/'-1' above, the only rows exercising `n > 0`.
  ['65535', 65535], // boundary: with '65536' above, the only rows exercising `n < 65536`.
]

/** Set exactly the named port vars for the duration of `fn`, clearing the others and restoring
 *  all three afterwards — so an ambient MCP_PORT in the developer's shell cannot leak into a case
 *  that only names UI_PORT.
 *
 *  Takes TUPLES, not an object, because a computed key erases the type constraint: with
 *  `Partial<Record<PortVar, string>>`, `{ [someString]: v }` compiles and `{ LITERAL_TYPO: v }`
 *  does not — so the object form silently accepts a key `PORT_VARS` then ignores, i.e. a typo
 *  yields a test that sets nothing and still passes. Verified with tsc: the computed-key case
 *  raises no error, the literal-key case raises TS2353. A tuple's element type IS checked. */
function withPortEnv(set: ReadonlyArray<readonly [PortVar, string]>, fn: () => void) {
  const saved = PORT_VARS.map(k => [k, process.env[k]] as const)
  try {
    for (const k of PORT_VARS) delete process.env[k]
    for (const [k, v] of set) process.env[k] = v
    fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** The port `alcoreServeArgs` would hand the spawned server for `flag`. Reads the argv it builds
 *  rather than re-deriving it, so this really is the other site's answer.
 *
 *  `alcoreServeArgs` calls `findMediaDir()`, which resolves here via its third candidate
 *  (`../../../media`, present for the `out/test/cli/` layout) against `media/index.html` —
 *  TRACKED source, so this works on a fresh clone with no build. An `out/` depth change would
 *  break it; a missing bundle would not. */
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
      ...ACCEPTED_TODAY,
    ]

    for (const [raw, expected] of rows) {
      test(`${env}=${JSON.stringify(raw)} -> ${expected} at both setup and the spawn path`, () => {
        withPortEnv([[env, raw]], () => {
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
      withPortEnv([], () => {
        const ctx = resolveCtx({ home: '/tmp/agentlenspro-test-home', repoRoot: process.cwd() })
        assert.strictEqual(ctx[field], fallback)
        assert.strictEqual(spawnedPort(flag), fallback)
      })
    })
  }

  test('an explicit opts port still wins over the env var', () => {
    withPortEnv([['UI_PORT', '9999'], ['MCP_PORT', '9998'], ['OTLP_PORT', '9997']], () => {
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
