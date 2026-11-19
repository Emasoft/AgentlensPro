// Tests of a deferred main-turn review of agentlenspro-review-mod (TRDD-ASXUW08U, 0.7.13).
//
// Up to 0.7.12 a review deferred by the round cap (or that could not run) left a debt for the next stop, a yellow row for
// the user and nothing for the model, and the proposal of the deferred turn was never measured. Now the next prompt
// carries ONE line that says the review was deferred and why, and, when the turn had or may have had a proposal, that it
// got no measurement and how to get one. The stubs and the helpers are in tests/rig.ts.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { BLOCK_REPORT, ENVELOPE, PASS_REPORT, interruptAndReview, rig, submit } from './rig'
import type { Rig } from './rig'

const blockOf = (r: unknown) => (r as { block?: string } | undefined)?.block
const LINE_HEAD = '[agentlenspro-review-mod] REVIEW DEFERRED: the harness deferred its review of your earlier turn'
const LINE_TAIL = '; it reviews that work at your next stop that is not a janitor turn. Do not spawn a review fork.'
const MEASURE = ' got no measurement, and a deferred proposal is not measured later: if it still stands, repeat the proposal with its marker line in your next reply and the harness measures it at that stop.'
const CAP = 'cap of 2 blocking rounds reached this turn'

// Two Stops of one turn blocked by review BLOCKs reach the round cap (2); the third Stop of the same turn, with no
// turn.complete between, is deferred. Each Stop has a new final message, so none is skipped as already reviewed.
async function reachTheCap($: Engine, seen: Rig): Promise<unknown> {
  await $.classic.UserPromptSubmit({ ...ENVELOPE, prompt: 'do it' })
  for (const msg of ['reply 1', 'reply 2']) {
    const r = await $.classic.Stop({ ...ENVELOPE, stop_hook_active: false, last_assistant_message: msg })
    expect(String(blockOf(r) ?? '')).toMatch(/The review of this turn found BLOCKERS/)
  }
  const forks = seen.forkPrompts.length
  const r = await $.classic.Stop({ ...ENVELOPE, stop_hook_active: false, last_assistant_message: 'reply 3' })
  // Deferred: no model call, no block.
  expect(seen.forkPrompts.length).toBe(forks)
  expect(blockOf(r) ?? null).toBe(null)
  expect(seen.displays[seen.displays.length - 1] ?? '').toMatch(/REVIEW DEFERRED to the next stop \(not dropped\): cap of 2 blocking rounds reached this turn/)
  return r
}

test('a review deferred by the round cap is told to the model in one line at the next prompt, with its proposal not measured', async ($, on) => {
  const seen = rig(on, BLOCK_REPORT)
  seen.stopHasWork = true
  seen.stopProposal = true
  await reachTheCap($, seen)
  // Each blocked Stop measured its proposal first: a measure fork, then the review fork.
  expect(seen.forkPrompts.filter((p) => p.includes('ROLE: MEASURE')).length).toBe(2)
  const context = await submit($, seen)
  expect(context).toEqual([`${LINE_HEAD} (${CAP})${LINE_TAIL} That turn's proposal${MEASURE}`])
  expect(context[0]?.includes('\n')).toBe(false)
  // Told once.
  expect(await submit($, seen)).toEqual([])
})

test('a deferred turn with no proposal gets the line without the measurement sentence', async ($, on) => {
  const seen = rig(on, BLOCK_REPORT)
  seen.stopHasWork = true
  await reachTheCap($, seen)
  expect(await submit($, seen)).toEqual([`${LINE_HEAD} (${CAP})${LINE_TAIL}`])
})

test('a deferral that cannot know of a proposal says what happens if there was one', async ($, on) => {
  // An interrupted turn whose review cannot start (no classic.* payload has given a transcript path yet): the scan never ran.
  const seen = rig(on, PASS_REPORT)
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 900, isAborted: true, reason: 'aborted' })
  await seen.clock.advance(1500)
  expect(seen.rows).toEqual(['REVIEW DEFERRED to the next stop (not dropped): interrupted turn: no transcript path seen yet'])
  expect(await submit($, seen)).toEqual([`${LINE_HEAD} (interrupted turn: no transcript path seen yet)${LINE_TAIL} If that turn made a proposal, it${MEASURE}`])
})

