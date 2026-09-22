import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  gatedCall, scanCycles, mayWrite, roledForkRunnerAllowed, roledForkExemptScript,
  MEASURE_HEADING, REVIEW_HEADING,
} from '../cli/reviewLoop'
import type { GatedCallInput } from '../cli/reviewLoop'

// Each test's fixture is a REAL temp directory with a real JSONL file (and, for subagent cases, a
// real subagents/ directory) — no mocking of the logic under test, per the plan's own requirement.
// Paths are built from `os.tmpdir()` only; nothing here writes into a real HOME or a real project.

const CWD = '/proj'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'))
}

// ── JSONL fixture builders ──────────────────────────────────────────────────────────────────

function assistantText(text: string, ts: string): string {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } })
}
function assistantAgentSpawn(id: string, prompt: string, ts: string, isFork = true): string {
  return JSON.stringify({
    type: 'assistant', timestamp: ts,
    message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: isFork ? 'fork' : 'lean-worker', prompt } }] },
  })
}
function userForegroundResult(toolUseId: string, text: string, ts: string): string {
  return JSON.stringify({
    type: 'user', timestamp: ts,
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] },
  })
}
function userNotification(taskId: string, toolUseId: string | null, status: string, body: string, ts: string): string {
  const tid = toolUseId !== null ? `<tool-use-id>${toolUseId}</tool-use-id>\n` : ''
  const content = `<task-notification>\n<task-id>${taskId}</task-id>\n${tid}<status>${status}</status>\n${body}`
  return JSON.stringify({ type: 'user', timestamp: ts, message: { content } })
}

function write(dir: string, name: string, lines: string[]): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, lines.join('\n') + '\n')
  return p
}

const T0 = '2026-09-14T10:00:00+0200'
const T1 = '2026-09-14T10:01:00+0200'
const T2 = '2026-09-14T10:02:00+0200'
const T3 = '2026-09-14T10:03:00+0200'
const T4 = '2026-09-14T10:04:00+0200'

const PROPOSAL_TEXT = 'PROPOSAL FOR ACTION - PLEASE REVIEW\nchange the widget rendering path to avoid the double layout pass'

// A1' round 2: the key is derived from the proposal's CONTENT (everything after the marker
// line), never the marker text itself — this is what the fixed key must be checked against.
const PROPOSAL_CONTENT = PROPOSAL_TEXT.split('\n').slice(1).join('\n')

function bothSpawns(measureTs = T1, reviewTs = T2): string[] {
  return [
    assistantAgentSpawn('tu_measure', `ROLE: MEASURE\n${PROPOSAL_TEXT}`, measureTs),
    assistantAgentSpawn('tu_review', `ROLE: REVIEW\n${PROPOSAL_TEXT}`, reviewTs),
  ]
}
function bothConfirmed(ts = T3): string[] {
  return [
    userForegroundResult('tu_measure', `${MEASURE_HEADING}\nconfirmed.`, ts),
    userForegroundResult('tu_review', `${REVIEW_HEADING}\nconfirmed.`, ts),
  ]
}

function mainInput(transcriptPath: string, toolName = 'Edit', toolInput: unknown = { file_path: '/proj/src/a.ts' }): Parameters<typeof mayWrite>[0] {
  return { transcriptPath, cwd: CWD, toolName, toolInput }
}

