#!/usr/bin/env node
// Matrix for ~/.claude/hooks/subagent-stop-spawn-review-fork.js — mirrors
// scripts/test-stop-spawn-review-fork.js but for the SUBAGENT gate, whose contract differs on
// purpose (TRDD-6QV50JNN STATE block): ONE demand per agent (not two), scoped by `agent_id` (not
// `session_id`), decided from `agent_transcript_path` (not `transcript_path`), block is a JSON
// stdout line + exit 0 (not stderr + exit 2), and it defaults OBSERVE-ONLY — enforcement needs
// AGENTLENS_SUBAGENT_REVIEW=on. The script itself lives outside this repo (user-scope hook, not
// shipped by the package — see hookInstall.ts LEGACY_REVIEW_SCRIPTS); this test exercises the
// REAL file on disk, no stub of the hook.

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const HOOK = path.join(os.homedir(), '.claude', 'hooks', 'subagent-stop-spawn-review-fork.js')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `subagentfork-${process.pid}-`))

const assistant = (...tools) => ({
  type: 'assistant',
  message: { role: 'assistant', content: tools.map((t) => ({ type: 'tool_use', ...t })) },
})
const edit = { name: 'Edit', input: { file_path: '/x/y.ts' } }
const read = { name: 'Read', input: { file_path: '/x/y.ts' } }
const fork = { name: 'Agent', input: { subagent_type: 'fork', prompt: 'review' } }
const bash = (command) => ({ name: 'Bash', input: { command } })

// Returns 'block' | 'allow' | an error string. `agentId` defaults to a unique value per call —
// the cap is keyed on it, so a shared id across unrelated cases would let one case's demand
// silently exhaust another's budget.
function verdict(entries, { env = {}, agentId, agentType = 'lean-worker', event = 'SubagentStop', own } = {}) {
  const file = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
  if (own !== null) fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const payload = {
    hook_event_name: event,
    agent_id: agentId || `agent-${process.pid}-${Math.random().toString(36).slice(2)}`,
    agent_type: agentType,
    session_id: `parent-${process.pid}`,
    transcript_path: '/does/not/matter/parent.jsonl',
    agent_transcript_path: own !== null ? file : undefined,
  }
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, AGENTLENS_SUBAGENT_REVIEW: 'on', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (out.includes('"decision":"block"')) return 'block'
  if (out.trim() === '') return 'allow'
  return `ERROR(unexpected stdout): ${out.slice(0, 200)}`
}

const CASES = [
  // ── edit ─────────────────────────────────────────────────────────────────────────────────────
  [[assistant(edit)], 'block', 'an edit with no fork is unreviewed work'],
  [[assistant(bash('git commit -m "x"'))], 'block', 'a commit asserts the work is sound, same as the main gate'],
  [[assistant(edit), assistant(fork)], 'allow', 'the work was reviewed — a fork followed the edit'],

  // ── no-edit ──────────────────────────────────────────────────────────────────────────────────
  [[assistant(read)], 'allow', 'a read-only subagent turn has no claim to check'],
  [[], 'allow', 'no tool calls at all'],
  [[assistant(bash('ls -l'))], 'allow', 'an ordinary shell command is not a commit'],

  // ── recursion guard: a reviewer must never be reviewed ──────────────────────────────────────
  [[assistant(edit)], 'allow', 'the reviewer fork itself is skipped by agent_type', { agentType: 'fork' }],
  [[assistant(edit)], 'allow', 'empty agent_type is the internal micro-lookup class — skipped', { agentType: '' }],

  // ── must ALLOW: a hook that cannot read its input must never wedge the agent ────────────────
  [[assistant(edit)], 'allow', 'the OFF SWITCH', { env: { AGENTLENS_SUBAGENT_REVIEW: 'off' } }],
  [[assistant(edit)], 'allow', 'observe-only default when the env var is unset', { env: { AGENTLENS_SUBAGENT_REVIEW: '' } }],
  [[assistant(edit)], 'allow', 'a missing agent_transcript_path', { own: null }],
  [[assistant(edit)], 'allow', 'a non-SubagentStop event bails', { event: 'Stop' }],
]