test('once the next review pays the debt, no line repeats it and the review reaches the model', async ($, on) => {
  const seen = rig(on, BLOCK_REPORT)
  seen.stopHasWork = true
  await reachTheCap($, seen)
  expect((await submit($, seen)).length).toBe(1)
  // The next turn: turn.complete resets the round count, and its Stop reviews (PASS) with the debt in hand.
  await $.turn.complete({ turnId: 'turn-2', answer: 'ok', durationMs: 900, isAborted: false, reason: 'answer' })
  seen.reviewText = PASS_REPORT
  const r = await $.classic.Stop({ ...ENVELOPE, stop_hook_active: false, last_assistant_message: 'reply 4' })
  expect(blockOf(r) ?? null).toBe(null)
  const context = await submit($, seen)
  expect(context.length).toBe(1)
  expect(context[0]?.startsWith('[agentlenspro-review-mod] A harness adversarial review follows')).toBe(true)
  expect(context[0]?.includes('VERDICT: PASS')).toBe(true)
  expect(context.some((entry) => entry.includes('REVIEW DEFERRED'))).toBe(false)
})

test('a second deferral of the same turn with no proposal keeps the proposal sentence of the first', async ($, on) => {
  // The 2026-11-17 shape: one turn deferred twice (mergeProposal). A known proposal is not forgotten by a later deferral.
  const seen = rig(on, BLOCK_REPORT)
  seen.stopHasWork = true
  seen.stopProposal = true
  await reachTheCap($, seen)
  seen.stopProposal = false
  const r = await $.classic.Stop({ ...ENVELOPE, stop_hook_active: false, last_assistant_message: 'reply 4' })
  expect(blockOf(r) ?? null).toBe(null)
  expect(await submit($, seen)).toEqual([`${LINE_HEAD} (${CAP})${LINE_TAIL} That turn's proposal${MEASURE}`])
})

test('a report stored after the line was told does not tell the line again', async ($, on) => {
  // storeForModel keeps debtTold: an interrupted-turn review stored while the debt is still open is delivered alone.
  const seen = rig(on, BLOCK_REPORT)
  seen.stopHasWork = true
  await reachTheCap($, seen)
  expect((await submit($, seen)).length).toBe(1)
  // A completed turn resets the round count and the reviewed mark; then a turn the user cuts short is reviewed (PASS).
  await $.turn.complete({ turnId: 'turn-2', answer: 'ok', durationMs: 900, isAborted: false, reason: 'answer' })
  seen.reviewText = PASS_REPORT
  await interruptAndReview($, seen, 'turn-3')
  const context = await submit($, seen)
  expect(context.length).toBe(1)
  expect(context[0]?.includes('(run by the harness, interrupted turn)')).toBe(true)
  expect(context.some((entry) => entry.includes('REVIEW DEFERRED'))).toBe(false)
})

test('an interrupted BLOCK that lands after the cap is deferred with a line that names it and no proposal sentence', async ($, on) => {
  // The pendingBlock branch of reviewAtStop: no work, no proposal, no final message, a BLOCK waiting, rounds at the cap.
  const seen = rig(on, BLOCK_REPORT)
  // A turn the user cuts short; the fork of its review answers 60 s later on the mock clock.
  seen.forkDelays.push(60000)
  await $.classic.UserPromptSubmit({ ...ENVELOPE, prompt: 'edit src/a.ts' })
  await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 900, isAborted: true, reason: 'aborted' })
  await seen.clock.advance(1500)
  // The next turn uses both blocking rounds while that review is still open.
  seen.stopHasWork = true
  for (const msg of ['reply 1', 'reply 2']) {
    const r = await $.classic.Stop({ ...ENVELOPE, stop_hook_active: false, last_assistant_message: msg })
    expect(String(blockOf(r) ?? '')).toMatch(/The review of this turn found BLOCKERS/)
  }
  // The interrupted review ends with BLOCK; then a Stop with nothing new reaches the cap with that BLOCK waiting.
  await seen.clock.advance(60000)
  expect(seen.rows.some((row) => row.startsWith('review-mod: review of the interrupted turn finished: BLOCK'))).toBe(true)
  seen.stopHasWork = false
  const r = await $.classic.Stop({ ...ENVELOPE, stop_hook_active: false })
  expect(blockOf(r) ?? null).toBe(null)
  const context = await submit($, seen)
  const lines = context.filter((entry) => entry.startsWith(LINE_HEAD))
  expect(lines).toEqual([`${LINE_HEAD} (cap of 2 blocking rounds reached; the interrupted turn's BLOCK review was not re-checked)${LINE_TAIL}`])
  expect(lines.some((line) => line.includes('proposal'))).toBe(false)
  // Not asserted: whether the interrupted BLOCK report itself reaches the model on this path (see the 0.7.13 hand-over).
})