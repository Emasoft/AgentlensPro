#!/usr/bin/env node
// Stop hook: after a CONSEQUENTIAL turn, make the agent spawn a one-turn adversarial review fork.
//
// WHY. deny-unscoped-measurement.js refuses the four failure modes that are a decidable COMMAND
// SHAPE. The rest of this session's nine wrong claims were REASONING errors — no regex sees those,
// and the agent that made them is the last one able to notice. A forked reviewer inherits the
// turn's full context, so it checks the reasoning itself at a cache READ (0.1x) rather than a cold
// prefix write, and is told to exit after one SendMessage so it never pays for a turn 2.
//
// A hook CANNOT invoke the Agent tool — hooks are external processes and the documented output
// schema has no tool-invocation field. So enforcement is inverted: exit 2 REFUSES to let the turn
// end, and the stop is only permitted once a fork actually exists in the transcript. Not a
// reminder the model may ignore; a gate it cannot pass.
//
// ── THE RULE: RELATIVE POSITION, NOT TURN BOUNDARIES ────────────────────────────────────────────
//
// Allow the stop iff the last fork spawn is NEWER than the last consequential action.
//
// The first version of this hook tried to find "this turn" by walking back to the last
// `type === 'user'` entry. That was measured against the REAL transcript and is catastrophically
// wrong: `type: "user"` entries are overwhelmingly TOOL RESULTS — 42 of 46 non-meta user entries
// in a live sample, including the three most recent. So the computed "turn" was almost always just
// the last entry or two: the fork spawn fell outside it (the guard went blind and re-blocked) and
// so did the edit (the gate saw nothing and never fired). Both directions broken, and the matrix
// missed it because its fixtures used plain-string user entries, a shape the format does not
// produce. A test built on an assumed format tests the assumption, not the code.
//
// Relative position needs no turn boundary, no `isMeta`, and no user-message parsing, so none of
// that can be wrong. It also self-terminates: after a block, the agent spawns a fork, which is by
// construction newer than the work that triggered the block, so the next Stop allows. If new
// consequential work lands after a fork, that is genuinely new unreviewed work and earns one more
// review — progress, not a loop.
//
// Off switch: AGENTLENS_REVIEW_FORK=off. Every unreadable-input path ALLOWS the stop: a Stop hook
// that blocks when it should not can wedge the session, which is worse than a missed review.

const fs = require('fs')
const os = require('os')
const path = require('path')

// ── TWO BREAKERS, sized against a MEASURED rate ────────────────────────────────────────────────
// The first version shipped with no cap at all, and the rate was never measured — the exact
// mistake (optimise first, size against production later) that this session already paid four
// hours for, committed inside the hook whose header cites that lesson.
//
// Measured on this session's own transcript, replaying the gate over it: 48 real user turns, 29
// of them containing work, so 29 fires ~= $3.77 at the measured 268k-token cache-read rate. (A
// first pass counted 443 — that was assistant MESSAGES, not turn-ends, and overstated by 15x.
// The hook fires per turn end.) Tolerable, but it grows with context: a fork at 658k cost $0.33
// against $0.13 here, so a long session's tail is the expensive part.
//
// MAX is the cost bound. CONSECUTIVE is the safety bound and matters more: if a fork is never
// spawned — the tool is unavailable, the turn is interrupted, the agent judges it unnecessary —
// then lastWork stays ahead of lastFork forever and the turn CAN NEVER END. The only documented
// escape is an env var the wedged session cannot set for itself. So after N consecutive blocks
// with no fork landing, give up and allow.
const MAX_PER_SESSION = Number(process.env.AGENTLENS_REVIEW_FORK_MAX) > 0
  ? Number(process.env.AGENTLENS_REVIEW_FORK_MAX)
  : 20
