// Tests of the interrupted-turn review of agentlenspro-review-mod (TRDD-ISEF8YO7, TRDD-M62ZBT7E).
//
// Path under test: an aborted main turn (turn.complete with isAborted) -> the 1.5 s timer -> the interrupted-turn
// review -> classic.SessionStart -> a main-thread classic.Stop, whose display file must carry the held box under the
// heading "interrupted turn HH:MM". The one-line row the review prints at once is checked too.
//
// Nothing real runs: no model, no process (the agentlenspro CLI and git are stubbed), and no file is written. An
// unstubbed mods API call skips the calling hook WITHOUT failing the test, so every `$.` call the mod can make on this
// path has a stub in rig(), and each stub records its name in `called`, which the tests compare with ON_PATH.
// `$.state` (atom, read, update) is answered by the kit itself. The kit does not empty `$.state` when a test fires
// classic.SessionStart, whatever its source; a real /clear, /resume or /branch does.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = '/nonexistent/agentlenspro-review-mod-test'
const SESSION = 'test-session-1'
const ENVELOPE = { session_id: SESSION, transcript_path: `${CWD}/transcript.jsonl`, cwd: CWD }
const DISPLAY_NAME = `/.claude/tmp/agentlenspro-review-mod/${SESSION}.txt`
const HELD = { plugin: 'agentlenspro-review-mod', key: 'heldInterrupted' } as const
// The heading of a held box in the Stop display. The time is the real clock's, not the mock clock's.
const HEADING = /^interrupted turn \d{2}:\d{2}$/m
// On claude-opus-5 (5 / 0.5 / 25 USD per MTok for input / cache read / output) this usage costs exactly $0.0040.
const USAGE = { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 }
const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const USAGE_TEXT = 'cost $0.0040 · in 100 · out 100 · cache r 2,000 / w 0'
const PASS_REPORT = 'VERDICT: PASS\nNOT-DO: none\nWRONG-IF: none\nWEAKEST LINK: none — SETTLE WITH: none'
const BLOCK_REPORT = `VERDICT: BLOCK\n1. [BLOCKER] the edit was not checked — no run shown — run it\n${PASS_REPORT.split('\n').slice(1).join('\n')}`
// The stubbed calls a review that ends with a report makes between the aborted turn and the end of the next Stop.
const ON_PATH = ['process.run agentlenspro review-gate', 'process.run git', 'model.fork', 'session.model', 'fs.exists', 'fs.write']
// What a review that gets no report adds: the fallback completion and the deferral count.
const DEFER_PATH = [...ON_PATH, 'session.messages', 'model.complete', 'store.get', 'store.set']

type Rig = {
  clock: MockClock
  // Every stubbed mods API call the mod made, by name, in order.
  called: string[]
  // The $.ui.log rows the user sees (to: transcript), in order.
  rows: string[]
  // Every text written to the Stop display file, in order: one per main-thread Stop.
  displays: string[]
  forkPrompts: string[]
  // Set by a test to make the reads or the writes of the held-box state value fail.
  refuse: { get: boolean; set: boolean }
  // Set by a test to answer the reads of the held-box state value with its initial value, as after the reset of $.state
  // that the mods documentation gives for /clear, /resume and /branch (the kit itself does not reset it).
  isReset: boolean
  // Set by a test to make the scan of a Stop find work, so that the Stop reviews its own turn (one fork).
  stopHasWork: boolean
  // Milliseconds on the mock clock before the next forks answer, one entry per fork, first in first out; none = at once.
  forkDelays: number[]
  // Every value the mod wrote under the held-box state key, in order. The element type is spelled out here, so the
  // type-check fails if types/index.d.ts declares another shape for that key.
  heldWrites: { at: string; lines: string[] }[][]
}

