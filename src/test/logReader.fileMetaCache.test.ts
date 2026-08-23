// TRDD-OCNHOHE9 — collectFileMeta() is a full recursive readdir+stat of every session file.
// reparseSession() re-ran it from scratch on EVERY call; a 12-session probe loop (the cache-expiry
// newest-session heuristic) therefore paid 12 redundant full walks for one boolean answer. This
// asserts the walk happens ONCE for a multi-session reparse burst, not N times.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader } from '../logReader'

const sessionBody = (cwd: string, prompt: string): string =>
  JSON.stringify({ type: 'user', timestamp: '2026-07-14T10:00:00.000Z', cwd, message: { content: prompt } }) + '\n' +
  JSON.stringify({
    type: 'assistant', timestamp: '2026-07-14T10:00:01.000Z', cwd,
    message: {
      id: 'msg-1', model: 'claude-sonnet-4-5',
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'ok' }],
    },
  }) + '\n'

suite('LogReader — reparseSession() must not re-walk the whole log tree on every call', function (this: Mocha.Suite) {
  // SUITE-level, deliberately — a per-test `this.timeout()` does NOT cover hooks, and the hook is
  // what fails first here. The corpus-side test below writes 6000 files and `teardown()` rmSync's
  // that tree; on the slow CI filesystem this budget exists for, a test-level timeout leaves the
  // teardown on mocha's 10s default, so the test PASSES and then the run fails in
  // `"after each" hook` with no mention of the stamp, the walk, or 6000 files. Verified: with a
  // per-test timeout of 30000 and `--timeout 50`, the body passed and the hook failed with
  // "Timeout of 50ms exceeded". Suite scope covers the tests AND their hooks.
  // VERIFIED IN BOTH DIRECTIONS, because "the hook stopped failing" and "the suite value reaches
  // the hook" are the same thing under mocha's scoping and different things under "measured":
  //   negative — per-test 30000 + `--timeout 50`: body passed, `"after each" hook ... Timeout of
  //              50ms exceeded`. A test's timeout does not cover its hooks.
  //   positive — suite `this.timeout(1)`: `"after each" hook ... Timeout of 1ms exceeded`. The
  //              suite value DOES reach the hook. NOTE that run exited 2, not 1: at a 1ms budget
  //              the test BODY times out as well (it writes 6000 files), so unlike the negative
  //              control this one does not ISOLATE the hook — the hook line is unambiguous
  //              evidence on its own, but the run is not a clean single-failure observation.
  // NOTE it also raises the other three tests in this suite from the .mocharc 10s default, so a
  // hang in any of them now takes 30s to surface. Accepted: they are sub-second tests, and one
  // timeout at the covering scope beats two at different ones.
  this.timeout(30000)

  let root = ''
  let savedClaudeDir: string | undefined

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-filemetacache-'))
    fs.mkdirSync(path.join(root, 'projects', 'proj'), { recursive: true })
    savedClaudeDir = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = root
  })

  teardown(() => {
    if (savedClaudeDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = savedClaudeDir
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('reparsing several sessions back-to-back triggers exactly ONE directory walk, not one per session', () => {
    const cwd = path.join(root, 'workspace')
    const ids = ['sess-a', 'sess-b', 'sess-c', 'sess-d']
    for (const id of ids) {
      fs.writeFileSync(path.join(root, 'projects', 'proj', `${id}.jsonl`), sessionBody(cwd, `prompt-${id}`))
    }

    const r = new LogReader()
    assert.strictEqual(r.getFileMetaWalkCount(), 0, 'no walk has happened yet')

    for (const id of ids) {
      const result = r.reparseSession(id)
      assert.ok(result, `reparseSession must resolve ${id} to its file`)
      assert.ok(result?.card.userRequest?.includes(`prompt-${id}`), `card content must match ${id}`)
    }

    // THE ASSERTION: 4 reparseSession() calls => 1 real walk (memoized), not 4.
    assert.strictEqual(r.getFileMetaWalkCount(), 1,
      `expected exactly 1 directory walk across ${ids.length} reparseSession() calls, got ${r.getFileMetaWalkCount()}`)
  })

  // TRDD-ZFX0MPYZ — the CPU profile of the live runaway put 36.6% of main-thread busy time under
  // handleCheckCacheExpiry, and its hottest leaf chain was
  //   statSync <- collectFileMeta <- transcriptPathFor <- getLastRequestMs
  // i.e. the probe reaches collectFileMeta through transcriptPathFor, NOT through reparseSession.
  // The test above pins the reparseSession path only, so this hot path was unguarded: a change
  // that made transcriptPathFor bypass or defeat the memo would cost one full recursive
  // readdir+stat of EVERY session file per probe candidate (14,509 files on the machine where
  // this was measured) and no test would go red.
  //
  // FALSIFIED TWO WAYS before being trusted (a green test proves nothing about its teeth):
  //   1. FILE_META_CACHE_TTL_MS = 0  -> red, "got 5"  (memo ABSENT)
  //   2. a 2500ms stall inside the walk, TTL left at 2000 -> red, "got 5"  (memo DEFEATED)
  // (2) is the regression that arrives on its own rather than by someone's edit: `collectFileMeta`
  // stamps `_fileMetaCacheAt` with a timestamp taken BEFORE the walk, so the cache's usable life
  // is `TTL - walkDuration` and collapses to nothing once a walk outlives its TTL. Measured
  // 820ms against a 2000ms budget at 14,509 files — so this fires on corpus growth alone, and
  // when it does the memo does not degrade, it disappears: 5 candidates cost 5 full walks.
  test('a transcriptPathFor probe burst triggers at most ONE directory walk, not one per candidate', () => {
    const cwd = path.join(root, 'workspace')
    const ids = ['probe-a', 'probe-b', 'probe-c', 'probe-d', 'probe-e']
    for (const id of ids) {
      fs.writeFileSync(path.join(root, 'projects', 'proj', `${id}.jsonl`), sessionBody(cwd, `prompt-${id}`))
    }

    const r = new LogReader()
    assert.strictEqual(r.getFileMetaWalkCount(), 0, 'no walk has happened yet')

    for (const id of ids) {
      assert.ok(r.transcriptPathFor(id)?.endsWith(`${id}.jsonl`), `transcriptPathFor must resolve ${id} to its file`)
    }

    // THE ASSERTION: N candidates => AT MOST 1 real walk. The intent is "no O(all-files) rescan
    // per candidate", NOT "a walk must happen" — <= rather than === deliberately, so a future
    // design that eliminates the walk entirely (an id index built at write time, or per-request
    // scoping) PASSES instead of being blocked by a guard that pinned the old mechanism. The
    // correctness assertions above are what stop 0 walks from meaning "returned nothing".
    assert.ok(r.getFileMetaWalkCount() <= 1,
      `expected at most 1 directory walk across ${ids.length} transcriptPathFor() calls, got ${r.getFileMetaWalkCount()}`)

    // A miss must not walk either — an unresolvable id scans the SAME memoized listing.
    const walksBeforeMiss = r.getFileMetaWalkCount()
    assert.strictEqual(r.transcriptPathFor('no-such-session'), null, 'unknown id resolves to null')
    assert.strictEqual(r.getFileMetaWalkCount(), walksBeforeMiss, 'a lookup MISS must not trigger a fresh walk')
  })

  // TRDD-ZFX0MPYZ — the SETTLING test for the post-walk-stamp fix, and the reason it is not the one
  // the review proposed. That proposal was `FILE_META_CACHE_TTL_MS = 1` with no stall, on the 5-file
  // fixture above, on the argument that "any real walk exceeds 1ms". Measured, it does not: a real
  // readdir+stat over 5 files ON THIS DISK is 0.04-0.09ms, so the entry is NOT born expired, the OLD
  // code passes too, and the test is vacuous — which under the proposal's own stated criterion
  // ("green on both means the mechanism story is wrong") would have argued the bug away. Measured
  // walk times here: n=5 0.04-0.09ms, n=200 0.47-1.26ms, n=1000 2.5-3.6ms, n=3000 8.9-9.6ms.
  // "Vacuous" there is a property of THIS machine, not of that design: on a loaded container or a
  // cold spinning disk 5 files could exceed 1ms and it would suddenly have teeth. That is not a
  // rescue — a test whose meaning flips with machine speed is the same flakiness problem in
  // different clothes — but the corpus-side design below is what makes the margin explicit and
  // checkable instead of leaving it to the hardware.
  //
  // What this test does instead: reach `walkDuration > TTL` from the CORPUS side, with NO injected
  // stall anywhere. 6000 files walk in ~17-20ms against a 3ms TTL, so the born-expired condition is real
  // rather than manufactured — which is what the other guard's 2500ms stall could not establish,
  // since inflating the walk and then moving the stamp past it share one primitive and the
  // experiment therefore could not fail.
  //
  // It also refuses to pass vacuously: it MEASURES the walk and asserts it really did exceed the
  // TTL. On a machine fast enough that 6000 files walk in under 3ms this goes RED with "raise N"
  // instead of green-and-meaningless. That guard is stronger than it first looks — it also means the
  // OLD code can never pass SILENTLY here, because a walk fast enough not to be born-expired trips
  // the precondition before the walk-count assertion is ever reached.
  //
  // MARGIN, stated because a passing run prints nothing and an unstated margin is unfalsifiable:
  // the measured quantity is the first walk on a fresh reader, which is IDENTICAL code on both
  // paths, so the red-path figures characterise the green path too — 27.6-31.6ms against a 6ms bar
  // (TTL x 2), i.e. ~4.6-5.3x. The lookups on the other side of the inequality run ~0.02ms.
  test('a real walk slower than the TTL still yields a usable memo (no injected stall)', () => {
    // 6000 writes + the walk + a 6000-file teardown is 1.3-1.7s on local NVMe, but many-small-file
    // I/O on a CI overlayfs commonly runs several times slower against mocha's 10s default. The
    // budget that covers it is at SUITE level (see the top of this file) because it must cover the
    // teardown hook too.
    const cwd = path.join(root, 'workspace')
    // N=6000, not 3000: at 3000 the mocha-measured walk ranged 3.4-15.4ms across runs as the page
    // cache warmed, and the low end left only 1.15x over a 3ms TTL — enough to make the precondition
    // fire spuriously in CI. 6000 doubles the floor without approaching mocha's 10s timeout.
    const N = 6000
    const body = sessionBody(cwd, 'bulk')
    for (let i = 0; i < N; i++) {
      fs.writeFileSync(path.join(root, 'projects', 'proj', `bulk-${i}.jsonl`), body)
    }

    // The ids are the NEWEST files, deliberately. Entries come back sorted newest-first, so these hit
    // the front of the array and each lookup is O(1)-ish. Probing the OLDEST ids instead makes every
    // lookup a full 3000-entry scan, and six of those outran a 3ms TTL and forced a SECOND walk on
    // the fixed code — a real measurement of the lookup cost, misreadable as a failure of the stamp.
    const ids = Array.from({ length: 6 }, (_, k) => `bulk-${N - 1 - k}`)

    // TTL sits well under the walk's WARM floor, not under its cold time. Repeat runs warm the page
    // cache: the same 3000-file walk measured 15.4ms cold and 6.9ms warm, and an 8ms TTL landed
    // inside that variance band — the precondition below caught it as "does not exceed the TTL"
    // rather than letting the run pass on a technicality. 3ms keeps ~2x margin against the warm floor.
    const TTL_MS = 3
    const saved = (LogReader as unknown as { FILE_META_CACHE_TTL_MS: number }).FILE_META_CACHE_TTL_MS
    ;(LogReader as unknown as { FILE_META_CACHE_TTL_MS: number }).FILE_META_CACHE_TTL_MS = TTL_MS
    try {
      const r = new LogReader()

      const t0 = Number(process.hrtime.bigint())
      assert.ok(r.transcriptPathFor(ids[0]!), 'first lookup resolves')
      const firstMs = (Number(process.hrtime.bigint()) - t0) / 1e6
      assert.strictEqual(r.getFileMetaWalkCount(), 1, 'the first lookup must perform the one real walk')

      // PRECONDITION, not a result: if the walk is not actually slower than the TTL, this test
      // reproduces nothing and must say so rather than pass.
      //
      // The estimator is the FIRST call's own elapsed time, deliberately, and not the earlier
      // `firstMs - cachedMs`. That subtraction assumed the second call is a cached lookup — which is
      // true only on the FIXED code. Under the pre-walk stamp the second call walks too, so the two
      // terms cancel and the estimate collapses toward zero: falsification runs reported walks of
      // 1.85ms and 4.25ms for the same corpus and failed the precondition instead of the assertion,
      // i.e. red for the wrong reason. `firstMs` is walk + one lookup, and the lookup is O(1) here
      // (newest-first ids hit the front of the array), so it is walk plus microseconds on EITHER
      // code path. The 2x margin covers that residue without needing to measure it.
      assert.ok(firstMs > TTL_MS * 2,
        `precondition failed — first lookup took ${firstMs.toFixed(2)}ms, not comfortably above the ` +
        `${TTL_MS}ms TTL, so "born expired" is not reproduced and this test proves nothing (raise N above ${N})`)

      const tL = Number(process.hrtime.bigint())
      for (const id of ids.slice(1)) {
        assert.ok(r.transcriptPathFor(id), `lookup resolves ${id}`)
      }
      const lookupsMs = (Number(process.hrtime.bigint()) - tL) / 1e6

      // SECOND PRECONDITION — the walk-count assertion below depends on TWO inequalities, and
      // guarding only the first is how a guard gets believed for something it did not show:
      //   (i)  walkDuration > TTL          — asserted above; without it nothing is born expired
      //   (ii) time(these lookups) < TTL   — THIS; without it the memo expires from lookup cost
      // (ii) is not hypothetical: probing the OLDEST ids at TTL=3ms produced "got 2" on the FIXED
      // code, because each lookup was a full N-entry scan. That was measured, not imagined. Leaving
      // it unasserted means a later lookup-cost regression (an fs call added to _sessionIdForFile, a
      // sort-order change that stops newest ids landing at the front, a slow runner) fails as
      // "expected 1 walk ... got 2" — which reads as THE STAMP FIX REGRESSED and would send someone
      // to re-open a closed bug. A comment cannot prevent that misreading; an assertion can.
      assert.ok(lookupsMs < TTL_MS / 2,
        `precondition failed — ${ids.length - 1} lookups took ${lookupsMs.toFixed(2)}ms against a ` +
        `${TTL_MS}ms TTL, so a miss here would measure LOOKUP cost, not the stamp`)

      // THE ASSERTION: with the stamp taken AFTER the walk, a walk that outlives its own TTL still
      // produces a memo the following lookups hit. With the pre-walk stamp every one of these 6
      // lookups re-walked (6, not 1) — the cache was expired the instant it was written.
      assert.strictEqual(r.getFileMetaWalkCount(), 1,
        `expected 1 walk across ${ids.length} lookups with a ${firstMs.toFixed(2)}ms walk vs a ${TTL_MS}ms TTL, ` +
        `got ${r.getFileMetaWalkCount()}`)
    } finally {
      ;(LogReader as unknown as { FILE_META_CACHE_TTL_MS: number }).FILE_META_CACHE_TTL_MS = saved
    }
  })

  test('clearFileState() drops the walk cache so a forced rescan sees newly written files', () => {
    const cwd = path.join(root, 'workspace')
    fs.writeFileSync(path.join(root, 'projects', 'proj', 'sess-1.jsonl'), sessionBody(cwd, 'prompt-1'))

    const r = new LogReader()
    assert.ok(r.reparseSession('sess-1'), 'first session resolves')
    assert.strictEqual(r.getFileMetaWalkCount(), 1)

    fs.writeFileSync(path.join(root, 'projects', 'proj', 'sess-2.jsonl'), sessionBody(cwd, 'prompt-2'))
    // Without clearFileState this would still be served from the (still-fresh) TTL cache and miss
    // sess-2 — clearFileState is the explicit "force fresh" escape hatch used by the debug rescan.
    r.clearFileState()
    assert.ok(r.reparseSession('sess-2'), 'new session resolves after clearFileState()')
    assert.strictEqual(r.getFileMetaWalkCount(), 2, 'clearFileState() must force a second real walk')
  })
})