suite('review-loop-A1-prime-content-derived-key', () => {
  // A1' (2026-09-22, round 2): the key is now derived from the proposal CONTENT (the text
  // after the marker line), not the constant marker itself — a marker with no content must
  // never bind any spawn (proposalKey returns '', and scanCycles/missingReasonOf guard on it).
  test("A1'. a marker with no content after it -> no key, no spawn binds, deny names 'no body'", () => {
    const dir = tmpDir()
    const p = write(dir, 'main.jsonl', [
      assistantText('PROPOSAL FOR ACTION - PLEASE REVIEW', T0),
      assistantAgentSpawn('tu_m', 'ROLE: MEASURE\nanything at all here', T1),
      assistantAgentSpawn('tu_r', 'ROLE: REVIEW\nanything at all here', T2),
    ])
    const cycles = scanCycles(fs.readFileSync(p, 'utf8').split('\n'), { cwd: CWD })
    const cur = cycles[cycles.length - 1]
    assert.strictEqual(cur.proposal.key, '')
    assert.strictEqual(cur.spawns.measure, null)
    assert.strictEqual(cur.spawns.review, null)
    const r = mayWrite(mainInput(p))
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.missing, 'key-missing')
    assert.ok(r.reason?.includes('no body'))
  })

  test("A1'. two proposals sharing the same >=24-char first content line but diverging later text -> a spawn quoting P1 does not credit P2", () => {
    const dir = tmpDir()
    const shared = 'Rationale in one sentence: this change is safe'
    const p1Body = `${shared}\nP1-only detail: touches module Alpha`
    const p2Body = `${shared}\nP2-only detail: touches module Beta`
    const p = write(dir, 'main.jsonl', [
      assistantText(`PROPOSAL FOR ACTION - PLEASE REVIEW\n${p1Body}`, T0),
      assistantAgentSpawn('tu_m1', `ROLE: MEASURE\nPROPOSAL FOR ACTION - PLEASE REVIEW\n${p1Body}`, T1),
      assistantAgentSpawn('tu_r1', `ROLE: REVIEW\nPROPOSAL FOR ACTION - PLEASE REVIEW\n${p1Body}`, T2),
      assistantText(`PROPOSAL FOR ACTION - PLEASE REVIEW\n${p2Body}`, T4),
    ])
    const cycles = scanCycles(fs.readFileSync(p, 'utf8').split('\n'), { cwd: CWD })
    assert.strictEqual(cycles.length, 2)
    assert.notStrictEqual(cycles[0].proposal.key, cycles[1].proposal.key)
    assert.notStrictEqual(cycles[0].spawns.measure, null)
    assert.notStrictEqual(cycles[0].spawns.review, null)
    assert.strictEqual(cycles[1].spawns.measure, null)
    assert.strictEqual(cycles[1].spawns.review, null)
  })
})