// reviewText null = the fork and the fallback completion both answer with no text: a review that makes its model
// calls and gets no report.
function rig(on: On, reviewText: string | null): Rig {
  const seen: Rig = { clock: mock.clock(on), called: [], rows: [], displays: [], forkPrompts: [], refuse: { get: false, set: false }, isReset: false, stopHasWork: false, forkDelays: [], heldWrites: [] }
  // Events the mod passes on with next(e).
  on('turn.complete', () => ({ text: '' }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('process.run', ($, e) => {
    const ran = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'agentlenspro' && e.argv[1] === 'review-gate') {
      seen.called.push('process.run agentlenspro review-gate')
      // The scan of the interrupted turn passes --ignore-interrupt-floor and finds work; the scan of a Stop finds none,
      // unless the test set stopHasWork.
      const isInterruptedScan = e.argv.includes('--ignore-interrupt-floor')
      return ran(0, JSON.stringify({
        scan: { readable: true },
        work: isInterruptedScan ? { index: 3, cause: 'edit', detail: 'Edit src/a.ts' } : seen.stopHasWork ? { index: 7, cause: 'edit', detail: 'Edit src/b.ts' } : null,
        proposal: false,
        proposalIndex: -1,
        reasons: [],
        options: { ignoreInterruptFloor: isInterruptedScan },
      }))
    }
    if (e.argv[0] === 'git') {
      seen.called.push('process.run git')
      return ran(1, '')
    }
    // Any other program is off the path; the name it leaves in `called` fails the ON_PATH check.
    seen.called.push(`process.run ${e.argv.join(' ')}`)
    return ran(127, '')
  })
  on('model.fork', async ($, e) => {
    seen.called.push('model.fork')
    seen.forkPrompts.push(String(e.prompt))
    // A test makes a fork answer late by queueing its delay: the answer comes when the mock clock has moved that far.
    const delay = seen.forkDelays.shift() ?? 0
    if (delay > 0) await seen.clock.sleep(delay)
    return reviewText === null
      ? { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: NO_USAGE } }
      : { value: { isAnswered: true as const, text: reviewText, usage: USAGE } }
  })
  on('model.complete', () => {
    seen.called.push('model.complete')
    return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: NO_USAGE } }
  })
  on('session.messages', () => {
    seen.called.push('session.messages')
    return { value: [] }
  })
  on('session.model', () => {
    seen.called.push('session.model')
    return { value: 'claude-opus-5' }
  })
  on('session.id', () => {
    seen.called.push('session.id')
    return { value: SESSION }
  })
  on('session.cwd', () => {
    seen.called.push('session.cwd')
    return { value: CWD }
  })
  on('ui.log', ($, e) => {
    if (e.to !== 'debug') seen.rows.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('fs.exists', () => {
    seen.called.push('fs.exists')
    return { value: true }
  })
  on('fs.write', ($, e) => {
    seen.called.push('fs.write')
    if (e.path.endsWith(DISPLAY_NAME)) seen.displays.push(e.text)
    return { value: undefined }
  })
  on('fs.read', () => {
    seen.called.push('fs.read')
    return { value: '' }
  })
  on('store.get', () => {
    seen.called.push('store.get')
    return { value: undefined }
  })
  on('store.set', () => {
    seen.called.push('store.set')
    return { value: undefined }
  })
  // The kit answers $.state beneath these two. While a test asks for it, the first refuses the read of the held-box value or
  // answers it with the initial value (isReset), and the second refuses its write.
  on('state.get', HELD, ($, e, next) => (seen.refuse.get ? { deny: 'refused by the test' } : seen.isReset ? { value: { value: [], version: 0 } } : next(e)))
  on('state.set', HELD, ($, e, next) => {
    if (seen.refuse.set) return { deny: 'refused by the test' }
    seen.heldWrites.push(e.value)
    return next(e)
  })
  return seen
}

// One main turn the user cut short, then the timer that reviews it. Resolves once the review has run to its end.
async function interruptAndReview($: Engine, seen: Rig, turnId = 'turn-1'): Promise<void> {
  await $.classic.UserPromptSubmit({ ...ENVELOPE, prompt: 'edit src/a.ts' })
  await $.turn.complete({ turnId, answer: '', durationMs: 900, isAborted: true, reason: 'aborted' })
  await seen.clock.advance(1500)
}

// One main-thread Stop; resolves to the text the mod wrote to the display file for it (what hooks/show.py prints).
async function stopDisplay($: Engine, seen: Rig): Promise<string> {
  const before = seen.displays.length
  await $.classic.Stop({ ...ENVELOPE, stop_hook_active: false })
  // Exactly one display write per Stop: none means the mod's classic.Stop hook was skipped or threw.
  expect(seen.displays.length).toBe(before + 1)
  return seen.displays[before] ?? ''
}

const offPath = (seen: Rig, allowed: readonly string[]) => seen.called.filter((name) => !allowed.includes(name))

test('the held box of a reviewed interrupted turn survives a compaction and is shown at the next main Stop', async ($, on) => {
  const seen = rig(on, PASS_REPORT)
  await interruptAndReview($, seen)
  // The review ran to its end: one fork, and one row for the user (whatever the wording of the row).
  expect(seen.forkPrompts.length).toBe(1)
  expect(seen.rows.filter((row) => row.startsWith('review-mod: ')).length).toBe(1)

  // A compaction between the review and the next Stop: classic.SessionStart fires with source compact.
  await $.classic.SessionStart({ ...ENVELOPE, source: 'compact' })
  const shown = await stopDisplay($, seen)

  // THE HEADING ASSERTION (TRDD-ISEF8YO7): the box the row promised is in the Stop display.
  expect(shown).toMatch(HEADING)
  const lines = shown.split('\n')
  // The heading leads, the report follows it, and the usage box closes the block.
  expect(HEADING.test(lines[0] ?? '')).toBe(true)
  expect(lines).toContain('[AGENTLENSPRO-REVIEW-REPORT] (run by the harness, interrupted turn)')
  expect(lines).toContain('VERDICT: PASS')
  expect(lines.some((line) => line.includes('╭'))).toBe(true)
  expect(lines.some((line) => line.includes('REVIEW TURN'))).toBe(true)
  // Shown once: the next Stop has nothing held.
  expect(await stopDisplay($, seen)).not.toMatch(HEADING)
  expect(offPath(seen, ON_PATH)).toEqual([])
})

test('control: with no compaction in between, the box is shown at the next main Stop', async ($, on) => {
  const seen = rig(on, PASS_REPORT)
  await interruptAndReview($, seen)
  expect(seen.forkPrompts.length).toBe(1)
  expect(await stopDisplay($, seen)).toMatch(HEADING)
  expect(offPath(seen, ON_PATH)).toEqual([])
})

test('the row of a finished review says so in plain words, with the verdict before the cost (PASS)', async ($, on) => {
  const seen = rig(on, PASS_REPORT)
  await interruptAndReview($, seen)
  expect(seen.rows).toEqual([`review-mod: review of the interrupted turn finished: PASS · ${USAGE_TEXT} · report and usage box after the next completed reply`])
})

test('the row of a finished review says so in plain words, with the verdict before the cost (BLOCK)', async ($, on) => {
  const seen = rig(on, BLOCK_REPORT)
  await interruptAndReview($, seen)
  expect(seen.rows).toEqual([`review-mod: review of the interrupted turn finished: BLOCK (the agent gets the findings with the next prompt) · ${USAGE_TEXT} · report and usage box after the next completed reply`])
})

test('a review that made its calls and got no report is worded REVIEW DEFERRED, never as finished', async ($, on) => {
  const seen = rig(on, null)
  await interruptAndReview($, seen)
  expect(seen.rows).toEqual([
    'REVIEW DEFERRED to the next stop (not dropped): interrupted turn: fork: empty-reply; completion: empty-reply',
    'review-mod: REVIEW DEFERRED, the review of the interrupted turn did not finish (reason in the row above) · cost $0.0000 · in 0 · out 0 · cache r 0 / w 0 · usage box after the next completed reply',
  ])
  // Its usage box is still held and shown: the heading, then the box at once, with no report between them. The Stop that
  // shows it reviews the deferred work itself and gets no answer either (the stubbed fork never has one), so its own
  // rows follow the held box.
  const shown = await stopDisplay($, seen)
  const lines = shown.split('\n')
  expect(HEADING.test(lines[0] ?? '')).toBe(true)
  expect((lines[1] ?? '').includes('╭')).toBe(true)
  expect(shown).not.toMatch(/VERDICT:/)
  expect(offPath(seen, DEFER_PATH)).toEqual([])
})

test('/clear, /resume and /branch drop a held box and say so in one row', async ($, on) => {
  const seen = rig(on, PASS_REPORT)
  const ends = [['clear', '/clear'], ['resume', '/resume'], ['fork', '/branch']] as const
  for (const [source, command] of ends) {
    await interruptAndReview($, seen, `turn-${source}`)
    await $.classic.SessionStart({ ...ENVELOPE, source })
    expect(seen.rows[seen.rows.length - 1]).toBe(`review-mod: 1 held interrupted-turn report(s) dropped, not shown: ${command} left the conversation they belonged to (verdict and cost are in the row printed when each review ended)`)
    expect(await stopDisplay($, seen)).not.toMatch(HEADING)
  }
  // With nothing held, the same event prints nothing.
  const rowsBefore = seen.rows.length
  await $.classic.SessionStart({ ...ENVELOPE, source: 'clear' })
  expect(seen.rows.length).toBe(rowsBefore)
})

test('the dropped-box row is still printed when the engine has already reset the session state', async ($, on) => {
  const seen = rig(on, PASS_REPORT)
  await interruptAndReview($, seen)
  // By the mods documentation $.state stands at its initial values when classic.SessionStart fires after /clear: the
  // mod then knows of the box only through its own count.
  seen.isReset = true
  await $.classic.SessionStart({ ...ENVELOPE, source: 'clear' })
  expect(seen.rows[seen.rows.length - 1]).toBe('review-mod: 1 held interrupted-turn report(s) dropped, not shown: /clear left the conversation they belonged to (verdict and cost are in the row printed when each review ended)')
  expect(await stopDisplay($, seen)).not.toMatch(HEADING)
  // The count went with the row: a second /clear prints nothing.
  const rowsBefore = seen.rows.length
  await $.classic.SessionStart({ ...ENVELOPE, source: 'clear' })
  expect(seen.rows.length).toBe(rowsBefore)
})

test('a box that could not be held is not promised by the row', async ($, on) => {
  const seen = rig(on, PASS_REPORT)
  seen.refuse.set = true
  await interruptAndReview($, seen)
  // The reason is the rejection of the call as the engine words it: the plugin, the call, then the text of the refusal.
  expect(seen.rows).toEqual([`review-mod: review of the interrupted turn finished: PASS · ${USAGE_TEXT} · report and usage box NOT held for the next reply (agentlenspro-review-mod: $.state.set: refused by the test)`])
  seen.refuse.set = false
  expect(await stopDisplay($, seen)).not.toMatch(HEADING)
})

test('a Stop that cannot read the held boxes still writes its display and says why', async ($, on) => {
  const seen = rig(on, PASS_REPORT)
  await interruptAndReview($, seen)
  seen.refuse.get = true
  const shown = await stopDisplay($, seen)
  expect(shown).not.toMatch(HEADING)
  expect(shown).toMatch(/\[review-mod\] held interrupted-turn report\(s\) could not be read \(agentlenspro-review-mod: \$\.state\.get: refused by the test\); they stay held for the next Stop/)
  // The box was not lost: the next Stop that can read it shows it.
  seen.refuse.get = false
  expect(await stopDisplay($, seen)).toMatch(HEADING)
})

test('a box held while a Stop reviews its own turn is not lost, and no box is shown twice', async ($, on) => {
  const seen = rig(on, PASS_REPORT)
  await interruptAndReview($, seen, 'turn-a') // box A is held
  // A second interrupted turn: the fork of its review answers 30 s later on the mock clock, so the review stays open.
  seen.forkDelays.push(30000)
  await interruptAndReview($, seen, 'turn-b')
  expect(seen.forkPrompts.length).toBe(2)
  // The next turn completes meanwhile. Its Stop reviews it (the scan finds work) and that fork answers 60 s later.
  seen.stopHasWork = true
  seen.forkDelays.push(60000)
  const before = seen.displays.length
  const stopping = $.classic.Stop({ ...ENVELOPE, stop_hook_active: false, last_assistant_message: 'done' })
  await seen.clock.settle()
  expect(seen.forkPrompts.length).toBe(3)
  // The review of the interrupted turn ends first: box B is held while the Stop is still reviewing.
  await seen.clock.advance(30000)
  expect(seen.rows.filter((row) => row.startsWith('review-mod: review of the interrupted turn finished: PASS')).length).toBe(2)
  expect(seen.displays.length).toBe(before)
  await seen.clock.advance(30000)
  await stopping
  expect(seen.displays.length).toBe(before + 1)
  const first = seen.displays[before] ?? ''
  seen.stopHasWork = false
  const second = await stopDisplay($, seen)
  const headings = (text: string) => text.split('\n').filter((line) => /^interrupted turn \d{2}:\d{2}$/.test(line)).length
  // Box A is in the display of the Stop that was under way; box B is there or in the next one; neither is shown twice.
  expect(headings(first) >= 1).toBe(true)
  expect(headings(first) + headings(second)).toBe(2)
  expect(await stopDisplay($, seen)).not.toMatch(HEADING)
})

test('a box that a Stop has shown is not reported as dropped by a later /clear', async ($, on) => {
  const seen = rig(on, PASS_REPORT)
  await interruptAndReview($, seen)
  expect(await stopDisplay($, seen)).toMatch(HEADING)
  const rowsBefore = seen.rows.length
  seen.isReset = true
  await $.classic.SessionStart({ ...ENVELOPE, source: 'clear' })
  expect(seen.rows.length).toBe(rowsBefore)
})

test('what the mod writes to the session state has the shape types/index.d.ts declares', async ($, on) => {
  // No type-check reads hooks/register.js (JavaScript): this is the only check of that write against HeldBox (at, lines).
  const seen = rig(on, PASS_REPORT)
  await interruptAndReview($, seen)
  expect(seen.heldWrites.length).toBe(1)
  const written = seen.heldWrites[0] ?? []
  expect(written.map((box) => Object.keys(box).sort())).toEqual([['at', 'lines']])
  expect(written.every((box) => /^\d{2}:\d{2}$/.test(box.at) && box.lines.length > 0 && box.lines.every((line) => typeof line === 'string'))).toBe(true)
})
