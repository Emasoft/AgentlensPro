#!/usr/bin/env node
// Stop hook: after a CONSEQUENTIAL turn, make the agent spawn a one-turn adversarial review fork.
//
// WHY. On 2026-08-22 a single session produced nine wrong claims with one shape: a proxy read in
// place of the thing. scripts/deny-unscoped-measurement.js refuses the four that are a decidable
// COMMAND SHAPE. The rest are reasoning errors — no regex can see them, and the agent that made
// them is the last one able to notice. A forked reviewer inherits the turn's full context, so it
// can check the reasoning itself; it costs a cache READ (0.1x) rather than a cold prefix write,
// and it is told to exit after one message so it never pays for a second turn.
//
// The USER asked for this twice. It fires on its own because the agent reliably forgets to.
//
// TWO GATES, both necessary:
//
//   1. LOOP GUARD. Blocking a Stop means the agent works again and then stops again — which fires
//      this hook again. The guard does NOT use `stop_hook_active`: the current hooks doc does not
//      define that field, and building the only thing standing between this and an infinite loop
//      on an undocumented field is how you get an infinite loop. Instead it reads the transcript:
//      if the most recent assistant turn already spawned a fork, this turn IS the spawn, so allow
//      the stop. That is self-correcting and depends on nothing but what actually happened.
//
//   2. CONSEQUENCE GATE. A read-only turn has no claim to check and a fork on this session's
//      context is ~$0.35. Fire only when the turn EDITED something, COMMITTED, or touched a TRDD
//      — those are the claim-making moments. Answering a question is not one.
//
// Off switch: AGENTLENS_REVIEW_FORK=off. Silence is not a failure mode here — a hook that cannot
// read its input must ALLOW the stop, never wedge the session.

const fs = require('fs')

const allowStop = () => process.exit(0)

let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  if ((process.env.AGENTLENS_REVIEW_FORK || '').trim() === 'off') allowStop()

  let input
  try {
    input = JSON.parse(raw)
  } catch {
    allowStop()
  }

  const transcript = input?.transcript_path
  if (!transcript || !fs.existsSync(transcript)) allowStop()

  // Read only the tail — this session's transcript is hundreds of MB and the answer is always
  // within the last few turns. Reading the whole file to inspect its end is its own version of
  // the mistake this hook exists to catch.
  let lines
  try {
    const fd = fs.openSync(transcript, 'r')
    const size = fs.fstatSync(fd).size
    const span = Math.min(size, 2 * 1024 * 1024)
    const buf = Buffer.alloc(span)
    fs.readSync(fd, buf, 0, span, size - span)
    fs.closeSync(fd)
    lines = buf.toString('utf8').split('\n').slice(1).filter(Boolean)
  } catch {
    allowStop()
  }

  const entries = []
  for (const line of lines) {
    try { entries.push(JSON.parse(line)) } catch { /* a torn first/last record is expected */ }
  }
  if (!entries.length) allowStop()

  // Walk back to the last real user message; everything after it is the turn under review.
  // `isMeta` entries are harness injections (hook output, reminders), not the user speaking.
  let start = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e?.type === 'user' && !e?.isMeta && typeof e?.message?.content !== 'undefined') { start = i; break }
  }
  const turn = entries.slice(start)

  const toolUses = []
  for (const e of turn) {
    if (e?.type !== 'assistant') continue
    const content = e?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) if (b?.type === 'tool_use') toolUses.push(b)
  }

  // GATE 1 — this turn already spawned the reviewer.
  const spawnedFork = toolUses.some((t) => t?.name === 'Agent' && t?.input?.subagent_type === 'fork')
  if (spawnedFork) allowStop()

  // GATE 2 — did this turn actually do something worth reviewing?
  const EDITORS = new Set(['Edit', 'Write', 'NotebookEdit'])
  const consequential = toolUses.some((t) => {
    if (EDITORS.has(t?.name)) return true
    if (t?.name !== 'Bash') return false
    const cmd = String(t?.input?.command ?? '')
    return /\bgit\s+commit\b/.test(cmd) || /design\/tasks\/TRDD-/.test(cmd)
  })
  if (!consequential) allowStop()

  process.stderr.write(
    'STOP HOOK — spawn the adversarial review fork before ending this turn.\n\n'
    + 'This turn changed files, committed, or touched a TRDD, so it made claims that nothing has '
    + 'checked. Spawn ONE reviewer with the Agent tool, subagent_type "fork", and a prompt that:\n'
    + '  - states what you did this turn and every claim you are asserting;\n'
    + '  - orders it to make NO tool calls except a single SendMessage to "main" (a second turn '
    + 'rewrites the shared prefix at the cache-WRITE rate and destroys the economics);\n'
    + '  - tells it to hunt for the session\'s recurring failure shape — a PROXY read in place of '
    + 'the thing (a pipe\'s exit status for the tool\'s, a preview for the file, a profile for the '
    + 'workload rate, one run for the variance);\n'
    + '  - asks it to name the single WEAKEST link and give ONE settling command for it.\n\n'
    + 'Then read its findings and act on them. Set AGENTLENS_REVIEW_FORK=off to disable.\n',
  )
  process.exit(2)
})
