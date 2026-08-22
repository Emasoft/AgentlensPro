#!/usr/bin/env node
// Matrix for scripts/stop-spawn-review-fork.js.
//
// The ALLOW cases matter more than the BLOCK cases, and one of them matters more than all of it:
// a Stop hook that blocks when it should not does not merely annoy — it can wedge the session in
// a loop. So every "must allow" path (already-forked, read-only turn, unreadable input, missing
// transcript, off switch) is pinned here, and the loop guard is falsified by mutation below.

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const HOOK = path.join(__dirname, 'stop-spawn-review-fork.js')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stopfork-${process.pid}-`))

const user = (text) => ({ type: 'user', message: { role: 'user', content: text } })
const assistant = (...tools) => ({
  type: 'assistant',
  message: { role: 'assistant', content: tools.map((t) => ({ type: 'tool_use', ...t })) },
})
const edit = { name: 'Edit', input: { file_path: '/x/y.ts' } }
const read = { name: 'Read', input: { file_path: '/x/y.ts' } }
const grep = { name: 'Grep', input: { pattern: 'foo' } }
const fork = { name: 'Agent', input: { subagent_type: 'fork', prompt: 'review' } }
const freshAgent = { name: 'Agent', input: { subagent_type: 'general-purpose', prompt: 'go' } }
const bash = (command) => ({ name: 'Bash', input: { command } })

// exit 0 = the turn ends normally; exit 2 = blocked, and stderr is handed back to the agent.
function verdict(entries, { env = {}, transcript } = {}) {
  const file = transcript === null ? path.join(dir, 'missing.jsonl') : path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
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
  // ── must BLOCK: the turn made claims nothing has checked ────────────────────────────────────
  [[user('go'), assistant(edit)], 'block', 'an edited file is a claim about the code'],
  [[user('go'), assistant(bash('git commit -m "x"'))], 'block', 'a commit asserts the work is sound'],
  [[user('go'), assistant(bash('cat design/tasks/TRDD-2026-AAAA-x.md'))], 'block', 'touching a TRDD moves the board'],
  [[user('go'), assistant(read), assistant(edit)], 'block', 'an edit anywhere in the turn counts'],
  [[user('go'), assistant({ name: 'Write', input: {} })], 'block', 'Write is an editor'],

  // ── must ALLOW: the loop guard ──────────────────────────────────────────────────────────────
  [[user('go'), assistant(edit), assistant(fork)], 'allow', 'THE LOOP GUARD — this turn already spawned the reviewer'],
  [[user('go'), assistant(fork)], 'allow', 'a bare fork spawn is the review turn itself'],

  // ── must ALLOW: nothing was claimed ─────────────────────────────────────────────────────────
  [[user('go'), assistant(read, grep)], 'allow', 'a read-only turn has no claim to check'],
  [[user('go')], 'allow', 'a turn with no tool calls at all'],
  [[user('go'), assistant(bash('ls -l'))], 'allow', 'an ordinary shell command is not a commit'],
  [[user('go'), assistant(bash('git status'))], 'allow', 'git status changes nothing'],
  [[user('go'), assistant(bash('echo "never run git commit blindly"'))], 'block', 'prose about committing is indistinguishable from committing here — accepted false positive, it only costs one review'],
  [[user('go'), assistant(freshAgent)], 'allow', 'a non-fork subagent is not the reviewer'],

  // ── must ALLOW: the turn boundary is the last USER message ──────────────────────────────────
  [[user('go'), assistant(edit), user('next'), assistant(read)], 'allow', 'the edit belongs to the PREVIOUS turn'],
  [[user('go'), assistant(read), user('next'), assistant(edit)], 'block', 'the edit is in THIS turn'],
  [
    [user('go'), assistant(edit), assistant(fork), { type: 'user', isMeta: true, message: { content: 'hook output' } }],
    'allow',
    'a meta entry does not open a new turn, so the fork guard still sees the spawn',
  ],

  // ── must ALLOW: a hook that cannot read its input must never wedge the session ───────────────
  [[], 'allow', 'an empty transcript'],
  [[user('go'), assistant(edit)], 'allow', 'the OFF SWITCH', { env: { AGENTLENS_REVIEW_FORK: 'off' } }],
  [[user('go'), assistant(edit)], 'allow', 'a missing transcript file', { transcript: null }],
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

// FALSIFY THE LOOP GUARD. A test that cannot fail on a broken implementation is documentation,
// not a gate — so break the guard's own predicate and prove the suite reddens.
const src = fs.readFileSync(HOOK, 'utf8')
const mutated = path.join(dir, 'mutant.js')
fs.writeFileSync(mutated, src.replace("t?.input?.subagent_type === 'fork'", "t?.input?.subagent_type === 'NEVER'"))
let mutantBlocked = false
try {
  execFileSync('node', [mutated], {
    input: JSON.stringify({ transcript_path: (() => {
      const f = path.join(dir, 'mut.jsonl')
      fs.writeFileSync(f, [user('go'), assistant(edit), assistant(fork)].map((e) => JSON.stringify(e)).join('\n') + '\n')
      return f
    })() }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
} catch (e) {
  if (e.status === 2) mutantBlocked = true
}
if (mutantBlocked) pass++
else failures.push({ want: 'mutant blocks', got: 'mutant allowed', why: 'MUTATION: a broken loop guard must be caught by this suite' })

fs.rmSync(dir, { recursive: true, force: true })

for (const f of failures) console.error(`FAIL  want=${f.want} got=${f.got}\n      why: ${f.why}`)
console.log(`stop-spawn-review-fork: ${pass}/${CASES.length + 2} passed`)
process.exit(failures.length ? 1 : 0)