const MAX_CONSECUTIVE = 2

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

  // ── MAIN AGENT ONLY ────────────────────────────────────────────────────────────────────────
  // A subagent must never be told to spawn a reviewer: the reviewer is itself a subagent, so a
  // subagent that obeyed would spawn one, which would spawn one — a fork storm, at a cache WRITE
  // each. This is already true by construction (`Stop` fires only when the MAIN agent finishes;
  // subagents get the distinct `SubagentStop` event, and this hook is registered under `Stop`
  // alone), so what follows is belt-and-braces on a failure whose cost is unbounded.
  // The field is only honoured when PRESENT — treating "absent" as "not Stop" would silently
  // disable the hook, which is the failure mode that looks like success.
  const evt = input?.hook_event_name ?? input?.hookEventName
  if (typeof evt === 'string' && evt !== 'Stop') allowStop()

  // `transcript_path` verified against a working Stop hook, not assumed.
  const transcript = input?.transcript_path
  if (!transcript || !fs.existsSync(transcript)) allowStop()

  // Read only the tail — a live transcript runs to tens of MB and the answer is always near the
  // end. Reading the whole file to inspect its end is its own version of the mistake this exists
  // to catch. If both markers fall outside the window the hook blocks once, the agent spawns a
  // fork, and the next Stop allows: bounded, and in the safe direction.
  let lines
  try {
    const fd = fs.openSync(transcript, 'r')
    const size = fs.fstatSync(fd).size
    const span = Math.min(size, 4 * 1024 * 1024)
    const buf = Buffer.alloc(span)
    fs.readSync(fd, buf, 0, span, size - span)
    fs.closeSync(fd)
    // Drop the first line when the window started mid-record; a torn record is not JSON.
    lines = buf.toString('utf8').split('\n')
    if (span < size) lines = lines.slice(1)
    lines = lines.filter(Boolean)
  } catch {
    allowStop()
  }

  // Shell quoting is stripped before matching so prose ABOUT committing is not mistaken for a
  // commit — `echo "run git commit"` must not trigger a review.
  const unquoted = (s) => s.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')
  const EDITORS = new Set(['Edit', 'Write', 'NotebookEdit'])

  let lastFork = -1
  let lastWork = -1

  for (let i = 0; i < lines.length; i++) {
    let e
    try { e = JSON.parse(lines[i]) } catch { continue }
    // Second half of MAIN AGENT ONLY: subagent turns are marked `isSidechain: true` (measured —
    // the main transcript carries 0 true / 261 false). Skipping them means a sidechain transcript
    // yields no work and no fork, so the hook allows the stop and stays silent.
    if (e?.isSidechain === true) continue
    if (e?.type !== 'assistant') continue
    const content = e?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type !== 'tool_use') continue
      if (b.name === 'Agent' && b.input?.subagent_type === 'fork') { lastFork = i; continue }
      if (EDITORS.has(b.name)) { lastWork = i; continue }
      // A TRDD path needs no special case: editing one is already an editor tool use, and merely
      // grepping one is not work. The first version matched the path in ANY Bash command, which in
      // this project (where TRDD paths are read constantly) made the gate near-always-on.
      if (b.name === 'Bash' && /\bgit\s+commit\b/.test(unquoted(String(b.input?.command ?? '')))) lastWork = i
    }
  }

  // Session-scoped breaker state. tmpdir, not the repo: it is per-session and self-cleaning, and
  // a counter is not a project artifact. Every read/write failure falls through to ALLOW.
  const key = String(input?.session_id || transcript).replace(/[^A-Za-z0-9]/g, '_').slice(-64)
  const statePath = path.join(os.tmpdir(), `agentlens-review-fork-${key}.json`)
  const readState = () => {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch { return { total: 0, consecutive: 0 } }
  }
  const writeState = (s) => { try { fs.writeFileSync(statePath, JSON.stringify(s)) } catch { /* not worth wedging over */ } }

  if (lastWork === -1) allowStop()      // nothing claimed this window
  // `>=`, not `>`: an edit and a fork spawn in the SAME assistant message share an index, and a
  // tie must go to the fork or that turn can never end. Caught by the matrix, not by reasoning.
  if (lastFork >= lastWork) {
    // The review landed, so the streak is broken. Resetting here is what makes CONSECUTIVE mean
    // "blocks that produced no fork" rather than "blocks ever".
    const s = readState()
    if (s.consecutive !== 0) writeState({ ...s, consecutive: 0 })
    allowStop()
  }

  const state = readState()
  // Breakers, before emitting the demand. Both fail OPEN — the cost of an unwanted review is one
  // review; the cost of a wedged session is the session.
  if (state.consecutive >= MAX_CONSECUTIVE || state.total >= MAX_PER_SESSION) {
    writeState({ ...state, consecutive: 0 })
    allowStop()
  }
  writeState({ total: (state.total || 0) + 1, consecutive: (state.consecutive || 0) + 1 })

  process.stderr.write(
    'STOP HOOK — spawn the adversarial review fork before ending this turn.\n\n'
    + 'This turn edited files or committed, so it made claims that nothing has checked. Spawn ONE '
    + 'reviewer with the Agent tool, subagent_type "fork", and a prompt that:\n'
    + '  - states what you did this turn and every claim you are asserting;\n'
    + '  - orders it to make NO tool calls except a single SendMessage to "main", then stop (a '
    + 'second turn rewrites the shared prefix at the cache-WRITE rate and destroys the economics);\n'
    + '  - tells it to hunt the recurring failure shape — a PROXY read in place of the thing (a '
    + "pipe's exit status for the tool's, a preview for the file, a profile for the workload rate, "
    + 'one run for the variance, an assumed format for the real one);\n'
    + '  - asks it to name the single WEAKEST link and give ONE settling command for it.\n\n'
    + 'Then read its findings and act on them. AGENTLENS_REVIEW_FORK=off disables this.\n',
  )
  process.exit(2)
})
