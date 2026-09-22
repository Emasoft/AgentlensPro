import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'

// End-to-end coverage of `runReviewSupervisor` (src/cli/reviewSupervisor.ts) itself — the runner
// was NEVER exercised by any test even though every defect ever found in this component lived in
// the runner (block branch, event dispatch, output shape), never in the pure helpers already
// covered by reviewSupervisor.test.ts. This spawns the REAL built CLI (`review-supervisor` verb)
// against a fixture transcript + fixture settings dir, feeding the hook JSON on stdin.

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const CLI = path.join(REPO_ROOT, 'standalone', 'cli.js')

interface RunResult { code: number | null; stdout: string; stderr: string }

/** Spawn the real CLI's `review-supervisor` verb with `cwd` as the working dir and `stdin` fed in. */
function runSupervisor(cwd: string, stdinPayload: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'review-supervisor'], { cwd })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.write(stdinPayload)
    child.stdin.end()
  })
}

const assistantLine = (blocks: unknown[]): string =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { content: blocks } })
const editBlock = { type: 'tool_use', name: 'Edit', input: {} }
// declaredRole() (reviewGate.ts) only credits a fork as a REVIEW when its prompt carries the
// `ROLE: REVIEW` marker line (owner order 2026-09-15) — a bare `subagent_type: 'fork'` with no
// prompt used to count. TRDD-D7MCI7OA: this fixture pre-dated that change, so `declaredRole('')`
// returned null (neither role), the OK-verdict test's fork was never credited, and the supervisor
// nagged "1 change(s) ... NO adversarial review fork" — the test regressed together with the gate,
// it was not the supervisor that broke.
const forkBlock = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'fork', prompt: 'ROLE: REVIEW' } }

/** Fixture: a temp cwd whose `.claude/settings.json` registers the review gate on Stop. */
function makeFixture(): { cwd: string; transcript: string; cleanup: () => void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'al-supervisor-'))
  const claudeDir = path.join(cwd, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ command: 'agentlenspro review-gate' }] }] },
  }))
  const transcript = path.join(cwd, 'transcript.jsonl')
  return { cwd, transcript, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) }
}

function writeTranscript(p: string, lines: string[]): void {
  fs.writeFileSync(p, lines.join('\n') + '\n')
}

suite('review-supervisor — real CLI runner (end-to-end)', () => {
  test('ALARM: unreviewed backlog past the threshold — non-blocking output, Stop event, alarm text', async function () {
    this.timeout(20_000)
    const f = makeFixture()
    try {
      // Three edits with no fork after them clears the UNREVIEWED_ALARM (3) threshold.
      writeTranscript(f.transcript, [assistantLine([editBlock]), assistantLine([editBlock]), assistantLine([editBlock])])
      const payload = JSON.stringify({ transcript_path: f.transcript, hook_event_name: 'Stop' })
      const r = await runSupervisor(f.cwd, payload)
      assert.strictEqual(r.code, 0, r.stderr)
      const out = JSON.parse(r.stdout) as Record<string, unknown>
      assert.ok(!('decision' in out), 'the supervisor must never emit a block decision')
      assert.ok(typeof out.systemMessage === 'string' && out.systemMessage.length > 0)
      const hso = out.hookSpecificOutput as { hookEventName?: string; additionalContext?: string }
      assert.strictEqual(hso.hookEventName, 'Stop')
      assert.ok(typeof hso.additionalContext === 'string' && hso.additionalContext.length > 0)
    } finally { f.cleanup() }
  })

  test('ALARM still fires (and still never blocks) when stop_hook_active is true — the deadlock regression guard', async function () {
    this.timeout(20_000)
    const f = makeFixture()
    try {
      writeTranscript(f.transcript, [assistantLine([editBlock]), assistantLine([editBlock]), assistantLine([editBlock])])
      const payload = JSON.stringify({ transcript_path: f.transcript, hook_event_name: 'Stop', stop_hook_active: true })
      const r = await runSupervisor(f.cwd, payload)
      assert.strictEqual(r.code, 0, r.stderr)
      const out = JSON.parse(r.stdout) as Record<string, unknown>
      assert.ok(!('decision' in out), 'stop_hook_active must never flip the supervisor into blocking')
    } finally { f.cleanup() }
  })

  test('SubagentStop event is echoed back as the discriminant', async function () {
    this.timeout(20_000)
    const f = makeFixture()
    try {
      writeTranscript(f.transcript, [assistantLine([editBlock]), assistantLine([editBlock]), assistantLine([editBlock])])
      const payload = JSON.stringify({ transcript_path: f.transcript, hook_event_name: 'SubagentStop' })
      const r = await runSupervisor(f.cwd, payload)
      assert.strictEqual(r.code, 0, r.stderr)
      const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string } }
      assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SubagentStop')
    } finally { f.cleanup() }
  })

  test('UserPromptSubmit event is echoed back as the discriminant', async function () {
    this.timeout(20_000)
    const f = makeFixture()
    try {
      writeTranscript(f.transcript, [assistantLine([editBlock]), assistantLine([editBlock]), assistantLine([editBlock])])
      const payload = JSON.stringify({ transcript_path: f.transcript, hook_event_name: 'UserPromptSubmit' })
      const r = await runSupervisor(f.cwd, payload)
      assert.strictEqual(r.code, 0, r.stderr)
      const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string } }
      assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
    } finally { f.cleanup() }
  })

  test('OK verdict: a fork after the changes and a registered gate produce exit 0 with EMPTY stdout', async function () {
    this.timeout(20_000)
    const f = makeFixture()
    try {
      writeTranscript(f.transcript, [assistantLine([editBlock]), assistantLine([forkBlock])])
      const payload = JSON.stringify({ transcript_path: f.transcript, hook_event_name: 'Stop' })
      const r = await runSupervisor(f.cwd, payload)
      assert.strictEqual(r.code, 0, r.stderr)
      assert.strictEqual(r.stdout, '', 'a healthy session must produce no output at all')
    } finally { f.cleanup() }
  })

  test('malformed/empty stdin does not crash the runner: exit 0', async function () {
    this.timeout(20_000)
    const f = makeFixture()
    try {
      const r = await runSupervisor(f.cwd, 'not json at all {{{')
      assert.strictEqual(r.code, 0, r.stderr)
    } finally { f.cleanup() }
  })

  test('a missing/nonexistent transcript_path does not crash the runner: exit 0', async function () {
    this.timeout(20_000)
    const f = makeFixture()
    try {
      const payload = JSON.stringify({ transcript_path: path.join(f.cwd, 'does-not-exist.jsonl'), hook_event_name: 'Stop' })
      const r = await runSupervisor(f.cwd, payload)
      assert.strictEqual(r.code, 0, r.stderr)
    } finally { f.cleanup() }
  })
})
