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
function verdict(entries, { env = {}, transcript } = {}) {
  const file = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
  if (transcript !== null) fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  try {
    execFileSync('node', [HOOK], {
      input: JSON.stringify({ transcript_path: file, session_id: 'aaaaaaaa' }),
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

  // ── must ALLOW: a hook that cannot read its input must never wedge the session ───────────────
  [[], 'allow', 'an empty transcript'],
  [[meta()], 'allow', 'only a meta entry'],
  [[userText('go'), assistant(edit)], 'allow', 'the OFF SWITCH', { env: { AGENTLENS_REVIEW_FORK: 'off' } }],
  [[userText('go'), assistant(edit)], 'allow', 'a missing transcript file', { transcript: null }],
  [[userText('go'), assistant(edit), { broken: true }], 'block', 'an unparseable record is skipped, not fatal', undefined],
]

let pass = 0
const failures = []
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

// FALSIFY THE GUARD BY MUTATION. A test that cannot fail on a broken implementation is
// documentation, not a gate. Invert the comparison that decides "already reviewed" and prove the
// suite reddens on the case that matters.
const src = fs.readFileSync(HOOK, 'utf8')
const mutated = path.join(dir, 'mutant.js')
const mutSrc = src.replace('if (lastFork >= lastWork) allowStop()', 'if (false) allowStop()')
if (mutSrc === src) {
  failures.push({ want: 'mutation applied', got: 'predicate not found', why: 'the mutation target moved — this check is no longer falsifying anything' })
} else {
  fs.writeFileSync(mutated, mutSrc)
  const f = path.join(dir, 'mut.jsonl')
  fs.writeFileSync(f, [userText('go'), assistant(edit), assistant(fork)].map((e) => JSON.stringify(e)).join('\n') + '\n')
  let mutantBlocked = false
  try {
    execFileSync('node', [mutated], { input: JSON.stringify({ transcript_path: f }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    if (e.status === 2) mutantBlocked = true
  }
  if (mutantBlocked) pass++
  else failures.push({ want: 'mutant blocks', got: 'mutant allowed', why: 'MUTATION: a broken guard must be caught by this suite' })
}

fs.rmSync(dir, { recursive: true, force: true })

for (const f of failures) console.error(`FAIL  want=${f.want} got=${f.got}\n      why: ${f.why}`)
console.log(`stop-spawn-review-fork: ${pass}/${CASES.length + 2} passed`)
process.exit(failures.length ? 1 : 0)