suite('review-loop D2/D3: mayWrite over the main transcript', () => {
  // Test 1: a write with no proposal at all → deny.
  test('1. a write with no proposal in the transcript → deny', () => {
    const dir = tmpDir()
    const p = write(dir, 'main.jsonl', [assistantText('just some prose', T0)])
    const r = mayWrite(mainInput(p))
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.missing, 'no-proposal')
  })

  // Test 2: proposal plus both forks spawned but neither has returned → deny.
  test('2. proposal + both forks spawned, neither returned → deny', () => {
    const dir = tmpDir()
    const p = write(dir, 'main.jsonl', [assistantText(PROPOSAL_TEXT, T0), ...bothSpawns()])
    const r = mayWrite(mainInput(p))
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.missing, 'role-running')
  })

  // Test 3: one role confirmed, the other still running → deny.
  test('3. one role confirmed, the other still running → deny', () => {
    const dir = tmpDir()
    const p = write(dir, 'main.jsonl', [
      assistantText(PROPOSAL_TEXT, T0), ...bothSpawns(),
      userForegroundResult('tu_measure', `${MEASURE_HEADING}\nconfirmed.`, T3),
    ])
    const r = mayWrite(mainInput(p))
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.missing, 'role-running')
  })

  // Test 4: both confirmed → allow.
  test('4. both roles confirmed with their headings → allow', () => {
    const dir = tmpDir()
    const p = write(dir, 'main.jsonl', [assistantText(PROPOSAL_TEXT, T0), ...bothSpawns(), ...bothConfirmed()])
    const r = mayWrite(mainInput(p))
    assert.strictEqual(r.allow, true)
  })

  // Test 5: a NEW proposal closes the previous window — a write after it, with no new pair, denies.
  test('5. a new PROPOSAL closes the previous window', () => {
    const dir = tmpDir()
    const p = write(dir, 'main.jsonl', [
      assistantText(PROPOSAL_TEXT, T0), ...bothSpawns(), ...bothConfirmed(),
      assistantText('PROPOSAL FOR ACTION - PLEASE REVIEW\na second, unrelated change', T4),
    ])
    const r = mayWrite(mainInput(p))
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.missing, 'role-not-spawned')
  })

  // Test 6 (PreToolUse half — the Stop-gate S2 backstop is stage 2, out of scope here): an Edit
  // tool_use recorded in the transcript AFTER both spawns but BEFORE either confirms is exactly
  // the "spawn both, then edit before they return" shape; mayWrite for that same moment denies.
  test('6. an edit attempted before either fork has returned → deny (the PreToolUse half)', () => {
    const dir = tmpDir()
    const p = write(dir, 'main.jsonl', [assistantText(PROPOSAL_TEXT, T0), ...bothSpawns()])
    const r = mayWrite(mainInput(p))
    assert.strictEqual(r.allow, false)
  })

  // Test 7: a foreground Read/Bash tool_result that merely QUOTES a heading must not credit — only
  // the SPAWN's OWN result (matched by tool_use_id) may.
  test('7. reading a report that CONTAINS a heading, via an unrelated tool_use_id, does not confirm', () => {
    const dir = tmpDir()
    const p = write(dir, 'main.jsonl', [
      assistantText(PROPOSAL_TEXT, T0), ...bothSpawns(),
      // A `Read` of an old report — same shape as a tool_result, but a DIFFERENT tool_use_id.
      userForegroundResult('tu_unrelated_read', `${MEASURE_HEADING}\nthis is an old report, not the spawn's own result.`, T3),
      userForegroundResult('tu_review', `${REVIEW_HEADING}\nconfirmed.`, T3),
    ])
    const r = mayWrite(mainInput(p))
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.missing, 'role-running') // measure never actually confirmed
  })

  // Test 8: a completed result without its heading → deny, reason names the missing state.
  test('8. a completed result without its heading → deny', () => {
    const dir = tmpDir()
    const p = write(dir, 'main.jsonl', [
      assistantText(PROPOSAL_TEXT, T0), ...bothSpawns(),
      userForegroundResult('tu_measure', 'no heading here, just prose.', T3),
      userForegroundResult('tu_review', `${REVIEW_HEADING}\nconfirmed.`, T3),
    ])
    const r = mayWrite(mainInput(p))
    assert.strictEqual(r.allow, false)
    // A1' round 2: the reason quotes the CONTENT-derived key now, never the constant marker text.
    assert.ok((r.reason?.length ?? 0) > 0 && r.reason?.includes(PROPOSAL_CONTENT.slice(0, 24)))
  })

  // Test 9: status failed/killed/stopped → no credit (background notification path).
  test('9. a background notification with status failed/killed/stopped never confirms', () => {
    for (const status of ['failed', 'killed', 'stopped']) {
      const dir = tmpDir()
      const p = write(dir, 'main.jsonl', [
        assistantText(PROPOSAL_TEXT, T0), ...bothSpawns(),
        userNotification('job1', 'tu_measure', status, `${MEASURE_HEADING}\n...`, T3),
        userForegroundResult('tu_review', `${REVIEW_HEADING}\nconfirmed.`, T3),
      ])
      const r = mayWrite(mainInput(p))
      assert.strictEqual(r.allow, false, status)
    }
  })

  // Test 10: the key must appear in the prompt (reflowed/markdown-stripped still counts); missing
  // key entirely → not a role spawn (so the cycle stays unspawned).
  test('10. key missing from the prompt → not a role spawn; a markdown-decorated key still counts', () => {
    const dir = tmpDir()
    const p1 = write(dir, 'no-key.jsonl', [
      assistantText(PROPOSAL_TEXT, T0),
      assistantAgentSpawn('tu_m', 'ROLE: MEASURE\nmeasure something unrelated', T1),
      assistantAgentSpawn('tu_r', 'ROLE: REVIEW\nreview something unrelated', T2),
    ])
    const cycles1 = scanCycles(fs.readFileSync(p1, 'utf8').split('\n'), { cwd: CWD })
    assert.strictEqual(cycles1[cycles1.length - 1].spawns.measure, null)

    const dir2 = tmpDir()
    const p2 = write(dir2, 'decorated-key.jsonl', [
      assistantText(PROPOSAL_TEXT, T0),
      assistantAgentSpawn('tu_m', `ROLE: MEASURE\n**${PROPOSAL_TEXT.replace('the widget', 'the *widget*')}**`, T1),
    ])
    const cycles2 = scanCycles(fs.readFileSync(p2, 'utf8').split('\n'), { cwd: CWD })
    assert.notStrictEqual(cycles2[cycles2.length - 1].spawns.measure, null)
  })

  // Test 11: the marker on a LATER line of the prompt (not the first) → not a role spawn.
  test('11. ROLE: on a later line of the prompt → not a role spawn', () => {
    const dir = tmpDir()
    const p = write(dir, 'main.jsonl', [
      assistantText(PROPOSAL_TEXT, T0),
      assistantAgentSpawn('tu_m', `Some preamble.\nROLE: MEASURE\n${PROPOSAL_TEXT}`, T1),
    ])
    const cycles = scanCycles(fs.readFileSync(p, 'utf8').split('\n'), { cwd: CWD })
    assert.strictEqual(cycles[cycles.length - 1].spawns.measure, null)
  })

  // Test 12: a non-fork role spawn → not a role spawn.
  test('12. subagent_type other than fork → not a role spawn', () => {
    const dir = tmpDir()
    const p = write(dir, 'main.jsonl', [
      assistantText(PROPOSAL_TEXT, T0),
      assistantAgentSpawn('tu_m', `ROLE: MEASURE\n${PROPOSAL_TEXT}`, T1, /* isFork */ false),
    ])
    const cycles = scanCycles(fs.readFileSync(p, 'utf8').split('\n'), { cwd: CWD })
    assert.strictEqual(cycles[cycles.length - 1].spawns.measure, null)
  })

  // Test A2: the role marker is the FIRST NON-BLANK line after trimEnd() — a leading blank line
  // is skipped, but a leading space on the marker line itself is not (spec item A2).
  test('A2. a leading blank line before ROLE: still counts; a leading space does not', () => {
    const dir = tmpDir()
    const p1 = write(dir, 'blank-first-line.jsonl', [
      assistantText(PROPOSAL_TEXT, T0),
      assistantAgentSpawn('tu_r', `\nROLE: REVIEW\n${PROPOSAL_TEXT}`, T1),
    ])
    const cycles1 = scanCycles(fs.readFileSync(p1, 'utf8').split('\n'), { cwd: CWD })
    assert.notStrictEqual(cycles1[cycles1.length - 1].spawns.review, null)

    const dir2 = tmpDir()
    const p2 = write(dir2, 'leading-space.jsonl', [
      assistantText(PROPOSAL_TEXT, T0),
      assistantAgentSpawn('tu_r', ` ROLE: REVIEW\n${PROPOSAL_TEXT}`, T1),
    ])
    const cycles2 = scanCycles(fs.readFileSync(p2, 'utf8').split('\n'), { cwd: CWD })
    assert.strictEqual(cycles2[cycles2.length - 1].spawns.review, null)
  })

  // Test 15: a notification body carrying a harness prefix line before <task-notification> still
  // confirms, AS LONG AS the preamble (before <summary>/<result>) still carries a real <task-id>.
  test('15. a notification whose preamble still carries <task-id> confirms, even with trailing summary text', () => {
    const dir = tmpDir()
    const body = `${MEASURE_HEADING}\nfindings here.\n<summary>a short summary the harness appended</summary>`
    const p = write(dir, 'main.jsonl', [
      assistantText(PROPOSAL_TEXT, T0), ...bothSpawns(),
      userNotification('job1', 'tu_measure', 'completed', body, T3),
      userForegroundResult('tu_review', `${REVIEW_HEADING}\nconfirmed.`, T3),
    ])
    const r = mayWrite(mainInput(p))
    assert.strictEqual(r.allow, true)
  })

  // Test 18: a sentinel after a proposal → allow (no spawns needed at all).
  test('18. a NO_REVIEW_SENTINEL block after the proposal → allow', () => {
    const dir = tmpDir()
    const p = write(dir, 'main.jsonl', [
      assistantText(PROPOSAL_TEXT, T0),
      assistantText('REVIEW-GATE: NO REVIEW POSSIBLE — rate-limited, no Agent tool available', T1),
    ])
    const r = mayWrite(mainInput(p))
    assert.strictEqual(r.allow, true)
  })

  // Test 22: a `queue-operation`-shaped entry (never `type:"user"` with notification content) must
  // never confirm — modelled here as a `type:"attachment"` entry that is simply never scanned by
  // the `user`-entry branch at all (scanCycles only looks at `type === 'user'`).
  test('22. a queue-operation-shaped (non-"user") entry never confirms', () => {
    const dir = tmpDir()
    const queueOp = JSON.stringify({
      type: 'attachment', timestamp: T3,
      message: { content: `<task-notification>\n<task-id>job1</task-id>\n<tool-use-id>tu_measure</tool-use-id>\n<status>completed</status>\n${MEASURE_HEADING}\n...` },
    })
    const p = write(dir, 'main.jsonl', [
      assistantText(PROPOSAL_TEXT, T0), ...bothSpawns(), queueOp,
      userForegroundResult('tu_review', `${REVIEW_HEADING}\nconfirmed.`, T3),
    ])
    const r = mayWrite(mainInput(p))
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.missing, 'role-running')
  })
})