let pass = 0
const failures = []
for (const [entries, want, why, opts] of CASES) {
  const got = verdict(entries, opts)
  if (got === want) pass++
  else failures.push({ want, got, why })
}

// ── cap: ONE demand per agent, then silence — not block forever ──────────────────────────────
{
  const agentId = `cap-${process.pid}`
  const seq = [
    verdict([assistant(edit)], { agentId }),
    verdict([assistant(edit)], { agentId }),
    verdict([assistant(edit)], { agentId }),
  ]
  const ok = JSON.stringify(seq) === JSON.stringify(['block', 'allow', 'allow'])
  if (ok) pass++
  else failures.push({ want: "['block','allow','allow']", got: seq.join(','), why: 'THE CAP: one demand per agent_id, then allow — never a second demand and never a wedge' })
}

// Unparseable stdin must allow, not throw.
try {
  execFileSync('node', [HOOK], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, AGENTLENS_SUBAGENT_REVIEW: 'on' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  pass++
} catch (e) {
  failures.push({ want: 'allow', got: `exit ${e.status}`, why: 'unparseable stdin must allow the subagent to stop' })
}

// FALSIFY THE TWO SAFETY-CRITICAL GUARDS BY MUTATION — a matrix that cannot fail on a broken
// implementation is documentation, not a gate.
const src = fs.readFileSync(HOOK, 'utf8')
const MUTATIONS = [
  {
    find: "if (type === '' || /fork/i.test(type)) allow()",
    replace: 'if (false) {}',
    entries: [assistant(edit)],
    opts: { agentType: 'fork' },
    why: 'RECURSION GUARD: a broken fork-type skip must be caught — that is a review-fork storm',
  },
  {
    find: 'if ((state.demands || 0) >= MAX_DEMANDS_PER_AGENT) allow()',
    replace: 'if (false) {}',
    entries: [assistant(edit)],
    opts: { agentId: `mut-cap-${process.pid}` },
    prime: true,
    why: 'CAP GUARD: a broken demand cap must be caught — that wedges an agent that cannot comply',
  },
]
for (const [i, m] of MUTATIONS.entries()) {
  const mutSrc = src.replace(m.find, m.replace)
  if (mutSrc === src) {
    failures.push({ want: 'mutation applied', got: 'predicate not found', why: `the mutation target moved — ${m.why} is no longer falsifying anything` })
    continue
  }
  const mutated = path.join(dir, `mutant-${i}.js`)
  fs.writeFileSync(mutated, mutSrc)
  const runMutant = () => {
    const file = path.join(dir, `mut-${i}-${Math.random().toString(36).slice(2)}.jsonl`)
    fs.writeFileSync(file, m.entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    const payload = {
      hook_event_name: 'SubagentStop',
      agent_id: m.opts.agentId || `mut-${i}-${process.pid}`,
      agent_type: m.opts.agentType || 'lean-worker',
      agent_transcript_path: file,
    }
    const out = execFileSync('node', [mutated], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, AGENTLENS_SUBAGENT_REVIEW: 'on' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return out.includes('"decision":"block"')
  }
  // The cap mutation needs a REAL first demand to spend the (now-defeated) cap before the check
  // that proves the mutant still blocks a second time — i.e. run the unmutated hook once first.
  if (m.prime) verdict(m.entries, { agentId: m.opts.agentId })
  const mutantBlocked = runMutant()
  if (mutantBlocked) pass++
  else failures.push({ want: 'mutant blocks', got: 'mutant allowed', why: `MUTATION — ${m.why}` })
}

fs.rmSync(dir, { recursive: true, force: true })
for (const f of fs.readdirSync(os.tmpdir())) {
  if (/^agentlens-subagent-review-.*(cap|agent)_?[\w-]*\d*/.test(f)) {
    try { fs.unlinkSync(path.join(os.tmpdir(), f)) } catch { /* best effort */ }
  }
}

for (const f of failures) console.error(`FAIL  want=${f.want} got=${f.got}\n      why: ${f.why}`)
console.log(`subagent-stop-spawn-review-fork: ${pass}/${CASES.length + 1 + 1 + MUTATIONS.length} passed`)
process.exit(failures.length ? 1 : 0)
