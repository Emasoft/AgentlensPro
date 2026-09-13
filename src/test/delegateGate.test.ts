import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { decideDelegateGate, DELEGATE_DENY_REASON, runDelegateGate } from '../cli/delegateGate'

/** One `assistant` transcript line whose `message.model` the gate reads. */
function assistantLine(model: string): string {
  return JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'text', text: 'ok' }] } })
}

function writeTranscript(dir: string, name: string, model: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, assistantLine(model) + '\n')
  return p
}

/** A transcript with one `assistant` line per model, in order — the LAST array entry is the
 *  LAST line in the file (most recent). Used to test `recentAssistantModels`'s 5-entry window. */
function writeTranscriptLines(dir: string, name: string, models: string[]): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, models.map(assistantLine).join('\n') + '\n')
  return p
}

/** A line with no `message.model` field at all — the "harness utility call" shape. */
function noModelLine(): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } })
}

suite('delegate-gate — Fable plans, Sonnet executes (PreToolUse)', () => {
  let root: string

  setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-delegate-gate-')) })
  teardown(() => { fs.rmSync(root, { recursive: true, force: true }) })

  test('main transcript on Fable, Edit under the repo -> DENY with DELEGATE_DENY_REASON', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, true)
    assert.strictEqual(v.reason, DELEGATE_DENY_REASON)
  })

  // (b) a Sonnet SUBAGENT (agent_id set): the PARENT transcript is Fable, but the resolved
  // subagent file <session-dir>/subagents/agent-<id>.jsonl carries the Sonnet worker's own
  // model -> allow. This is the whole point of agent_id resolution: a Sonnet lean-worker must
  // not be refused just because its parent happens to be Fable.
  test('(b) parent transcript_path + agent_id, subagent file on Sonnet -> allow', () => {
    const parent = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const subDir = path.join(root, 'main', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    writeTranscript(subDir, 'agent-abc.jsonl', 'claude-sonnet-5')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: parent, agent_id: 'abc', cwd: root })
    assert.strictEqual(v.deny, false)
  })

  // (b2) same shape, but the subagent file is ITSELF on Fable/Mythos (a fork inheriting the
  // parent's model, spawned as a worker) -> DENY. Proves the fix isn't "any /subagents/ path
  // allows" — a fork-as-worker must still be gated on its own resolved model.
  test('(b2) parent transcript_path + agent_id, subagent file on Fable -> DENY (fork-as-worker)', () => {
    const parent = writeTranscript(root, 'main.jsonl', 'claude-sonnet-5')
    const subDir = path.join(root, 'main', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    writeTranscript(subDir, 'agent-abc.jsonl', 'claude-fable-5-1')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: parent, agent_id: 'abc', cwd: root })
    assert.strictEqual(v.deny, true)
    assert.strictEqual(v.reason, DELEGATE_DENY_REASON)
  })

  // (b3) agent_id is set but the resolved subagent file doesn't exist on disk yet -> allow,
  // with a note that says so (not the generic "no model readable" — the caller should be able
  // to tell "we looked for a subagent transcript and it wasn't there" from "no agent_id at all").
  test('(b3) agent_id set, no subagent file on disk -> allow, note mentions subagent transcript absent', () => {
    const parent = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: parent, agent_id: 'missing', cwd: root })
    assert.strictEqual(v.deny, false)
    assert.ok(v.note?.includes('subagent transcript absent'), `note was: ${v.note}`)
  })

  // (b4) main transcript: an earlier assistant entry is Fable, but the LAST assistant entry is
  // a harness utility call stamped "model":"sonnet" -> still DENY. Proves the gate checks the
  // last FIVE entries, not just the last one.
  test('(b4) main transcript, Fable then a trailing "sonnet"-stamped utility call -> DENY', () => {
    const transcript = writeTranscriptLines(root, 'main.jsonl', ['claude-fable-5-1', 'sonnet'])
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, true)
    assert.strictEqual(v.reason, DELEGATE_DENY_REASON)
  })

  // (b5) the last 5 assistant entries all lack message.model entirely -> allow, with the
  // no-model note (there is nothing to gate on).
  test('(b5) last 5 assistant entries have no message.model -> allow + no-model note', () => {
    const p = path.join(root, 'main.jsonl')
    fs.writeFileSync(p, Array.from({ length: 5 }, noModelLine).join('\n') + '\n')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: p, cwd: root })
    assert.strictEqual(v.deny, false)
    assert.strictEqual(v.note, '[delegate-gate] allowing: no model readable')
  })

  // (b6) skip-not-count: the FIRST assistant entry is Fable, then FIVE consecutive
  // model-less entries follow it. recentAssistantModels must SKIP the model-less entries
  // rather than counting them toward its 5-slot window — so the Fable entry is still found
  // and the call is denied. A buggy implementation that counted model-less entries as ''
  // would fill all 5 slots before ever reaching the Fable entry, and wrongly allow.
  test('(b6) Fable entry followed by 5 model-less entries -> DENY (model-less entries are skipped, not counted)', () => {
    const p = path.join(root, 'main.jsonl')
    const lines = [assistantLine('claude-fable-5-1'), ...Array.from({ length: 5 }, noModelLine)]
    fs.writeFileSync(p, lines.join('\n') + '\n')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: p, cwd: root })
    assert.strictEqual(v.deny, true)
    assert.strictEqual(v.reason, DELEGATE_DENY_REASON)
  })

  // (b7) transcript_path ITSELF already points at a resolved subagent file
  // (.../subagents/agent-<id>.jsonl) and agent_id is ALSO set — resolveTranscript must use
  // transcript_path as-is rather than appending a second subagents/agent-<id>.jsonl segment
  // onto it (which would compute a nonexistent nested path).
  test('(b7) transcript_path is already a subagent file + agent_id set, file on Sonnet -> allow', () => {
    const subDir = path.join(root, 'main', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    const subFile = writeTranscript(subDir, 'agent-abc.jsonl', 'claude-sonnet-5')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: subFile, agent_id: 'abc', cwd: root })
    assert.strictEqual(v.deny, false)
  })

  test('(b7) same shape, subagent file on Fable -> DENY', () => {
    const subDir = path.join(root, 'main', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    const subFile = writeTranscript(subDir, 'agent-abc.jsonl', 'claude-fable-5-1')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: subFile, agent_id: 'abc', cwd: root })
    assert.strictEqual(v.deny, true)
    assert.strictEqual(v.reason, DELEGATE_DENY_REASON)
  })

  test('main transcript on Sonnet -> allow (only Fable/Mythos main sessions are gated)', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-sonnet-5')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, false)
  })

  test('Fable, Write under /tmp -> allow (planning artefact)', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    // Literal /tmp, never os.tmpdir() — on macOS $TMPDIR is /var/folders/..., NOT /tmp, and the
    // gate only exempts the LITERAL prefixes /tmp and /private/tmp (isEphemeralTarget).
    const tmpFile = `/tmp/al-delegate-gate-plan-${process.pid}.md`
    const v = decideDelegateGate({ tool_name: 'Write', tool_input: { file_path: tmpFile }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, false)
  })

  test('Fable, Write under <cwd>/reports_dev/ -> allow (planning artefact)', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const file = path.join(root, 'reports_dev', 'x.md')
    const v = decideDelegateGate({ tool_name: 'Write', tool_input: { file_path: file }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, false)
  })

  // (d2) ~/.claude/plans/ is a planning artefact even though isEphemeralTarget doesn't cover it.
  // HOME is swapped to a tmp dir for the duration of the test (os.homedir() reads process.env.HOME
  // on POSIX) and restored in a finally so no other test observes the override.
  test('(d2) Fable, Write to <HOME>/.claude/plans/x.md -> allow', () => {
    const realHome = process.env.HOME
    process.env.HOME = root
    try {
      const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
      const plansDir = path.join(root, '.claude', 'plans')
      fs.mkdirSync(plansDir, { recursive: true })
      const file = path.join(plansDir, 'x.md')
      const v = decideDelegateGate({ tool_name: 'Write', tool_input: { file_path: file }, transcript_path: transcript, cwd: root })
      assert.strictEqual(v.deny, false)
    } finally {
      process.env.HOME = realHome
    }
  })

  test('Fable, Bash "git commit -m x" -> allow (git stays in the main context)', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const v = decideDelegateGate({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, false)
  })

  test('Fable, Bash "gh issue comment 1 -b x" -> allow (GitHub issues stay in the main context)', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const v = decideDelegateGate({ tool_name: 'Bash', tool_input: { command: 'gh issue comment 1 -b x' }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, false)
  })

  test('Fable, Bash "sed -i \'\' \'s/a/b/\' <repo>/src/x.ts" -> DENY', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Bash', tool_input: { command: `sed -i '' 's/a/b/' ${file}` }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, true)
    assert.strictEqual(v.reason, DELEGATE_DENY_REASON)
  })

  test('Fable, Bash "echo hi > <repo>/src/x.ts" -> DENY', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Bash', tool_input: { command: `echo hi > ${file}` }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, true)
    assert.strictEqual(v.reason, DELEGATE_DENY_REASON)
  })

  test('Fable, Bash "grep -rn foo <repo>/src" -> allow (read-only)', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const v = decideDelegateGate({ tool_name: 'Bash', tool_input: { command: `grep -rn foo ${path.join(root, 'src')}` }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, false)
  })

  test('(e2) Fable, Bash "FOO=1 git commit -m \\"x; y\\"" -> allow (leading assignment skipped)', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const v = decideDelegateGate({ tool_name: 'Bash', tool_input: { command: 'FOO=1 git commit -m "x; y"' }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, false)
  })

  test('(e2) Fable, Bash "sudo gh issue comment 1 -b x" -> allow (sudo wrapper skipped)', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const v = decideDelegateGate({ tool_name: 'Bash', tool_input: { command: 'sudo gh issue comment 1 -b x' }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, false)
  })

  test('(e2) Fable, Bash "cd /x && sed -i \'\' s/a/b/ <repo>/src/x.ts" -> DENY (first word is not git/gh)', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Bash', tool_input: { command: `cd /x && sed -i '' s/a/b/ ${file}` }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, true)
    assert.strictEqual(v.reason, DELEGATE_DENY_REASON)
  })

  test('(f2) Fable, Bash "echo x > /private/tmp/claude-501/scratch/y.txt" -> allow (ephemeral target)', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const v = decideDelegateGate({ tool_name: 'Bash', tool_input: { command: 'echo x > /private/tmp/claude-501/scratch/y.txt' }, transcript_path: transcript, cwd: root })
    assert.strictEqual(v.deny, false)
  })

  test('(j) DELEGATE_DENY_REASON does not advertise the env kill-switch', () => {
    assert.ok(!DELEGATE_DENY_REASON.includes('Off switch'), DELEGATE_DENY_REASON)
  })

  test('e2e: runDelegateGate with agent_id + a Sonnet subagent file -> allow (empty string)', () => {
    const parent = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const subDir = path.join(root, 'main', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    writeTranscript(subDir, 'agent-xyz.jsonl', 'claude-sonnet-5')
    const file = path.join(root, 'src', 'x.ts')
    const payload = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: parent, agent_id: 'xyz', cwd: root })
    assert.strictEqual(runDelegateGate(payload), '')
  })

  test('AGENTLENS_DELEGATE_GATE=off -> allow, whatever the model or tool', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate(
      { tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: transcript, cwd: root },
      { AGENTLENS_DELEGATE_GATE: 'off' } as NodeJS.ProcessEnv,
    )
    assert.strictEqual(v.deny, false)
    assert.strictEqual(v.note, '[delegate-gate] disabled by env')
  })

  test('missing transcript -> allow, never deny', () => {
    const missing = path.join(root, 'nope.jsonl')
    const file = path.join(root, 'src', 'x.ts')
    const v = decideDelegateGate({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: missing, cwd: root })
    assert.strictEqual(v.deny, false)
    assert.strictEqual(v.note, '[delegate-gate] allowing: no model readable')
  })

  test('runDelegateGate returns the DENY hookSpecificOutput payload on a real denial', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-fable-5-1')
    const file = path.join(root, 'src', 'x.ts')
    const payload = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: transcript, cwd: root })
    const out = runDelegateGate(payload)
    assert.notStrictEqual(out, '')
    const parsed = JSON.parse(out)
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny')
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecisionReason, DELEGATE_DENY_REASON)
  })

  test('runDelegateGate returns empty string on allow', () => {
    const transcript = writeTranscript(root, 'main.jsonl', 'claude-sonnet-5')
    const file = path.join(root, 'src', 'x.ts')
    const payload = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file }, transcript_path: transcript, cwd: root })
    assert.strictEqual(runDelegateGate(payload), '')
  })
})
