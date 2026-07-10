import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { groupStallEpisodes, buildRateLimitReport } from '../rateLimitReport'
import type { HookEventRecord } from '../hookEventStore'

// ── get_rate_limit_report (TRDD-O981ZJKV item 12) ────────────────────────────

const NOW = Date.now()

function ev(ts: number, session: string, cwd = '/Users/x/Code/agentlens', error = '429 rate_limit_error: exceeded'): HookEventRecord {
  return { ts, ev: 'StopFailure', session, payload: { hook_event_name: 'StopFailure', session_id: session, cwd, error } }
}

let seq = 0
function hookStore(events: HookEventRecord[]): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-rl-${process.pid}-${seq++}-`))
  for (const e of events) {
    const day = new Date(e.ts).toISOString().slice(0, 10)
    fs.appendFileSync(path.join(dir, `${day}.ndjsonl`), `${JSON.stringify(e)}\n`)
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

suite('rateLimitReport — groupStallEpisodes', () => {
  test('events ≤10min apart form ONE episode; a bigger gap splits', () => {
    const eps = groupStallEpisodes([
      ev(NOW - 60 * 60_000, 's1'),
      ev(NOW - 55 * 60_000, 's2'),      // 5min after → same episode
      ev(NOW - 10 * 60_000, 's1'),      // 45min later → new episode
    ])
    assert.strictEqual(eps.length, 2)
    assert.strictEqual(eps[0].events, 2)
    assert.strictEqual(eps[0].sessions.length, 2, 'distinct sessions recorded')
    assert.strictEqual(eps[1].events, 1)
  })

  test('a session appearing twice in one episode is listed once, error head kept', () => {
    const eps = groupStallEpisodes([ev(NOW - 60_000, 's1'), ev(NOW - 30_000, 's1')])
    assert.strictEqual(eps.length, 1)
    assert.strictEqual(eps[0].sessions.length, 1)
    assert.ok(eps[0].sessions[0].error?.startsWith('429'), String(eps[0].sessions[0].error))
    assert.strictEqual(eps[0].sessions[0].cwd, '/Users/x/Code/agentlens')
  })
})

suite('rateLimitReport — buildRateLimitReport (real fs)', () => {
  test('no events: explicit note naming --install-hooks, never an empty guess', () => {
    const { dir, cleanup } = hookStore([])
    try {
      const r = buildRateLimitReport({ hookEventsDir: dir, now: NOW }) as { stallEvents: number; note: string }
      assert.strictEqual(r.stallEvents, 0)
      assert.ok(r.note.includes('--install-hooks'), r.note)
    } finally { cleanup() }
  })

  test('episodes newest-first; ONLY the newest is deep-attributed with a 5h window ending at its start', () => {
    const { dir, cleanup } = hookStore([
      ev(NOW - 6 * 3600e3, 'old-s'),
      ev(NOW - 20 * 60_000, 'new-s1'),
      ev(NOW - 18 * 60_000, 'new-s2'),
    ])
    const calls: Array<{ windowHours?: number; untilMs?: number; maxFiles?: number }> = []
    try {
      const r = buildRateLimitReport({
        hookEventsDir: dir, now: NOW,
        investigate: (o) => { calls.push(o ?? {}); return { verdict: 'stub' } },
      }) as { episodes: Array<{ startIso: string; events: number }>; attributed: { episodeStartIso: string; investigation: { verdict: string } } }
      assert.strictEqual(r.episodes.length, 2)
      assert.strictEqual(r.episodes[0].events, 2, 'newest episode first')
      assert.strictEqual(calls.length, 1, 'exactly one deep attribution')
      assert.strictEqual(calls[0].windowHours, 5)
      assert.strictEqual(calls[0].untilMs, Date.parse(r.episodes[0].startIso), 'window ENDS at the newest stall')
      assert.strictEqual(r.attributed.investigation.verdict, 'stub')
    } finally { cleanup() }
  })

  test('an attribution crash degrades to an explicit error, never kills the report', () => {
    const { dir, cleanup } = hookStore([ev(NOW - 60_000, 's1')])
    try {
      const r = buildRateLimitReport({
        hookEventsDir: dir, now: NOW,
        investigate: () => { throw new Error('bodies dir exploded') },
      }) as { episodes: unknown[]; attributed: { error?: string } }
      assert.strictEqual(r.episodes.length, 1)
      assert.ok(r.attributed.error?.includes('bodies dir exploded'))
    } finally { cleanup() }
  })
})
