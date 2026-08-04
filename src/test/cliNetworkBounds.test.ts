import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'

// TRDD-M8SV6LK5 (the audit's CROSS-FILE half) — every network call in src/cli must be BOUNDED.
//
// This is the property the delegated per-file review structurally cannot check: the externalizer
// sees 1–5 files per request, so "is this true across all 27 files, and will it stay true" is
// invisible to it. It is also the property that just cost the most: `rpc()` and `apiRequest()` sat
// unbounded for the life of the CLI and produced a 75-second stall on a verb documented to answer
// with the server DOWN (TRDD-E8XIC2PM). Every OTHER call site was already bounded — which is exactly
// why nobody looked at those two.
//
// So the guard is a whole-directory scan, not a per-file assertion: a NEW call site with no bound is
// the recurrence this audit exists to prevent, and it must fail here rather than be found by a user
// whose machine hangs.

const CLI_DIR = path.join(__dirname, '..', '..', '..', 'src', 'cli')

/** How a call site can be bounded. `armConnectDeadline` is cliCore's own helper (a connect deadline,
 *  deliberately not a request timeout — a legitimate call can be slow SERVER-side). */
const BOUND_MARKERS = ['AbortSignal.timeout', '.setTimeout(', 'armConnectDeadline', 'signal:']
const CALL_SITE = /\b(?:fetch\(|https?\.request\()/

suite('src/cli: every network call is bounded (TRDD-M8SV6LK5 — the cross-file half)', () => {
  test('no call site can hang the process waiting for an address that never answers', () => {
    const files = fs.readdirSync(CLI_DIR).filter(f => f.endsWith('.ts'))
    assert.ok(files.length >= 20, `expected the CLI sources, found ${files.length}`)

    const unbounded: string[] = []
    let sitesChecked = 0
    for (const f of files) {
      const lines = fs.readFileSync(path.join(CLI_DIR, f), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return
        if (!CALL_SITE.test(line)) return
        sitesChecked += 1
        // The bound may sit in the options object, on the request handle a few lines below, or in
        // the helper the call is wrapped in — so look at the surrounding block, not one line.
        const window = lines.slice(Math.max(0, i - 12), i + 25).join('\n')
        if (!BOUND_MARKERS.some(m => window.includes(m))) unbounded.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`)
      })
    }

    assert.ok(sitesChecked >= 4, `the scanner found ${sitesChecked} call sites — it has stopped matching, which would make this test vacuous`)
    assert.deepStrictEqual(unbounded, [],
      'unbounded network call(s) — an address that DROPS will hang the command:\n  ' + unbounded.join('\n  '))
  })

  test('the two shared transports carry the bound themselves, so callers inherit it', () => {
    // Named explicitly: these are what every diagnostics verb goes through, and both were the
    // unbounded ones. If the marker disappears from either, the scan above still passes for every
    // CALLER while the whole surface silently regresses.
    const core = fs.readFileSync(path.join(CLI_DIR, 'cliCore.ts'), 'utf8')
    assert.ok(/function armConnectDeadline/.test(core), 'cliCore must own a connect deadline helper')
    for (const fn of ['export function rpc', 'export function apiRequest']) {
      const start = core.indexOf(fn)
      assert.ok(start > 0, `${fn} not found — this test is pinned to the wrong symbols`)
      const body = core.slice(start, start + 2_000)
      assert.ok(body.includes('armConnectDeadline'), `${fn} must arm the connect deadline`)
    }
  })
})
