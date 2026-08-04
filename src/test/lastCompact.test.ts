// "How long ago did this project compact?" (src/lastCompact.ts).
//
// Real files, real store format — the reader is the production one, so a change to the bucket
// layout fails here rather than silently returning "no compaction" forever.
//
// What is pinned, in order of how badly each would mislead a caller:
//   1. NOT-FOUND IS NEVER AN AGE. "no compaction on record" must stay its own state; rendering it
//      as 0 would assert the exact opposite (just compacted) to a caller deciding if the prefix
//      is fresh.
//   2. AUTO COUNTS. An auto-compact rewrites the prefix exactly like a typed /compact, so the
//      default answer covers both and names which it found.
//   3. SCOPE IS THE PROJECT. The store is machine-wide; answering with another repo's compaction
//      is the same class of wrong-answer the cache-expiry probe shipped with.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { findLastCompact, cwdUnder, DEFAULT_COMPACT_WINDOW_DAYS } from '../lastCompact'
import { appendHookEvent } from '../hookEventStore'

const NOW = Date.parse('2026-08-04T12:00:00.000Z')
const MINE = '/my/repo'
const OTHER = '/other/repo'

function tmpStore(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-compact-'))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** Write one lifecycle event through the PRODUCTION appender, then stamp its `ts` to `atMs` — the
 *  appender uses receive-time, and these tests need a controlled clock. The bucket the line lands
 *  in is chosen by the append time, and the reader filters buckets by filename date, so the whole
 *  file is rewritten under the correct day's name rather than left in "today". */
function event(dir: string, ev: string, atMs: number, payload: Record<string, unknown>): void {
  const rec = { ts: atMs, ev, session: payload.session_id as string | undefined, payload: { ...payload, hook_event_name: ev } }
  const day = new Date(atMs).toISOString().slice(0, 10)
  fs.appendFileSync(path.join(dir, `${day}.ndjsonl`), `${JSON.stringify(rec)}\n`)
}

function preCompact(dir: string, atMs: number, opts: { cwd: string; trigger: string; session?: string }): void {
  event(dir, 'PreCompact', atMs, {
    session_id: opts.session ?? 'aaaaaaaa-1111-2222-3333-444444444444',
    transcript_path: '/tmp/t.jsonl', cwd: opts.cwd, trigger: opts.trigger,
  })
}

suite('findLastCompact — the delta, and what must never be reported as one', () => {
  test('a never-compacted project is a MISS, never an age of zero', () => {
    const { dir, cleanup } = tmpStore()
    try {
      preCompact(dir, NOW - 60_000, { cwd: OTHER, trigger: 'manual' })
      const r = findLastCompact({ dir, project: MINE, nowMs: NOW })
      assert.strictEqual(r.found, false)
      assert.ok(!('ageMs' in r), 'a miss must carry no age field at all')
      if (!r.found) {
        assert.strictEqual(r.windowDays, DEFAULT_COMPACT_WINDOW_DAYS)
        assert.ok(/NOT "never"/.test(r.reason), `the bound must be stated: ${r.reason}`)
        assert.ok(/install-hooks/.test(r.reason), 'an empty store has an actionable cause')
      }
    } finally { cleanup() }
  })

  test('an AUTO compact counts, and the answer names the trigger', () => {
    const { dir, cleanup } = tmpStore()
    try {
      preCompact(dir, NOW - 2 * 3_600_000 - 14 * 60_000, { cwd: MINE, trigger: 'auto' })
      const r = findLastCompact({ dir, project: MINE, nowMs: NOW })
      assert.strictEqual(r.found, true)
      if (r.found) {
        assert.strictEqual(r.trigger, 'auto')
        assert.strictEqual(r.ageHuman, '2h 14m')
        assert.strictEqual(r.ageSeconds, 2 * 3600 + 14 * 60)
      }
    } finally { cleanup() }
  })

  test('the NEWEST wins across triggers, and --trigger narrows to one', () => {
    const { dir, cleanup } = tmpStore()
    try {
      preCompact(dir, NOW - 3 * 3_600_000, { cwd: MINE, trigger: 'manual', session: 'sess-manual' })
      preCompact(dir, NOW - 30 * 60_000, { cwd: MINE, trigger: 'auto', session: 'sess-auto' })
      const any = findLastCompact({ dir, project: MINE, nowMs: NOW })
      assert.strictEqual(any.found && any.trigger, 'auto', 'the newest compaction wins by default')
      const manual = findLastCompact({ dir, project: MINE, trigger: 'manual', nowMs: NOW })
      assert.strictEqual(manual.found && manual.ageHuman, '3h 0m')
      assert.strictEqual(manual.found && manual.sessionId, 'sess-manual')
    } finally { cleanup() }
  })

  test('another project\'s compaction is NOT this project\'s answer, even when it is newer', () => {
    const { dir, cleanup } = tmpStore()
    try {
      preCompact(dir, NOW - 4 * 3_600_000, { cwd: MINE, trigger: 'manual' })
      preCompact(dir, NOW - 60_000, { cwd: OTHER, trigger: 'manual' })
      const r = findLastCompact({ dir, project: MINE, nowMs: NOW })
      assert.strictEqual(r.found && r.cwd, MINE)
      assert.strictEqual(r.found && r.ageHuman, '4h 0m')
      // The machine-wide question is still answerable — it is just not the default.
      const wide = findLastCompact({ dir, project: null, nowMs: NOW })
      assert.strictEqual(wide.found && wide.cwd, OTHER)
    } finally { cleanup() }
  })

  test('a WORKTREE under the project counts; a sibling sharing the prefix does not', () => {
    const { dir, cleanup } = tmpStore()
    try {
      preCompact(dir, NOW - 10 * 60_000, { cwd: `${MINE}/.claude/worktrees/w1`, trigger: 'auto' })
      preCompact(dir, NOW - 60_000, { cwd: `${MINE}-old`, trigger: 'auto' })
      const r = findLastCompact({ dir, project: MINE, nowMs: NOW })
      assert.strictEqual(r.found && r.ageHuman, '10m 0s', '/my/repo-old must not answer for /my/repo')
      assert.ok(r.found && r.cwd?.includes('worktrees'))
    } finally { cleanup() }
  })

  test('the matching PostCompact yields a completion + duration; its absence yields null, not a guess', () => {
    const { dir, cleanup } = tmpStore()
    try {
      preCompact(dir, NOW - 20 * 60_000, { cwd: MINE, trigger: 'manual', session: 'sess-done' })
      event(dir, 'PostCompact', NOW - 20 * 60_000 + 12_000, { session_id: 'sess-done', cwd: MINE, trigger: 'manual' })
      const done = findLastCompact({ dir, project: MINE, nowMs: NOW })
      assert.strictEqual(done.found && done.durationMs, 12_000)

      const { dir: d2, cleanup: c2 } = tmpStore()
      try {
        preCompact(d2, NOW - 60_000, { cwd: MINE, trigger: 'manual', session: 'sess-inflight' })
        const inflight = findLastCompact({ dir: d2, project: MINE, nowMs: NOW })
        assert.strictEqual(inflight.found && inflight.completedAtMs, null)
        assert.strictEqual(inflight.found && inflight.durationMs, null)
      } finally { c2() }
    } finally { cleanup() }
  })

  test('the window bounds the scan: an older compaction is a miss, not a stale answer', () => {
    const { dir, cleanup } = tmpStore()
    try {
      preCompact(dir, NOW - 10 * 86_400_000, { cwd: MINE, trigger: 'auto' })
      assert.strictEqual(findLastCompact({ dir, project: MINE, windowDays: 3, nowMs: NOW }).found, false)
      assert.strictEqual(findLastCompact({ dir, project: MINE, windowDays: 30, nowMs: NOW }).found, true)
    } finally { cleanup() }
  })

  test('a clock-skewed future stamp clamps to 0 rather than reporting a negative age', () => {
    const { dir, cleanup } = tmpStore()
    try {
      preCompact(dir, NOW + 5_000, { cwd: MINE, trigger: 'auto' })
      const r = findLastCompact({ dir, project: MINE, nowMs: NOW })
      assert.strictEqual(r.found && r.ageMs, 0)
    } finally { cleanup() }
  })

  test('the project filter runs over the WHOLE window, not just the machine-newest record', () => {
    // The trap this pins: asking the store for one record and filtering after would return the
    // machine's newest compaction, discard it as out-of-scope, and report "none" for a project
    // that compacted minutes ago.
    const { dir, cleanup } = tmpStore()
    try {
      for (let i = 0; i < 50; i++) preCompact(dir, NOW - (i + 1) * 60_000, { cwd: OTHER, trigger: 'auto' })
      preCompact(dir, NOW - 5 * 60_000, { cwd: MINE, trigger: 'manual' })
      const r = findLastCompact({ dir, project: MINE, nowMs: NOW })
      assert.strictEqual(r.found && r.ageHuman, '5m 0s')
    } finally { cleanup() }
  })

  test('appendHookEvent-written records are readable by the same finder (format lock)', () => {
    // Guards the store FORMAT, not just this module: production writes through appendHookEvent, so
    // a hand-rolled fixture that drifted from it would let a real regression pass here.
    const { dir, cleanup } = tmpStore()
    try {
      appendHookEvent(dir, { hook_event_name: 'PreCompact', session_id: 'sess-live', cwd: MINE, trigger: 'manual' })
      const r = findLastCompact({ dir, project: MINE })
      assert.strictEqual(r.found, true)
      assert.strictEqual(r.found && r.trigger, 'manual')
      assert.ok(r.found && r.ageSeconds < 5, 'a just-written event must read as seconds old')
    } finally { cleanup() }
  })
})

suite('findLastCompact — symlinked paths (macOS /var → /private/var, and any symlinked checkout)', () => {
  test('a record whose cwd is the SYMLINK form still matches a root resolved to the real path', () => {
    // Caught by the CLI suite before it could ship: mkdtemp hands back /var/…, the CLI resolves
    // --project through realpath to /private/var/…, and a plain string compare reports "never
    // compacted" for a project whose compaction is sitting in the store.
    const { dir, cleanup } = tmpStore()
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'al-symlink-'))
    try {
      const resolved = fs.realpathSync(real)
      preCompact(dir, NOW - 60_000, { cwd: real, trigger: 'auto' })
      const r = findLastCompact({ dir, project: resolved, nowMs: NOW })
      assert.strictEqual(r.found, true, `cwd ${real} must match root ${resolved}`)
      // And the reverse pairing, for a caller that passes the unresolved form.
      const back = findLastCompact({ dir, project: real, nowMs: NOW })
      assert.strictEqual(back.found, true)
    } finally { cleanup(); fs.rmSync(real, { recursive: true, force: true }) }
  })

  test('a cwd that no longer exists is still compared as written, never dropped', () => {
    const { dir, cleanup } = tmpStore()
    try {
      preCompact(dir, NOW - 60_000, { cwd: '/deleted/project', trigger: 'manual' })
      assert.strictEqual(findLastCompact({ dir, project: '/deleted/project', nowMs: NOW }).found, true)
    } finally { cleanup() }
  })
})

suite('cwdUnder — path containment', () => {
  test('at, under, and NOT a prefix-sharing sibling', () => {
    assert.strictEqual(cwdUnder('/my/repo', '/my/repo'), true)
    assert.strictEqual(cwdUnder('/my/repo/', '/my/repo'), true)
    assert.strictEqual(cwdUnder('/my/repo/sub/dir', '/my/repo'), true)
    assert.strictEqual(cwdUnder('/my/repo-old', '/my/repo'), false)
    assert.strictEqual(cwdUnder('/other', '/my/repo'), false)
    assert.strictEqual(cwdUnder(null, '/my/repo'), false)
    assert.strictEqual(cwdUnder(undefined, '/my/repo'), false)
  })
})