// ── D3 subagent inheritance (test 13) ───────────────────────────────────────────────────────

suite('review-loop D3: subagent inheritance', () => {
  test('13a. a non-role subagent spawned INSIDE an open window → allow', () => {
    const dir = tmpDir()
    const sessionDir = path.join(dir, 'main')
    fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true })
    const mainFile = sessionDir + '.jsonl'
    write(dir, 'main.jsonl', [
      assistantText(PROPOSAL_TEXT, T0), ...bothSpawns(), ...bothConfirmed(),
      assistantAgentSpawn('tu_worker', 'do the file edit', T4, /* isFork */ false),
    ])
    fs.renameSync(path.join(dir, 'main.jsonl'), mainFile)
    write(sessionDir, path.join('subagents', 'agent-W1.jsonl'), [assistantText('working on it', T4)])
    write(sessionDir, path.join('subagents', 'agent-W1.meta.json'), [JSON.stringify({ toolUseId: 'tu_worker' })])
    const r = mayWrite({ transcriptPath: mainFile, agentId: 'W1', cwd: CWD, toolName: 'Edit', toolInput: { file_path: '/proj/src/a.ts' } })
    assert.strictEqual(r.allow, true)
  })

  test('13b. a non-role subagent spawned OUTSIDE the window (before either fork confirmed) → deny', () => {
    const dir = tmpDir()
    const sessionDir = path.join(dir, 'main')
    fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true })
    const mainFile = sessionDir + '.jsonl'
    write(dir, 'main.jsonl', [
      assistantText(PROPOSAL_TEXT, T0),
      assistantAgentSpawn('tu_worker', 'do the file edit', T0, false), // spawned before any pair even exists
      ...bothSpawns(), ...bothConfirmed(),
    ])
    fs.renameSync(path.join(dir, 'main.jsonl'), mainFile)
    write(sessionDir, path.join('subagents', 'agent-W1.jsonl'), [assistantText('working on it', T0)])
    write(sessionDir, path.join('subagents', 'agent-W1.meta.json'), [JSON.stringify({ toolUseId: 'tu_worker' })])
    const r = mayWrite({ transcriptPath: mainFile, agentId: 'W1', cwd: CWD, toolName: 'Edit', toolInput: { file_path: '/proj/src/a.ts' } })
    assert.strictEqual(r.allow, false)
  })

  test('13c. a role fork (MEASURE/REVIEW) itself → explicit write is denied outright', () => {
    const dir = tmpDir()
    const sessionDir = path.join(dir, 'main')
    fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true })
    const mainFile = sessionDir + '.jsonl'
    write(dir, 'main.jsonl', [assistantText(PROPOSAL_TEXT, T0), ...bothSpawns()])
    fs.renameSync(path.join(dir, 'main.jsonl'), mainFile)
    write(sessionDir, path.join('subagents', 'agent-M1.jsonl'), [
      JSON.stringify({ type: 'user', timestamp: T1, message: { content: `<fork-boilerplate/>\nROLE: MEASURE\n${PROPOSAL_TEXT}` } }),
    ])
    const r = mayWrite({ transcriptPath: mainFile, agentId: 'M1', cwd: CWD, toolName: 'Edit', toolInput: { file_path: '/proj/src/a.ts' } })
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.missing, 'not-writable-here')
  })

  test('13d. a depth-2 inherited worker (spawned by a worker the main spawned inside its window) → allow', () => {
    const dir = tmpDir()
    const sessionDir = path.join(dir, 'main')
    fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true })
    const mainFile = sessionDir + '.jsonl'
    write(dir, 'main.jsonl', [
      assistantText(PROPOSAL_TEXT, T0), ...bothSpawns(), ...bothConfirmed(),
      assistantAgentSpawn('tu_workerA', 'delegate further', T4, false),
    ])
    fs.renameSync(path.join(dir, 'main.jsonl'), mainFile)
    write(sessionDir, path.join('subagents', 'agent-A.jsonl'), [
      assistantText('starting', T4),
      assistantAgentSpawn('tu_workerB', 'do the actual edit', T4, false),
    ])
    write(sessionDir, path.join('subagents', 'agent-A.meta.json'), [JSON.stringify({ toolUseId: 'tu_workerA' })])
    write(sessionDir, path.join('subagents', 'agent-B.jsonl'), [assistantText('working', T4)])
    write(sessionDir, path.join('subagents', 'agent-B.meta.json'), [JSON.stringify({ toolUseId: 'tu_workerB', parentAgentId: 'A' })])
    const r = mayWrite({ transcriptPath: mainFile, agentId: 'B', cwd: CWD, toolName: 'Edit', toolInput: { file_path: '/proj/src/a.ts' } })
    assert.strictEqual(r.allow, true)
  })
})

