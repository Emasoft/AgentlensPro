// Tests of the interrupted-turn review of agentlenspro-review-mod (TRDD-ISEF8YO7, TRDD-M62ZBT7E, TRDD-IT5KUORN, TRDD-0IFG1B11).
//
// Path under test: an aborted main turn (turn.complete with isAborted) -> the 1.5 s timer -> the interrupted-turn
// review -> classic.SessionStart -> a main-thread classic.Stop, whose display file must carry the held box under the
// heading "interrupted turn HH:MM". The one-line row the review prints at once is checked too.
//
// The stubs and the helpers are in tests/rig.ts; what runs and what is stubbed is said there.
import { expect, test } from 'claude-code/testing'
import { BLOCK_REPORT, CWD, DEFER_PATH, ENVELOPE, HEADING, HELD_END, ON_PATH, PASS_REPORT, USAGE_TEXT, interruptAndReview, offPath, rig, stopDisplay } from './rig'

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

// The block text a classic.Stop resolved to (the mod merges its own into what the hooks beneath decided).
const blockOf = (r: unknown) => (r as { block?: string } | undefined)?.block

test('the held boxes come first and one HELD_END line separates them from the BLOCK report of the Stop that shows them', async ($, on) => {
  // TRDD-IT5KUORN: up to 0.7.12 nothing told show.py where the held part ended, and its cut removed THIS turn's report.
  const seen = rig(on, BLOCK_REPORT)
  await interruptAndReview($, seen)
  seen.stopHasWork = true
  const before = seen.displays.length
  const r = await $.classic.Stop({ ...ENVELOPE, stop_hook_active: false, last_assistant_message: 'done' })
  expect(seen.displays.length).toBe(before + 1)
  const lines = (seen.displays[before] ?? '').split('\n')
  expect(lines.filter((line) => line === HELD_END).length).toBe(1)
  const end = lines.indexOf(HELD_END)
  expect(HEADING.test(lines[0] ?? '')).toBe(true)
  expect(lines.slice(0, end)).toContain('[AGENTLENSPRO-REVIEW-REPORT] (run by the harness, interrupted turn)')
  // Every row of this Stop's own BLOCK review is after the line: hooks/show.py cuts what is above it first.
  const current = lines.slice(end + 1)
  expect(current).toContain('[AGENTLENSPRO-REVIEW-REPORT] (run by the harness)')
  expect(current).toContain('VERDICT: BLOCK')
  expect(current).toContain('1. [BLOCKER] the edit was not checked — no run shown — run it')
  expect(current.some((line) => line.includes('╭'))).toBe(true)
  expect(current.some((line) => /^interrupted turn \d{2}:\d{2}$/.test(line))).toBe(false)
  expect(String(blockOf(r) ?? '')).toMatch(/The review of this turn found BLOCKERS/)
})

test('a Stop with no held box writes no HELD_END line', async ($, on) => {
  const seen = rig(on, BLOCK_REPORT)
  seen.stopHasWork = true
  const shown = await stopDisplay($, seen)
  expect(shown).toMatch(/VERDICT: BLOCK/)
  expect(shown.split('\n')).not.toContain(HELD_END)
})

test('after a reload of the module, session.start counts the held boxes, so a /clear still says they were dropped', async ($, on) => {
  // TRDD-0IFG1B11 case a. Each test has a fresh module, as after a reload: heldCount is 0 while a box is still in $.state.
  const seen = rig(on, PASS_REPORT)
  seen.heldSeed = [{ at: '10:59', lines: ['interrupted turn 10:59', 'VERDICT: PASS'] }]
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
  // /clear: by the mods documentation the engine has reset $.state when classic.SessionStart fires.
  seen.isReset = true
  await $.classic.SessionStart({ ...ENVELOPE, source: 'clear' })
  expect(seen.rows).toEqual(['review-mod: 1 held interrupted-turn report(s) dropped, not shown: /clear left the conversation they belonged to (verdict and cost are in the row printed when each review ended)'])
})

test('a /clear that cannot read or clear the held boxes says in a row that they may be dropped, and none is reported twice', async ($, on) => {
  // TRDD-0IFG1B11 case c: up to 0.7.12 only a status line said so.
  const seen = rig(on, PASS_REPORT)
  await interruptAndReview($, seen)
  seen.refuse.get = true
  await $.classic.SessionStart({ ...ENVELOPE, source: 'clear' })
  expect(seen.rows[seen.rows.length - 1]).toBe('review-mod: 1 held interrupted-turn report(s) may be dropped, not shown: /clear left the conversation they belonged to and the held reports could not be read or cleared (agentlenspro-review-mod: $.state.get: refused by the test); any still held is shown at the next Stop')
  // The kit did not reset $.state, so the box is still held: the next Stop that can read it shows it.
  seen.refuse.get = false
  expect(await stopDisplay($, seen)).toMatch(HEADING)
  const rowsBefore = seen.rows.length
  await $.classic.SessionStart({ ...ENVELOPE, source: 'clear' })
  expect(seen.rows.length).toBe(rowsBefore)
})
