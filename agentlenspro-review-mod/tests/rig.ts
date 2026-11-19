// The test rig of agentlenspro-review-mod, shared by the test files (tests/*.test.ts). Moved here from
// tests/held-interrupted.test.ts in 0.7.13, when tests/deferred-review.test.ts needed the same stubs.
//
// Nothing real runs: no model, no process (the agentlenspro CLI and git are stubbed), and no file is written. An
// unstubbed mods API call skips the calling hook WITHOUT failing the test, so every `$.` call the mod can make on the
// tested paths has a stub in rig(), and each stub records its name in `called`, which the tests compare with ON_PATH.
// `$.state` (atom, read, update) is answered by the kit itself. The kit does not empty `$.state` when a test fires
// classic.SessionStart, whatever its source; a real /clear, /resume or /branch does.
import { expect, mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const CWD = '/nonexistent/agentlenspro-review-mod-test'
export const SESSION = 'test-session-1'
export const ENVELOPE = { session_id: SESSION, transcript_path: `${CWD}/transcript.jsonl`, cwd: CWD }
const DISPLAY_NAME = `/.claude/tmp/agentlenspro-review-mod/${SESSION}.txt`
const HELD = { plugin: 'agentlenspro-review-mod', key: 'heldInterrupted' } as const
// The heading of a held box in the Stop display. The time is the real clock's, not the mock clock's.
export const HEADING = /^interrupted turn \d{2}:\d{2}$/m
// The line register.js writes after the held boxes of a Stop display (HELD_END there and in hooks/show.py).
export const HELD_END = '\u001e'
// On claude-opus-5 (5 / 0.5 / 25 USD per MTok for input / cache read / output) this usage costs exactly $0.0040.
const USAGE = { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 }
const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
export const USAGE_TEXT = 'cost $0.0040 · in 100 · out 100 · cache r 2,000 / w 0'
export const PASS_REPORT = 'VERDICT: PASS\nNOT-DO: none\nWRONG-IF: none\nWEAKEST LINK: none — SETTLE WITH: none'
export const BLOCK_REPORT = `VERDICT: BLOCK\n1. [BLOCKER] the edit was not checked — no run shown — run it\n${PASS_REPORT.split('\n').slice(1).join('\n')}`
// The stubbed calls a review that ends with a report makes between the aborted turn and the end of the next Stop.
export const ON_PATH = ['process.run agentlenspro review-gate', 'process.run git', 'model.fork', 'session.model', 'fs.exists', 'fs.write']
// What a review that gets no report adds: the fallback completion and the deferral count.
export const DEFER_PATH = [...ON_PATH, 'session.messages', 'model.complete', 'store.get', 'store.set']

export type Rig = {
  clock: MockClock
  // Every stubbed mods API call the mod made, by name, in order.
  called: string[]
  // The $.ui.log rows the user sees (to: transcript), in order.
  rows: string[]
  // Every text written to the Stop display file, in order: one per main-thread Stop.
  displays: string[]
  forkPrompts: string[]
  // What a review fork answers; null = the fork and the fallback completion both answer with no text (a review that makes
  // its model calls and gets no report). A test may change it between events.
  reviewText: string | null
  // What a measure fork (its prompt says "ROLE: MEASURE") answers. "[]" plans no assumption, so the measure ends there.
  measureText: string
  // Set by a test to make the reads or the writes of the held-box state value fail.
  refuse: { get: boolean; set: boolean }
  // Set by a test to answer the reads of the held-box state value with its initial value, as after the reset of $.state
  // that the mods documentation gives for /clear, /resume and /branch (the kit itself does not reset it).
  isReset: boolean
  // Set by a test to answer the reads of the held-box state value with these boxes, as a fresh module (after a reload) finds
  // them in $.state. Below isReset and refuse.
  heldSeed: { at: string; lines: string[] }[] | null
  // Set by a test to make the scan of a Stop find work, so that the Stop reviews its own turn (one fork).
  stopHasWork: boolean
  // Set by a test to make the scan of a Stop find a proposal (index 6), so that the Stop measures before it reviews.
  stopProposal: boolean
  // Milliseconds on the mock clock before the next forks answer, one entry per fork, first in first out; none = at once.
  forkDelays: number[]
  // Every value the mod wrote under the held-box state key, in order. The element type is spelled out here, so the
  // type-check fails if types/index.d.ts declares another shape for that key.
  heldWrites: { at: string; lines: string[] }[][]
  // The context entries each prompt.submit carried when it reached the bottom of the hook chain (what the model reads).
  contexts: string[][]
}

export function rig(on: On, reviewText: string | null): Rig {
  const seen: Rig = { clock: mock.clock(on), called: [], rows: [], displays: [], forkPrompts: [], reviewText, measureText: '[]', refuse: { get: false, set: false }, isReset: false, heldSeed: null, stopHasWork: false, stopProposal: false, forkDelays: [], heldWrites: [], contexts: [] }
  // Events the mod passes on with next(e).
  on('turn.complete', () => ({ text: '' }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('session.start', () => ({ cwd: CWD }))
  on('prompt.submit', ($, e) => {
    seen.contexts.push([...(e.context ?? [])])
    return { text: e.text, context: e.context }
  })
  on('process.run', ($, e) => {
    const ran = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'agentlenspro' && e.argv[1] === 'review-gate') {
      seen.called.push('process.run agentlenspro review-gate')
      // The scan of the interrupted turn passes --ignore-interrupt-floor and finds work; the scan of a Stop finds none,
      // unless the test set stopHasWork, and a proposal only when it set stopProposal.
      const isInterruptedScan = e.argv.includes('--ignore-interrupt-floor')
      const proposal = !isInterruptedScan && seen.stopProposal
      return ran(0, JSON.stringify({
        scan: { readable: true },
        work: isInterruptedScan ? { index: 3, cause: 'edit', detail: 'Edit src/a.ts' } : seen.stopHasWork ? { index: 7, cause: 'edit', detail: 'Edit src/b.ts' } : null,
        proposal,
        proposalIndex: proposal ? 6 : -1,
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
    const text = String(e.prompt).includes('ROLE: MEASURE') ? seen.measureText : seen.reviewText
    return text === null
      ? { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: NO_USAGE } }
      : { value: { isAnswered: true as const, text, usage: USAGE } }
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
  // answers it with the initial value (isReset) or with seeded boxes (heldSeed), and the second refuses its write.
  on('state.get', HELD, ($, e, next) => (seen.refuse.get ? { deny: 'refused by the test' } : seen.isReset ? { value: { value: [], version: 0 } } : seen.heldSeed ? { value: { value: seen.heldSeed, version: 1 } } : next(e)))
  on('state.set', HELD, ($, e, next) => {
    if (seen.refuse.set) return { deny: 'refused by the test' }
    seen.heldWrites.push(e.value)
    return next(e)
  })
  return seen
}

// One main turn the user cut short, then the timer that reviews it. Resolves once the review has run to its end.
export async function interruptAndReview($: Engine, seen: Rig, turnId = 'turn-1'): Promise<void> {
  await $.classic.UserPromptSubmit({ ...ENVELOPE, prompt: 'edit src/a.ts' })
  await $.turn.complete({ turnId, answer: '', durationMs: 900, isAborted: true, reason: 'aborted' })
  await seen.clock.advance(1500)
}

// One main-thread Stop; resolves to the text the mod wrote to the display file for it (what hooks/show.py prints).
export async function stopDisplay($: Engine, seen: Rig): Promise<string> {
  const before = seen.displays.length
  await $.classic.Stop({ ...ENVELOPE, stop_hook_active: false })
  // Exactly one display write per Stop: none means the mod's classic.Stop hook was skipped or threw.
  expect(seen.displays.length).toBe(before + 1)
  return seen.displays[before] ?? ''
}

// One prompt the user typed; resolves to the context entries the model reads beside it.
export async function submit($: Engine, seen: Rig, text = 'next'): Promise<string[]> {
  const before = seen.contexts.length
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  // Exactly one prompt reached the bottom: none means the mod's prompt.submit hook was skipped or dropped it.
  expect(seen.contexts.length).toBe(before + 1)
  return seen.contexts[before] ?? []
}

export const offPath = (seen: Rig, allowed: readonly string[]) => seen.called.filter((name) => !allowed.includes(name))