// ── D1: gatedCall (test 20) ──────────────────────────────────────────────────────────────────

suite('review-loop D1: gatedCall — the matcher tools (test 20)', () => {
  test('write actions are gated; read actions pass', () => {
    const cases: [string, GatedCallInput, 'write' | 'read'][] = [
      ['Edit', { file_path: '/proj/src/a.ts' }, 'write'],
      ['Write', { file_path: '/proj/src/a.ts' }, 'write'],
      ['NotebookEdit', { file_path: '/proj/a.ipynb' }, 'write'],
      ['MultiEdit', { file_path: '/proj/src/a.ts' }, 'write'],
      ['Artifact', { action: 'read' }, 'read'],
      ['Artifact', {}, 'write'], // no action publishes (checklist f)
      ['Artifact', { action: 'comments' }, 'read'],
      ['Artifact', { action: 'publish' }, 'write'],
      ['DesignSync', { method: 'get_file' }, 'read'],
      ['DesignSync', { method: 'set_file' }, 'write'],
      ['RemoteTrigger', { action: 'list' }, 'read'],
      ['RemoteTrigger', { action: 'run' }, 'write'],
      ['Workflow', {}, 'write'],
      ['EnterWorktree', {}, 'write'],
      ['ExitWorktree', { action: 'keep' }, 'read'],
      ['ExitWorktree', { action: 'remove' }, 'write'],
      ['CronCreate', {}, 'read'],
      ['SendMessage', { to: 'peer' }, 'read'],
    ]
    for (const [tool, input, kind] of cases) {
      const r = gatedCall(tool, input, CWD)
      assert.strictEqual(r.kind, kind, `${tool} ${JSON.stringify(input)}`)
    }
  })
})

