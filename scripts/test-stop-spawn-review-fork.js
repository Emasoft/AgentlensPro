#!/usr/bin/env node
// Matrix for scripts/stop-spawn-review-fork.js.
//
// THE FIXTURES ARE THE POINT. The first version of this matrix built `type: "user"` entries as
// plain strings and passed 21/21 against a hook that was broken in both directions. Measured
// against the live transcript, `type: "user"` entries are overwhelmingly TOOL RESULTS (42 of 46
// non-meta entries in the sample; the three most recent were all tool_result). Every fixture below
// therefore uses the real shape, and `toolResult()` appears in the interleavings deliberately —
// a test built on an assumed format tests the assumption, not the code.
//
// ALLOW cases outrank BLOCK cases: a Stop hook that blocks when it should not can WEDGE the
// session, whereas a missed review costs one review.

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const HOOK = path.join(__dirname, 'stop-spawn-review-fork.js')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stopfork-${process.pid}-`))

// Real shapes, taken from the live transcript.
const userText = (text) => ({ type: 'user', message: { role: 'user', content: text } })
const toolResult = (content = 'ok') => ({
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: 'toolu_aaaa', type: 'tool_result', content }] },
})
const meta = () => ({ type: 'user', isMeta: true, message: { content: 'hook output' } })
const assistant = (...tools) => ({
  type: 'assistant',
  message: { role: 'assistant', content: tools.map((t) => ({ type: 'tool_use', ...t })) },
})
const edit = { name: 'Edit', input: { file_path: '/x/y.ts' } }
const write = { name: 'Write', input: { file_path: '/x/y.ts' } }
const read = { name: 'Read', input: { file_path: '/x/y.ts' } }
const grep = { name: 'Grep', input: { pattern: 'foo' } }
const fork = { name: 'Agent', input: { subagent_type: 'fork', prompt: 'review' } }
const freshAgent = { name: 'Agent', input: { subagent_type: 'general-purpose', prompt: 'go' } }
const bash = (command) => ({ name: 'Bash', input: { command } })

// exit 0 = the turn may end; exit 2 = blocked, stderr handed back to the agent.
// `session` defaults to a UNIQUE value per call. The breakers are stateful and keyed on
// session_id, so a shared key would let one case's block-streak disarm the next case's — the
// matrix would go green while the hook did nothing. Only the BREAKERS pass an explicit key.
function verdict(entries, { env = {}, transcript, event, session } = {}) {
  const file = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
  if (transcript !== null) fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const payload = {
    transcript_path: file,
    session_id: session || `case-${process.pid}-${Math.random().toString(36).slice(2)}`,
  }
  if (event) payload.hook_event_name = event
  try {
    execFileSync('node', [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return 'allow'
  } catch (e) {
    if (e.status === 2) return 'block'
    return `ERROR(status=${e.status}): ${String(e.stderr || e.message).slice(0, 200)}`
  }
}

const CASES = [
  // ── THE REGRESSION THAT SHIPPED. Both broke the turn-boundary version. ───────────────────────
  [
    [userText('go'), assistant(edit), assistant(fork), userText('mid-turn note'), assistant(read)],
    'allow',
    'REGRESSION: a mid-turn user message must not hide the fork spawn',
  ],
  [
    [userText('go'), assistant(edit), assistant(fork), toolResult('block — ...'), toolResult('ok')],
    'allow',
    'REGRESSION: tool results are `type:user` too — they must not hide the fork spawn',
  ],
  [
    [userText('go'), assistant(edit), toolResult(), toolResult(), toolResult()],
    'block',
    'REGRESSION: an edit behind several tool results is still unreviewed work',
  ],

  // ── must BLOCK: unreviewed claims ───────────────────────────────────────────────────────────
  [[userText('go'), assistant(edit)], 'block', 'an edited file is a claim about the code'],
  [[userText('go'), assistant(bash('git commit -m "x"'))], 'block', 'a commit asserts the work is sound'],
  [[userText('go'), assistant(write)], 'block', 'Write is an editor'],
  [[userText('go'), assistant(read), toolResult(), assistant(edit)], 'block', 'an edit anywhere in the window counts'],
  [[userText('go'), assistant(fork), toolResult(), assistant(edit)], 'block', 'work NEWER than the fork is unreviewed — this is what makes it self-terminating'],

  // ── must ALLOW: the fork is newer than the work ─────────────────────────────────────────────
  [[userText('go'), assistant(edit), assistant(fork)], 'allow', 'THE GUARD — the newest work has been reviewed'],
  [[userText('go'), assistant(edit), toolResult(), assistant(fork), toolResult()], 'allow', 'trailing tool results do not un-review it'],
  [[userText('go'), assistant(edit, fork)], 'allow', 'edit and fork in the SAME assistant message — fork must not lose the tie'],

  // ── must ALLOW: nothing was claimed ─────────────────────────────────────────────────────────
  [[userText('go'), assistant(read, grep)], 'allow', 'a read-only turn has no claim to check'],
  [[userText('go')], 'allow', 'no tool calls at all'],
  [[userText('go'), assistant(bash('ls -l'))], 'allow', 'an ordinary shell command is not a commit'],
  [[userText('go'), assistant(bash('git status'))], 'allow', 'git status changes nothing'],
  [[userText('go'), assistant(bash('git log --oneline -1'))], 'allow', 'reading history is not committing'],
  [[userText('go'), assistant(freshAgent)], 'allow', 'a non-fork subagent is not the reviewer'],
  [[userText('go'), assistant(bash('cat design/tasks/TRDD-2026-AAAA-x.md'))], 'allow', 'READING a TRDD is not work — the old TRDD-path regex made the gate near-always-on in this repo'],
  [[userText('go'), assistant(bash('grep -n column design/tasks/TRDD-2026-AAAA-x.md'))], 'allow', 'nor is grepping one'],

  // ── quoting: prose about committing is not committing ───────────────────────────────────────
  [[userText('go'), assistant(bash('echo "never run git commit blindly"'))], 'allow', 'a double-quoted mention is stripped before matching'],
  [[userText('go'), assistant(bash("echo 'git commit is dangerous'"))], 'allow', 'single-quoted too'],
  [[userText('go'), assistant(bash('git add x.ts && git commit -m "y"'))], 'block', 'a REAL commit behind a quoted message still fires'],

  // ── MAIN AGENT ONLY: a subagent told to spawn a reviewer would spawn a subagent, forever ────
  [
    [userText('go'), { ...assistant(edit), isSidechain: true }],
    'allow',
    'a SUBAGENT edit must never demand a review — that is a fork storm at a cache WRITE each',
  ],
  [
    [userText('go'), { ...assistant(edit), isSidechain: true }, { ...assistant(bash('git commit -m "x"')), isSidechain: true }],
    'allow',
    'nor a subagent commit',
  ],
  [
    [userText('go'), assistant(edit), { ...assistant(fork), isSidechain: true }],
    'block',
    'a fork spawned INSIDE a sidechain does not review the MAIN agent\'s work — the guard must not credit it',
  ],
  [[userText('go'), assistant(edit)], 'allow', 'a non-Stop event bails', { event: 'SubagentStop' }],
  [[userText('go'), assistant(edit)], 'block', 'an explicit Stop event still fires', { event: 'Stop' }],

  // ── must ALLOW: a hook that cannot read its input must never wedge the session ───────────────
  [[], 'allow', 'an empty transcript'],
  [[meta()], 'allow', 'only a meta entry'],
  [[userText('go'), assistant(edit)], 'allow', 'the OFF SWITCH', { env: { AGENTLENS_REVIEW_FORK: 'off' } }],
  [[userText('go'), assistant(edit)], 'allow', 'a missing transcript file', { transcript: null }],
  [[userText('go'), assistant(edit), { broken: true }], 'block', 'an unparseable record is skipped, not fatal', undefined],
]

// ── THE BREAKERS. Stateful, so they need repeated invocations under ONE session key. ──────────
// The wedge is the scenario with unbounded severity: if a fork is never spawned, lastWork stays
// ahead of lastFork forever, the turn can never end, and the documented escape is an env var the
// wedged session cannot set for itself. These cases prove the hook gives up instead.
const BREAKERS = []
{
  const unreviewed = [userText('go'), assistant(edit)]
  const sess = `wedge-${process.pid}`
  const seq = [verdict(unreviewed, { session: sess }), verdict(unreviewed, { session: sess }), verdict(unreviewed, { session: sess })]
  BREAKERS.push([
    JSON.stringify(seq) === JSON.stringify(['block', 'block', 'allow']),
    'THE WEDGE BREAKER: block twice, then give up — a turn must never be unendable',
    seq.join(','),
  ])

  // A fork landing must RESET the streak, or the breaker silently disarms the hook for the rest
  // of the session after two unrelated blocks.
  const sess2 = `reset-${process.pid}`
  const reviewed = [userText('go'), assistant(edit), assistant(fork)]
  const seq2 = [
    verdict(unreviewed, { session: sess2 }),   // block 1
    verdict(reviewed, { session: sess2 }),     // allow — resets the streak
    verdict(unreviewed, { session: sess2 }),   // block 1 again, NOT 2
    verdict(unreviewed, { session: sess2 }),   // block 2
    verdict(unreviewed, { session: sess2 }),   // breaker
  ]
  BREAKERS.push([
    JSON.stringify(seq2) === JSON.stringify(['block', 'allow', 'block', 'block', 'allow']),
    'a landed fork resets the consecutive streak',
    seq2.join(','),
  ])

  // The session cap is the COST bound: measured at 29 fires/session here, so 1 proves the
  // mechanism without a 20-iteration loop.
  const sess3 = `cap-${process.pid}`
  const seq3 = [
    verdict(unreviewed, { session: sess3, env: { AGENTLENS_REVIEW_FORK_MAX: '1' } }),
    verdict(unreviewed, { session: sess3, env: { AGENTLENS_REVIEW_FORK_MAX: '1' } }),
  ]
  BREAKERS.push([
    JSON.stringify(seq3) === JSON.stringify(['block', 'allow']),
    'the session cap stops demanding reviews once spent',
    seq3.join(','),
  ])
}

let pass = 0
const failures = []
for (const [ok, why, got] of BREAKERS) {
  if (ok) pass++
  else failures.push({ want: 'see why', got, why })
}
for (const [entries, want, why, opts] of CASES) {
  const got = verdict(entries, opts)
  if (got === want) pass++
  else failures.push({ want, got, why })
}

// Unparseable stdin must allow, not throw.
try {
  execFileSync('node', [HOOK], { input: 'not json', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  pass++
} catch (e) {
  failures.push({ want: 'allow', got: `exit ${e.status}`, why: 'unparseable stdin must allow the stop' })
}

// FALSIFY EACH GUARD BY MUTATION. A test that cannot fail on a broken implementation is
// documentation, not a gate. Break the predicate, prove the suite reddens on the case that
// matters. Both guards are safety-critical in opposite directions — the first against an
// infinite block, the second against a recursive fork storm — so both are falsified.
const src = fs.readFileSync(HOOK, 'utf8')
const MUTATIONS = [
  {
    find: 'if (lastFork >= lastWork) {',
    replace: 'if (false) {',
    entries: [userText('go'), assistant(edit), assistant(fork)],
    why: 'LOOP GUARD: a broken "already reviewed" test must be caught',
  },
  {
    find: 'if (e?.isSidechain === true) continue',
    replace: 'if (false) continue',
    entries: [userText('go'), { ...assistant(edit), isSidechain: true }],
    why: 'SUBAGENT GUARD: crediting sidechain work must be caught — that is the fork storm',
  },
]
for (const m of MUTATIONS) {
  const mutSrc = src.replace(m.find, m.replace)
  if (mutSrc === src) {
    failures.push({ want: 'mutation applied', got: 'predicate not found', why: `the mutation target moved — ${m.why} is no longer falsifying anything` })
    continue
  }
  const mutated = path.join(dir, `mutant-${MUTATIONS.indexOf(m)}.js`)
  fs.writeFileSync(mutated, mutSrc)
  const f = path.join(dir, `mut-${MUTATIONS.indexOf(m)}.jsonl`)
  fs.writeFileSync(f, m.entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  let mutantBlocked = false
  try {
    execFileSync('node', [mutated], { input: JSON.stringify({ transcript_path: f }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    if (e.status === 2) mutantBlocked = true
  }
  if (mutantBlocked) pass++
  else failures.push({ want: 'mutant blocks', got: 'mutant allowed', why: `MUTATION — ${m.why}` })
}

fs.rmSync(dir, { recursive: true, force: true })
// The breaker state lives in tmpdir keyed by session, so the suite's own keys must not accumulate.
for (const f of fs.readdirSync(os.tmpdir())) {
  if (/^agentlens-review-fork-.*(wedge|reset|cap|case)_?\d*_/.test(f) || f.includes(`_${process.pid}_`)) {
    try { fs.unlinkSync(path.join(os.tmpdir(), f)) } catch { /* best effort */ }
  }
}

for (const f of failures) console.error(`FAIL  want=${f.want} got=${f.got}\n      why: ${f.why}`)
console.log(`stop-spawn-review-fork: ${pass}/${CASES.length + BREAKERS.length + 1 + MUTATIONS.length} passed`)
process.exit(failures.length ? 1 : 0)