suite('review-loop: roled-fork runner allow-list and plugin-script exemption', () => {
  test('a role fork may run the compile-tests/check-types/lint pnpm scripts, and npx tsc/eslint/mocha, at the repo root — nothing else', () => {
    assert.strictEqual(roledForkRunnerAllowed('pnpm run compile-tests', '/proj', '/proj'), true)
    assert.strictEqual(roledForkRunnerAllowed('pnpm run package', '/proj', '/proj'), false)
    assert.strictEqual(roledForkRunnerAllowed('uv run /tmp/x.py', '/proj', '/proj'), false)
    assert.strictEqual(roledForkRunnerAllowed('pnpm run compile-tests', '/elsewhere', '/proj'), false) // cwd must be the repo root
  })

  test('the plugin-script exemption (B3-style) resolves via an injectable homeDir, never the real HOME', () => {
    const home = tmpDir()
    const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'ai-maestro-plugins', 'ai-maestro-janitor', 'v1', 'scripts')
    fs.mkdirSync(cacheRoot, { recursive: true })
    const armPrepare = path.join(cacheRoot, 'arm_prepare.py')
    fs.writeFileSync(armPrepare, '# stub\n')
    const other = path.join(cacheRoot, 'not_exempt.py')
    fs.writeFileSync(other, '# stub\n')
    assert.strictEqual(roledForkExemptScript(armPrepare, '/proj', undefined, home), true)
    assert.strictEqual(roledForkExemptScript(other, '/proj', undefined, home), false)
  })
})
