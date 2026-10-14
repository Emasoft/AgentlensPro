import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  scanTranscriptLines, decideGate, subagentExempt, JANITOR_AGENT_RE,
  isFloorPrompt, userPromptText, HEARTBEAT_PREFIX, INTERRUPT_PREFIX,
  demandText, mainBlockReason, subagentBlockReason, ARM_CAUSE_TEXT,
  REVIEW_GATE_DIRECTIVE, REVIEW_ROLE_RULE, MEASURE_ROLE_RULE, declaredRole, declaredRoleOwnTranscript,
  runMainGate, runReviewGate, agentCannotSpawn, declaredToolsHaveAgent,
  NO_REVIEW_SENTINEL, NO_REVIEW_SENTINEL_EXAMPLES, workerReturnId, workerWriteDetail, workerDeclaredRole,
  isTurnStart, readCurrentTurn, isCreditedFork,
} from '../cli/reviewGate'
import { PROPOSAL_MARKER, commandWriteReasons } from '../cli/reviewGateTriggers'
import { runSubagentGate } from '../cli/reviewGate'
import { DELEGATE_DENY_REASON } from '../cli/delegateGate'
import { MEASURE_HEADING, REVIEW_HEADING } from '../cli/reviewLoop'

// `agentlenspro review-gate` — pure decision-function tests (owner order 2026-09-15 rewrite: ONE
// shared scan/decide pair, `scanTranscriptLines` / `decideGate`, replaces the separate main/subagent
// scanners this file used to test).

const CWD = '/repo'
const editBlock = { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/a.ts' } }
const bashBlock = (command: string) => ({ type: 'tool_use', name: 'Bash', input: { command } })
const agentBlock = (subagent_type: string, prompt: string) => ({ type: 'tool_use', name: 'Agent', input: { subagent_type, prompt } })

const assistantLine = (blocks: unknown[]): string => JSON.stringify({ type: 'assistant', message: { content: blocks } })
const userStringLine = (content: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content } })
const userTextLine = (text: string): string => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } })
const toolResultLine = (toolUseId: string, content: unknown): string =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } })

// ── Worker writes reach the MAIN gate (TRDD-9YWTNFU8) ─────────────────────────────────────────────
// A background worker has no Agent tool, so its own SubagentStop gate releases it. Its writes reach
// the main gate only through its return, a `queue-operation` line; these tests pin that path.
suite('reviewGate — worker writes reach the main gate', () => {
  const notification = (toolUseId: string): string =>
    `<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>`
  const returnLine = (toolUseId: string): string =>
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: notification(toolUseId) })
  const reportWrites = (): string => 'lean-worker: Edit a.ts'

  test('workerReturnId reads the spawning tool_use id from a real queue-operation return', () => {
    assert.strictEqual(workerReturnId(returnLine('toolu_W1')), 'toolu_W1')
  })

  test('the same notification copied into a user or an attachment entry is not a return', () => {
    const asUser = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: notification('toolu_W1') }] } })
    const asAttachment = JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: notification('toolu_W1') } })
    assert.strictEqual(workerReturnId(asUser), null)
    assert.strictEqual(workerReturnId(asAttachment), null)
  })

  test('a queue-operation whose notification has no <status> tag is not a return', () => {
    const noStatus = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: notification('toolu_W1').replace('<status>completed</status>', '') })
    assert.strictEqual(workerReturnId(noStatus), null)
  })

  test('a user tool_result that merely quotes the tool-use-id tag is not a return', () => {
    const quoting = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_X', content: '<tool-use-id>toolu_W1</tool-use-id>' }] } })
    assert.strictEqual(workerReturnId(quoting), null)
  })

  test('a return whose worker reports writes arms the main gate as a worker write, and the review is demanded', () => {
    const scan = scanTranscriptLines([userStringLine('go'), returnLine('toolu_W1')], CWD, undefined, (id) => (id === 'toolu_W1' ? reportWrites() : null))
    assert.deepStrictEqual(scan.work, { index: 1, cause: 'worker write', detail: 'lean-worker: Edit a.ts' })
    assert.strictEqual(decideGate(scan), 'review')
  })

  test('a return whose worker reports no writes leaves the scan unarmed', () => {
    assert.strictEqual(scanTranscriptLines([returnLine('toolu_W1')], CWD, undefined, () => null).work, null)
  })

  test('without the callback a return line never arms, so the SubagentStop scan is unchanged', () => {
    assert.strictEqual(scanTranscriptLines([returnLine('toolu_W1')], CWD).work, null)
  })

  test('a fork REVIEW spawn AFTER the return releases the gate', () => {
    const lines = [returnLine('toolu_W1'), assistantLine([agentBlock('fork', 'ROLE: REVIEW\nreview it')])]
    assert.strictEqual(decideGate(scanTranscriptLines(lines, CWD, undefined, reportWrites)), null)
  })

  test('a fork REVIEW spawn BEFORE the return does not release the gate', () => {
    const lines = [assistantLine([agentBlock('fork', 'ROLE: REVIEW\nreview it')]), returnLine('toolu_W1')]
    assert.strictEqual(decideGate(scanTranscriptLines(lines, CWD, undefined, reportWrites)), 'review')
  })

  test('a heartbeat floor BEFORE the return does not stop the return from being demanded', () => {
    const lines = [userStringLine('[janitor-heartbeat] tick'), returnLine('toolu_W1')]
    assert.strictEqual(decideGate(scanTranscriptLines(lines, CWD, undefined, reportWrites)), 'review')
  })

  test('a heartbeat floor AFTER the return clears it', () => {
    const lines = [returnLine('toolu_W1'), userStringLine('[janitor-heartbeat] tick')]
    assert.strictEqual(scanTranscriptLines(lines, CWD, undefined, reportWrites).work, null)
  })

  test('a SendMessage resume is a second return with the same id, demanded again after a fork in between', () => {
    const fork = assistantLine([agentBlock('fork', 'ROLE: REVIEW\nreview it')])
    const once = scanTranscriptLines([returnLine('toolu_W1'), fork], CWD, undefined, reportWrites)
    assert.strictEqual(decideGate(once), null)
    const resumed = scanTranscriptLines([returnLine('toolu_W1'), fork, returnLine('toolu_W1')], CWD, undefined, reportWrites)
    assert.deepStrictEqual(resumed.work, { index: 2, cause: 'worker write', detail: 'lean-worker: Edit a.ts' })
    assert.strictEqual(decideGate(resumed), 'review')
  })

  // Lays out `<dir>/main/subagents/` as the harness does; `main.jsonl` itself need not exist.
  const withWorkers = (run: (transcript: string, subagents: string) => void): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-ww-'))
    try {
      const subagents = path.join(dir, 'main', 'subagents')
      fs.mkdirSync(subagents, { recursive: true })
      run(path.join(dir, 'main.jsonl'), subagents)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  const addWorker = (subagents: string, name: string, toolUseId: string, agentType: string, entries: string[]): void => {
    fs.writeFileSync(path.join(subagents, `${name}.meta.json`), JSON.stringify({ toolUseId, agentType }))
    fs.writeFileSync(path.join(subagents, `${name}.jsonl`), entries.join('\n') + '\n')
  }
  const editOf = (file: string) => ({ type: 'tool_use', name: 'Edit', input: { file_path: `/repo/src/${file}` } })

  test("workerWriteDetail reports the worker's own Edit as '<agentType>: Edit a.ts'", () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-a', 'toolu_W1', 'lean-worker', [userStringLine('do it'), assistantLine([editBlock])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W1', CWD), 'lean-worker: Edit a.ts')
    })
  })

  test('a worker whose only write-shaped command is `pnpm run compile` has nothing reviewable', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-b', 'toolu_W2', 'lean-worker', [userStringLine('build'), assistantLine([bashBlock('pnpm run compile')])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W2', CWD), null)
    })
  })

  // TRDD-QQ2XIIZ6 amendment A: a declared role relaxes ONLY unresolvable scratch targets, so a role worker's Edit of a
  // real source file is reported like any other worker's (before, any `ROLE:` line anywhere skipped the whole worker).
  test('a ROLE: MEASURE worker that edits a file outside the ephemeral dirs still reports it', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-c', 'toolu_W3', 'fast-worker', [userStringLine('ROLE: MEASURE\nmeasure it'), assistantLine([editBlock])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W3', CWD), 'fast-worker: Edit a.ts')
    })
  })

  // The MEASURED shape of a fork's first user entry (TRDD-QQ2XIIZ6, 2026-10-14): a tool_result block, then ONE text
  // block holding the fork boilerplate and, after it, the parent's prompt behind `Your directive: `. Ids are fake.
  const forkEntryContent = (directive: string, toolResult: unknown = 'Forked.'): unknown[] => [
    { type: 'tool_result', tool_use_id: 'toolu_aaaaaaaa', content: toolResult },
    { type: 'text', text: `<fork-boilerplate>\nYou are a fork. Do not spawn subagents. Report once and stop.\n</fork-boilerplate>\n\nYour directive: ${directive}` },
  ]
  const forkEntryLine = (directive: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: forkEntryContent(directive) } })

  test('workerDeclaredRole reads the measured fork shape [tool_result, text], for which userPromptText returns empty', () => {
    assert.strictEqual(userPromptText(forkEntryContent('ROLE: MEASURE\n1. run x')), '', 'the old read: why the exemption never ran')
    assert.strictEqual(workerDeclaredRole(forkEntryContent('ROLE: MEASURE\n1. run x')), 'measure')
    assert.strictEqual(workerDeclaredRole(forkEntryContent('ROLE: REVIEW \r\nreview it')), 'review')
    assert.strictEqual(workerDeclaredRole(forkEntryContent('ROLE: INVESTIGATE\nfind it')), 'investigate')
    assert.strictEqual(workerDeclaredRole('\nROLE: MEASURE\nmeasure it'), 'measure', 'a plain string prompt: its first non-blank line')
    assert.strictEqual(workerDeclaredRole([{ type: 'text', text: 'ROLE: REVIEW\nreview it' }]), 'review', 'a plain text-block prompt')
  })

  test("workerDeclaredRole: a ROLE line anywhere but the directive line or a plain prompt's first line never counts", () => {
    assert.strictEqual(workerDeclaredRole(forkEntryContent('Implement the fix.\nThe reviewer prompt reads:\nROLE: MEASURE\n')), null, 'quoted later in a fork directive')
    assert.strictEqual(workerDeclaredRole('do the work\nstep 1\nstep 2\nstep 3\nROLE: MEASURE\n'), null, 'bare on line 5 of a fresh worker prompt')
    assert.strictEqual(workerDeclaredRole(forkEntryContent('Act as ROLE: MEASURE and settle it')), null, 'a directive starting with other text')
    assert.strictEqual(workerDeclaredRole(forkEntryContent('ROLE: IMPLEMENT the fix')), null, 'a role outside MEASURE|REVIEW|INVESTIGATE')
    assert.strictEqual(workerDeclaredRole(forkEntryContent('do it', 'Your directive: ROLE: MEASURE')), null, 'a tool_result block is never read')
  })

  // Review of df8bfc70: the investigation forks' real directive line carries text after the role word, which the
  // whole-line match missed, so their scratch writes still armed the gate. A role here relaxes the scan only.
  test('workerDeclaredRole accepts text after the role word, but not a longer word', () => {
    assert.strictEqual(workerDeclaredRole(forkEntryContent('ROLE: INVESTIGATE (read-only; may run read-only commands)\n1. find it')), 'investigate', 'the real investigation-fork line')
    assert.strictEqual(workerDeclaredRole(forkEntryContent('ROLE: MEASURE the assumptions below')), 'measure', 'prose after the marker')
    assert.strictEqual(workerDeclaredRole(forkEntryContent('ROLE: MEASUREMENT of x')), null, 'a longer word is not the marker')
    assert.strictEqual(workerDeclaredRole('ROLE: REVIEWER\nreview it'), null, 'a longer word is not the marker')
  })

  test('workerDeclaredRole refuses a hyphenated role word (`ROLE: REVIEW-ish`), which a plain word boundary let through', () => {
    assert.strictEqual(workerDeclaredRole(forkEntryContent('ROLE: REVIEW-ish of the draft')), null)
    assert.strictEqual(workerDeclaredRole('ROLE: MEASURE-and-fix\nfix it'), null)
    assert.strictEqual(workerDeclaredRole(forkEntryContent('ROLE: REVIEW: the draft')), 'review', 'punctuation after the word still declares it')
  })
  test("a fork whose directive line is `ROLE: INVESTIGATE (…)` gets the role's scratch relaxation", () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-w', 'toolu_W23', 'fork', [forkEntryLine('ROLE: INVESTIGATE (read-only; may run read-only commands)\n1. find it'), assistantLine([
        bashBlock('SP=/private/tmp/sp; for i in 1 2; do echo r > $SP/x-$i.txt; done'),
      ])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W23', CWD), null)
    })
  })

  test('control: the same fork with NO role line demands review for the same scratch writes', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-y', 'toolu_W25', 'fork', [forkEntryLine('read-only; may run read-only commands\n1. find it'), assistantLine([
        bashBlock('SP=/private/tmp/sp; for i in 1 2; do echo r > $SP/x-$i.txt; done'),
      ])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W25', CWD), 'fork: redirect into $SP/x-$i.txt')
    })
  })
  test("amendment A: a role fork's UNRESOLVABLE writes inside an ephemeral dir (a loop variable, a $(date) stamp) demand no review", () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-t', 'toolu_W20', 'fork', [forkEntryLine('ROLE: MEASURE\n1. measure it'), assistantLine([
        bashBlock('SP=/private/tmp/sp; for i in 1 2; do echo r > $SP/x-$i.txt; done'),
        bashBlock('fastedit create docs_dev/$(date +%s)-r.md --content x'),
      ])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W20', CWD), null)
    })
  })

  test('amendment A: the same writes from a worker with NO declared role still demand review', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-u', 'toolu_W21', 'fork', [forkEntryLine('measure it\nROLE: MEASURE'), assistantLine([
        bashBlock('SP=/private/tmp/sp; for i in 1 2; do echo r > $SP/x-$i.txt; done'),
        bashBlock('fastedit create docs_dev/$(date +%s)-r.md --content x'),
      ])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W21', CWD), 'fork: redirect into $SP/x-$i.txt, fastedit create')
    })
  })

  test("amendment A: a role fork's RESOLVABLE write outside the ephemeral dirs still demands review", () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-v', 'toolu_W22', 'fork', [forkEntryLine('ROLE: MEASURE\n1. measure it'), assistantLine([bashBlock('echo x > src/a.ts')])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W22', CWD), 'fork: redirect into src/a.ts')
    })
  })

  test("amendment A: a role's dynamic target that can leave the ephemeral dir, or has none, still arms", () => {
    const role = (cmd: string): string[] => commandWriteReasons(cmd, CWD, { roleScratch: true })
    assert.deepStrictEqual(role('fastedit create docs_dev/$(date +%s)-r.md --content x'), [], 'control: the stamp itself passes')
    assert.deepStrictEqual(role('fastedit create docs_dev/$(printf ../src)/a.ts --content x'), ['fastedit create'], 'a `/` inside the cut substitution')
    assert.deepStrictEqual(role('echo x > docs_dev/$(printf ..)/src/a.ts'), ['redirect into docs_dev/$'], 'a `/` after the cut substitution')
    assert.deepStrictEqual(role('echo x > "docs_dev/$(printf ..)/src/a.ts"'), ['redirect into docs_dev/$(printf ..)/src/a.ts'], 'quoted, so seen whole')
    assert.deepStrictEqual(role('echo x > $OUT'), ['redirect into $OUT'], 'no static directory at all')
    assert.deepStrictEqual(role('echo x > src/x-$i.ts'), ['redirect into src/x-$i.ts'], 'a static directory that is not ephemeral')
  })

  // Review of 668fc421: the danger in a role's dynamic target is its CONTENT, not its syntax. A backslash escape
  // spells `../` without writing it (`'..\57src\57a.ts'`, `'\56\56\57src\57a.ts'`), in `$(…)` and backticks alike.
  test('a role target whose quoted `$(…)` spells `..` through a backslash escape arms', () => {
    const role = (cmd: string): string[] => commandWriteReasons(cmd, CWD, { roleScratch: true })
    assert.deepStrictEqual(role(`echo x > "reports/$(printf '..\\57src\\57a.ts')"`), [`redirect into reports/$(printf '..\\57src\\57a.ts')`])
    assert.deepStrictEqual(role(`echo x > "reports/$(printf '\\56\\56\\57src\\57a.ts')"`), [`redirect into reports/$(printf '\\56\\56\\57src\\57a.ts')`])
  })

  test('the same escapes in a quoted backtick span arm too', () => {
    const role = (cmd: string): string[] => commandWriteReasons(cmd, CWD, { roleScratch: true })
    assert.deepStrictEqual(role(`echo x > "reports/\`printf '..\\57src\\57a.ts'\`"`), [`redirect into reports/\`printf '..\\57src\\57a.ts'\``])
    assert.deepStrictEqual(role(`echo x > "reports/\`printf '\\56\\56\\57src\\57a.ts'\`"`), [`redirect into reports/\`printf '\\56\\56\\57src\\57a.ts'\``])
  })

  test('a backtick stamp in a role target passes like the same `$(date +%s)` stamp', () => {
    const role = (cmd: string): string[] => commandWriteReasons(cmd, CWD, { roleScratch: true })
    assert.deepStrictEqual(role('echo x > "docs_dev/`date +%s`-r.md"'), [])
    assert.deepStrictEqual(role('echo x > "docs_dev/$(date +%s)-r.md"'), [], 'control: the `$(…)` stamp')
  })

  // Round-2 review of d476914a: `rm` refuses `..` as an operand's last component, so the case that writes into the
  // project root is `cp` / `mv` into `reports/$(printf ..)`. `tar -C` would too, but the gate classifies no `tar`.
  test('a cut `$(…)` whose hidden text spells `..` arms for a role: `cp x reports/$(printf ..)` writes into the project root', () => {
    const role = (cmd: string): string[] => commandWriteReasons(cmd, CWD, { roleScratch: true })
    assert.deepStrictEqual(role('cp x reports/$(printf ..)'), ['cp reports/$'])
    assert.deepStrictEqual(role('mv x docs_dev/$(printf ..)'), ['mv docs_dev/$'])
    assert.deepStrictEqual(role('echo x > docs_dev/$(printf ..)-x'), ['redirect into docs_dev/$'], '`..` with a word tail')
    assert.deepStrictEqual(role('rm -rf reports/$(printf ..)'), ['rm reports/$'], 'pinned: harmless today, `rm` refuses a trailing `..`')
    assert.deepStrictEqual(role('cp x reports/$(date +%s)'), [], 'control: a stamp still passes')
  })

  // Review of 668fc421: role forks write scratch as `D=$(mktemp -d); cat > "$D/x"`, and `$D` is unresolvable with no
  // static directory, so isRoleScratchTarget alone armed on it (this session's fastedit reproduction fork).
  test("a role worker's write into a same-command `$(mktemp -d)` directory demands no review", () => {
    const role = (cmd: string): string[] => commandWriteReasons(cmd, CWD, { roleScratch: true })
    assert.deepStrictEqual(role('D=$(mktemp -d); cat > "$D/min.ts"'), [])
    assert.deepStrictEqual(role('D="$(mktemp -d -t fe)"\necho x > ${D}/a.ts && rm -rf "$D"'), [], 'quoted, `-t <prefix>`, braces, a cleanup rm')
    withWorkers((t, s) => {
      addWorker(s, 'agent-x', 'toolu_W24', 'fork', [forkEntryLine('ROLE: INVESTIGATE (read-only; may run read-only commands)\n1. reproduce it'), assistantLine([
        bashBlock("D=$(mktemp -d)\ncat > \"$D/min.ts\" <<'EOF'\nexport const a = 1\nEOF\nfastedit edit \"$D/min.ts\" --replace a --snippet x"),
      ])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W24', CWD), null)
    })
  })

  test('a mktemp variable never exempts a target that leaves it, a template or relocated mktemp, a rebinding, or an early use', () => {
    const role = (cmd: string): string[] => commandWriteReasons(cmd, CWD, { roleScratch: true })
    assert.deepStrictEqual(role('D=$(mktemp -d); cat > "$D/../src/a.ts"'), ['redirect into $D/../src/a.ts'], 'climbs out')
    assert.deepStrictEqual(role('D=$(mktemp -d /x/src); cat > "$D/min.ts"'), ['redirect into $D/min.ts'], 'a template path')
    assert.deepStrictEqual(role('D=$(mktemp -d tmp.XXXXXX); cat > "$D/min.ts"'), ['redirect into $D/min.ts'], 'a bare template is created in the cwd')
    assert.deepStrictEqual(role('D=$(mktemp -d -p src); cat > "$D/min.ts"'), ['redirect into $D/min.ts'], '-p moves it')
    assert.deepStrictEqual(role('TMPDIR=src; D=$(mktemp -d); cat > "$D/min.ts"'), ['redirect into $D/min.ts'], 'TMPDIR moves it')
    assert.deepStrictEqual(role('D=$(mktemp -d); for D in src; do echo x > $D/a.ts; done'), ['redirect into $D/a.ts'], 'a loop rebinds D')
    assert.deepStrictEqual(role('echo x > "$D/a.ts"; D=$(mktemp -d)'), ['redirect into $D/a.ts'], 'used before it is assigned')
    assert.deepStrictEqual(role('D=$(mktemp -d); rm -rf "$D"/*'), ['rm $D/*'], 'a glob: a failed mktemp would make it /*')
  })

  test('the same mktemp write from a worker with NO declared role still demands review', () => {
    assert.deepStrictEqual(commandWriteReasons('D=$(mktemp -d); cat > "$D/min.ts"', CWD), ['redirect into $D/min.ts'])
  })

  // Round-2 review of d476914a: an EMPTY D (a failed mktemp, or an assignment that never took effect) turns
  // `$D/<name>` into `/<name>`, so `<name>` must be ONE path component; and an assignment that may not take effect
  // in this shell, or a rebinding such as `${D:=…}`, leaves D holding something other than the fresh directory.
  test('a mktemp target with more than one path component arms: an empty D would make it an absolute path', () => {
    const role = (cmd: string): string[] => commandWriteReasons(cmd, CWD, { roleScratch: true })
    assert.deepStrictEqual(role('D=$(mktemp -d); cat > "$D/a/b"'), ['redirect into $D/a/b'])
    assert.deepStrictEqual(role('D=$(mktemp -d) true; cat > "$D/Volumes/x/src/a.ts"'), ['redirect into $D/Volumes/x/src/a.ts'], 'after a prefix assignment')
    assert.deepStrictEqual(role('( D=$(mktemp -d) ); cat > "$D/Volumes/x/src/a.ts"'), ['redirect into $D/Volumes/x/src/a.ts'], 'after a subshell assignment')
  })

  test('a mktemp assignment that may not take effect in this shell exempts nothing', () => {
    const role = (cmd: string): string[] => commandWriteReasons(cmd, CWD, { roleScratch: true })
    assert.deepStrictEqual(role('D=$(mktemp -d) true; cat > "$D/m.ts"'), ['redirect into $D/m.ts'], 'a prefix assignment sets D for `true` only')
    assert.deepStrictEqual(role('( D=$(mktemp -d) ); cat > "$D/m.ts"'), ['redirect into $D/m.ts'], 'a subshell')
    assert.deepStrictEqual(role('( a; D=$(mktemp -d); b ); cat > "$D/m.ts"'), ['redirect into $D/m.ts'], 'a subshell, the assignment mid-list')
    assert.deepStrictEqual(role('D=$(mktemp -d) | cat; cat > "$D/m.ts"'), ['redirect into $D/m.ts'], 'a pipeline stage')
    assert.deepStrictEqual(role('false && D=$(mktemp -d); cat > "$D/m.ts"'), ['redirect into $D/m.ts'], 'a conditional branch')
  })

  test('a rebinding, a quoted tail, a shadowed mktemp or a moved PATH disqualifies the mktemp variable', () => {
    const role = (cmd: string): string[] => commandWriteReasons(cmd, CWD, { roleScratch: true })
    assert.deepStrictEqual(role('D=$(mktemp -d); : "${D:=/abs/src}"; cat > "$D/a.ts"'), ['redirect into $D/a.ts'], '`${D:=…}` rebinds an empty D')
    assert.deepStrictEqual(role('D=$(mktemp -d); : "${D=/abs/src}"; cat > "$D/a.ts"'), ['redirect into $D/a.ts'], '`${D=…}`')
    assert.deepStrictEqual(role(': "${D:=/abs/src}"; cat > "$D/a.ts"'), ['redirect into $D/a.ts'], 'pinned: no mktemp at all')
    assert.deepStrictEqual(role('D="$(mktemp -d)"x; cat > "$D/m.ts"'), ['redirect into $D/m.ts'], 'pinned: a quoted mktemp with a tail')
    assert.deepStrictEqual(role('mktemp() { echo /x; }; D=$(mktemp -d); cat > "$D/m.ts"'), ['redirect into $D/m.ts'], 'a function named mktemp')
    assert.deepStrictEqual(role("alias mktemp='echo /x'; D=$(mktemp -d); cat > \"$D/m.ts\""), ['redirect into $D/m.ts'], 'an alias named mktemp')
    assert.deepStrictEqual(role('PATH=/x:$PATH; D=$(mktemp -d); cat > "$D/m.ts"'), ['redirect into $D/m.ts'], 'PATH moved')
    assert.deepStrictEqual(role('path=(/x $path); D=$(mktemp -d); cat > "$D/m.ts"'), ['redirect into $D/m.ts'], "zsh's path array is tied to PATH")
  })

  test('controls: a plain top-level `D=$(mktemp -d)` still exempts a one-component write', () => {
    const role = (cmd: string): string[] => commandWriteReasons(cmd, CWD, { roleScratch: true })
    assert.deepStrictEqual(role('D=$(mktemp -d); cp x "$D/m.ts"'), [])
    assert.deepStrictEqual(role('D=$(mktemp -d); cat > "$D/m.ts"'), [])
    assert.deepStrictEqual(role('D=$(mktemp -d) && cat > "$D/m.ts" || exit 1'), [], '`&&` after the assignment')
  })
  test('a janitor worker is skipped even when it wrote a file', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-d', 'toolu_W4', 'ai-maestro-janitor:janitor-memory-subconscious-agent', [userStringLine('go'), assistantLine([editBlock])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W4', CWD), null)
    })
  })

  test('a return whose id matches no worker meta file has nothing to report', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-a', 'toolu_W1', 'lean-worker', [userStringLine('do it'), assistantLine([editBlock])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_NONE', CWD), null)
    })
  })

  test('distinct writes are listed up to three with "(+N more)", and a repeated write counts once', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-e', 'toolu_W5', 'lean-worker', [userStringLine('go'), assistantLine([editOf('a.ts')]), assistantLine([editOf('a.ts')]), assistantLine([editOf('b.ts')]), assistantLine([editOf('c.ts')]), assistantLine([editOf('d.ts')])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W5', CWD), 'lean-worker: Edit a.ts, Edit b.ts, Edit c.ts (+1 more)')
    })
  })

  test('a worker transcript with one torn line still reports the Edit after it', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-f', 'toolu_W6', 'lean-worker', [userStringLine('do it'), '{"type":"assistant","message":', assistantLine([editBlock])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W6', CWD), 'lean-worker: Edit a.ts')
    })
  })

  test('a worker that runs agentlenspro --install-hooks is reported, since that rewrites settings.json', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-g', 'toolu_W7', 'lean-worker', [userStringLine('wire it'), assistantLine([bashBlock('agentlenspro --install-hooks')])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W7', CWD), 'lean-worker: agentlenspro config write')
    })
  })

  test('a build chained to a sed -i is reported, while the lone build above is not', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-h', 'toolu_W8', 'lean-worker', [userStringLine('fix it'), assistantLine([bashBlock('pnpm run compile && sed -i s/a/b/ src/a.ts')])])
      const detail = workerWriteDetail(t, 'toolu_W8', CWD)
      assert.ok(detail !== null && detail.startsWith('lean-worker: '), String(detail))
    })
  })

  test('a worker whose one Bash command chains three card records has nothing reviewable', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-i', 'toolu_W9', 'fast-worker', [userStringLine('record it'), assistantLine([bashBlock('trddgrep set X f v; trddgrep append X H l; trddgrep move X ai_review')])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W9', CWD), null)
    })
  })

  test('the same card-record chain ending in a pipe to tail has nothing reviewable', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-j', 'toolu_W10', 'fast-worker', [userStringLine('record it'), assistantLine([bashBlock('trddgrep set X f v; trddgrep append X H l; trddgrep move X ai_review 2>&1 | tail -1')])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W10', CWD), null)
    })
  })

  test('a build chained to a sed -i is reported as the sed alone, never as the build', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-k', 'toolu_W11', 'lean-worker', [userStringLine('fix it'), assistantLine([bashBlock('pnpm run compile && sed -i s/a/b/ src/a.ts')])])
      const detail = workerWriteDetail(t, 'toolu_W11', CWD)
      assert.ok(detail !== null && detail.includes('sed -i') && !detail.includes('pnpm run compile'), String(detail))
    })
  })

  test('a card append chained to a redirect into src is reported as the redirect', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-l', 'toolu_W12', 'fast-worker', [userStringLine('record it'), assistantLine([bashBlock('trddgrep append X H l; cat > src/x')])])
      const detail = workerWriteDetail(t, 'toolu_W12', CWD)
      assert.ok(detail !== null && detail.includes('redirect into src/x'), String(detail))
    })
  })

  test('a card record chained to agentlenspro setup is reported as the settings write', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-m', 'toolu_W13', 'fast-worker', [userStringLine('record it'), assistantLine([bashBlock('agentlenspro setup; trddgrep set X f v')])])
      const detail = workerWriteDetail(t, 'toolu_W13', CWD)
      assert.ok(detail !== null && detail.includes('agentlenspro config write'), String(detail))
    })
  })

  test("a bash -c string is never dropped, even when its one reason is a card record", () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-n', 'toolu_W14', 'fast-worker', [userStringLine('record it'), assistantLine([bashBlock("bash -c 'trddgrep set X f v; sed -i s/a/b/ src/a.ts'")])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W14', CWD), 'fast-worker: trddgrep set')
    })
  })

  test('a path-qualified bash -c string is reported, not dropped, when its one reason is a card record', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-o', 'toolu_W15', 'fast-worker', [userStringLine('record it'), assistantLine([bashBlock("/bin/bash -c 'trddgrep set X f v; sed -i s/a/b/ src/a.ts'")])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W15', CWD), 'fast-worker: trddgrep set')
    })
  })

  test('a quoted bash -c or eval mention inside a card append is not a nested shell, so the record is dropped', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-p', 'toolu_W16', 'fast-worker', [userStringLine('record it'), assistantLine([bashBlock('trddgrep append X H "a bash -c or eval string is always reported"')])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W16', CWD), null)
    })
  })

  test('a quoted eval word in an echo is not a nested shell, so the card record after it is dropped', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-q', 'toolu_W17', 'fast-worker', [userStringLine('record it'), assistantLine([bashBlock('echo "eval is fine"; trddgrep set X f v')])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W17', CWD), null)
    })
  })

  test('an eval runs its argument, so the card record it wraps is reported, not dropped', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-r', 'toolu_W18', 'fast-worker', [userStringLine('record it'), assistantLine([bashBlock('eval "trddgrep set X f v"')])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W18', CWD), 'fast-worker: trddgrep set')
    })
  })

  test('a plain chain of two card records with no shell has nothing reviewable', () => {
    withWorkers((t, s) => {
      addWorker(s, 'agent-s', 'toolu_W19', 'fast-worker', [userStringLine('record it'), assistantLine([bashBlock('trddgrep set X f v; trddgrep append X H l')])])
      assert.strictEqual(workerWriteDetail(t, 'toolu_W19', CWD), null)
    })
  })

  test('a worker-write block asks the main agent to list files outside git too', () => {
    assert.ok(mainBlockReason('worker write', 'lean-worker: Edit a.ts', 'review').includes('outside git'))
  })

  test('a worker write tells the main agent to run git status and git diff first; an ordinary edit does not', () => {
    const reason = mainBlockReason('worker write', 'lean-worker: Edit a.ts', 'review')
    assert.ok(reason.includes('git status --short') && reason.includes('git diff'))
    assert.ok(!mainBlockReason('edit', 'Edit a.ts', 'review').includes('git status'))
  })
})

// ── KEPT VERBATIM — agentCannotSpawn / declaredToolsHaveAgent (built-in + plugin-cache), unchanged ──
suite('reviewGate — agentCannotSpawn / declaredToolsHaveAgent (built-in + plugin-cache)', () => {
  test('a built-in with no Agent tool and no definition file is RELEASED, not wedged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-builtin-'))
    // No Explore.md is written: the point is that the ABSENT file must not mean "demand as usual".
    assert.strictEqual(agentCannotSpawn('Explore', dir), true)
    assert.strictEqual(agentCannotSpawn('Plan', dir), true)
    assert.strictEqual(agentCannotSpawn('general-purpose', dir), false, 'it HAS the Agent tool — still demanded')
  })

  test('a plugin-namespaced type is not bricked by the path-traversal guard (live outage 2026-09-07)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-ns-'))
    const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-cache-'))
    // Unresolvable + namespaced => RELEASED. Demanding an agent that cannot be proven able to spawn
    // is a permanent wedge; a missed review is recoverable.
    // A VISIBLY-FAKE namespace, and an EMPTY cache passed explicitly. The previous version named a
    // really-installed plugin and let the resolver read the developer's own ~/.claude/plugins/cache,
    // so its outcome depended on machine state — it would have flipped if that plugin ever shipped
    // `Agent` in its tools. A test that consults the machine is not a test of the code.
    assert.strictEqual(agentCannotSpawn('nosuchplugin:nosuchagent', dir, emptyCache), true, 'unresolvable + namespaced ⇒ released, never wedged')
    // The traversal defence still holds — it just guards the NAME now, not the whole address.
    assert.strictEqual(agentCannotSpawn('plug:../etc/passwd', dir, emptyCache), false)
    assert.strictEqual(agentCannotSpawn('../etc/passwd:name', dir, emptyCache), false, 'a bad plugin part is rejected too')
    // A BARE unresolvable name keeps the old default (demand) — this fix changes only the namespaced case.
    assert.strictEqual(agentCannotSpawn('nosuchagent', dir, emptyCache), false)
    // A namespaced type whose BARE name resolves in agentsDir is parsed, not blanket-released.
    fs.writeFileSync(path.join(dir, 'known.md'), '---\ntools: Read, Agent\n---\n')
    assert.strictEqual(agentCannotSpawn('someplugin:known', dir, emptyCache), false, 'agentsDir is the FALLBACK when the cache has nothing')
  })

  test('the plugin cache OUTRANKS a same-named user agent, and the NEWEST version wins', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-p-'))
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-c-'))
    const mk = (v: string, tools: string, whenMs: number): void => {
      const d = path.join(cache, 'mp', 'plug', v, 'agents')
      fs.mkdirSync(d, { recursive: true })
      const f = path.join(d, 'a.md')
      fs.writeFileSync(f, `---\ntools: ${tools}\n---\n`)
      fs.utimesSync(f, whenMs / 1000, whenMs / 1000)
    }
    // A user agent of the SAME bare name claims the Agent tool. If agentsDir won, `plug:a` would be
    // DEMANDED a fork it cannot spawn — the outage, recreated through a name collision.
    fs.writeFileSync(path.join(dir, 'a.md'), '---\ntools: Read, Agent\n---\n')
    mk('3.4.14', 'Read, Bash', Date.parse('2026-01-01T00:00:00Z'))
    assert.strictEqual(agentCannotSpawn('plug:a', dir, cache), true, 'the plugin definition wins over the same-named local one')
    // '3.4.1' sorts FIRST lexicographically but is older; only mtime picks the installed one.
    mk('3.4.1', 'Read, Agent', Date.parse('2020-01-01T00:00:00Z'))
    assert.strictEqual(agentCannotSpawn('plug:a', dir, cache), true, 'stale 3.4.1 must not outrank 3.4.14')
    fs.utimesSync(path.join(cache, 'mp', 'plug', '3.4.1', 'agents', 'a.md'), Date.now() / 1000, Date.now() / 1000)
    assert.strictEqual(agentCannotSpawn('plug:a', dir, cache), false, 'newest now HAS Agent ⇒ demanded')
  })

  test('every built-in that lacks the Agent tool is released, not just Explore and Plan', () => {
    // A built-in has NO definition file, so it lands on `text === null` → `plugin !== ''`, which for
    // a BARE name is false ⇒ DEMAND ⇒ a fork it cannot spawn. Two real ones were wedged that way;
    // tool lists verified against the live agent listing 2026-09-07.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-bi-'))
    for (const n of ['Explore', 'Plan', 'claude-code-guide', 'statusline-setup']) {
      assert.strictEqual(agentCannotSpawn(n, empty), true, `${n} has no Agent tool ⇒ must be released`)
    }
    // The counter-case: a built-in that DOES hold `*` must still be demanded, or the set is just a
    // blanket release for every unresolvable name and the gate stops covering built-ins at all.
    assert.strictEqual(agentCannotSpawn('general-purpose', empty), false,
      'general-purpose holds * ⇒ it can spawn ⇒ still demanded')
  })

  test('an unreadable newest candidate falls through to the next, it does not discard them all', () => {
    // `statSync` succeeds on a DIRECTORY, so a directory named `a.md` sorts into the candidate list
    // as the newest entry and then throws on read. Abandoning there discarded every OTHER version
    // that would have read fine. The two outcomes are distinguishable only because the readable
    // older file declares Agent: fall-through ⇒ DEMAND (false); give-up ⇒ text null ⇒ RELEASE (true).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-p2-'))
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-c2-'))
    const old = path.join(cache, 'mp', 'plug', '1.0.0', 'agents')
    fs.mkdirSync(old, { recursive: true })
    fs.writeFileSync(path.join(old, 'a.md'), '---\ntools: Read, Agent\n---\n')
    fs.utimesSync(path.join(old, 'a.md'), Date.parse('2020-01-01T00:00:00Z') / 1000, Date.parse('2020-01-01T00:00:00Z') / 1000)
    fs.mkdirSync(path.join(cache, 'mp', 'plug', '2.0.0', 'agents', 'a.md'), { recursive: true })
    assert.strictEqual(agentCannotSpawn('plug:a', dir, cache), false,
      'the readable older version decides; an unreadable newest one is skipped, not fatal')
  })

  test('agentCannotSpawn reads the agent definition: a tools line without Agent means no demand (review F2)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-agents-'))
    fs.writeFileSync(path.join(dir, 'lean.md'), '---\nname: lean\ntools: Bash, Read, Write, Edit\n---\nbody')
    fs.writeFileSync(path.join(dir, 'full.md'), '---\nname: full\ntools: Bash, Agent\n---\nbody')
    fs.writeFileSync(path.join(dir, 'star.md'), '---\nname: star\n---\ntools: Agent mentioned only in the body')
    assert.strictEqual(agentCannotSpawn('lean', dir), true)
    assert.strictEqual(agentCannotSpawn('full', dir), false)
    assert.strictEqual(agentCannotSpawn('star', dir), false, 'no tools line ⇒ unknown ⇒ demand')
    assert.strictEqual(agentCannotSpawn('missing', dir), false)
    assert.strictEqual(agentCannotSpawn('../etc/passwd', dir), false, 'a type is a bare name, never a path')
  })

  test('the tools parse handles *, All tools, an except clause, and a YAML block list', () => {
    // THE OLD ONE-LINE REGEX RELEASED ALL OF THESE. It looked for the literal `Agent` inside
    // whatever the `tools:` line itself captured — which is `*` for an all-tools agent and nothing
    // at all for a block list, whose value lives on the lines below. Each miss silently SKIPPED a
    // review for an agent that could have run one: the directive's exact inverse, and unlike a
    // wedge it never announces itself. Found independently by two reviews, 2026-09-07.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-tools-'))
    const def = (n: string, tools: string) => {
      fs.writeFileSync(path.join(dir, `${n}.md`), `---\nname: ${n}\n${tools}\n---\nbody`)
      return n
    }
    assert.strictEqual(agentCannotSpawn(def('star', 'tools: *'), dir), false, '* includes Agent ⇒ demand')
    assert.strictEqual(agentCannotSpawn(def('all', 'tools: All tools'), dir), false)
    assert.strictEqual(
      agentCannotSpawn(def('most', 'tools: All tools except Agent, Artifact'), dir), true,
      'the except clause takes Agent back out ⇒ release')
    assert.strictEqual(
      agentCannotSpawn(def('blockyes', 'tools:\n  - Read\n  - Agent'), dir), false,
      'a block list naming Agent ⇒ demand')
    assert.strictEqual(agentCannotSpawn(def('blockno', 'tools:\n  - Read\n  - Bash'), dir), true)
    assert.strictEqual(agentCannotSpawn(def('flow', 'tools: [Read, Agent]'), dir), false)
    assert.strictEqual(
      agentCannotSpawn(def('qstar', 'tools: "*"'), dir), false,
      'the QUOTED form is the only YAML-legal one — bare * is an alias node, i.e. a syntax error')
    assert.strictEqual(
      agentCannotSpawn(def('someexcept', 'tools: All tools except Artifact, ExitPlanMode'), dir), false,
      'an except clause that does not name Agent leaves Agent in ⇒ demand')
    // A BLOCK LIST STOPS AT THE FIRST NON-ITEM LINE, so a later key's own list can never be read as
    // this one's — without that bound, any `- Agent` further down the frontmatter would count.
    assert.strictEqual(declaredToolsHaveAgent('tools:\n  - Read\nmodel: x\nother:\n  - Agent\n'), false)
    assert.strictEqual(declaredToolsHaveAgent('name: x\nmodel: y\n'), null, 'no tools key ⇒ unknown, not empty')
  })

  test('every shape that could WEDGE an agent releases instead', () => {
    // WIDENING THE PARSE MADE MISPARSES DANGEROUS. The old regex could only fail to FIND Agent, so
    // its errors all fell toward release; this one infers Agent from `*` and from a list, so a
    // misparse can DEMAND a fork from an agent that cannot spawn one — permanent, and silent until
    // something hangs. These four are the shapes that would do it. Found by review, 2026-09-07.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-wedge-'))
    const write = (n: string, body: string) => {
      fs.writeFileSync(path.join(dir, `${n}.md`), body)
      return n
    }
    assert.strictEqual(
      agentCannotSpawn(write('caps', '---\nname: caps\nTools: Read, Bash\n---\nbody'), dir), true,
      'a capital Tools: key must not fall through to demand')
    assert.strictEqual(
      agentCannotSpawn(write('prose', 'No frontmatter here.\n\ntools:\n  - Read\n  - Agent\n'), dir), true,
      'an unfenced file is not a definition — its prose must never be parsed as a declaration')
    assert.strictEqual(
      declaredToolsHaveAgent('tools: All tools, except-handler, Agent'), true,
      'a tool NAMED except-handler is not an except clause — Agent is still declared')
    assert.strictEqual(
      declaredToolsHaveAgent('tools: [Read, "Agent"]'), true, 'quoted items are stripped')
    assert.strictEqual(
      declaredToolsHaveAgent('tools: All tools, except Artifact, Agent'), false,
      'the comma form is still an except clause — Agent IS excepted here')
  })

  test('frontmatter shapes that a byte-exact fence check would have broken', () => {
    // THE FIRST GUARD I WROTE WAS A REGRESSION. `startsWith("---\\n")` released every CRLF file, every
    // BOM file, and every `--- ` with a trailing space — all three parsed CORRECTLY before it, so it
    // converted right answers into silent skipped reviews. It also missed the wedge it was written
    // for: the body-prose hole comes from a missing CLOSING fence, which an opening-fence check
    // cannot see. Normalizing and requiring both fences is what actually closes it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-fence-'))
    const write = (n: string, body: string) => { fs.writeFileSync(path.join(dir, `${n}.md`), body); return n }
    assert.strictEqual(
      agentCannotSpawn(write('crlf', '---\r\nname: crlf\r\ntools: Read, Agent\r\n---\r\nbody'), dir), false,
      'a CRLF definition still declares Agent ⇒ demand')
    assert.strictEqual(
      agentCannotSpawn(write('bom', '﻿---\nname: bom\ntools: Read, Bash\n---\nbody'), dir), true,
      'a BOM must not decide the verdict')
    assert.strictEqual(
      agentCannotSpawn(write('pad', '--- \nname: pad\ntools: Read, Agent\n---\nbody'), dir), false,
      'a trailing space on the fence must not decide the verdict')
    assert.strictEqual(
      agentCannotSpawn(write('unclosed', '---\nname: unclosed\nmodel: x\n\ntools:\n  - Agent\n'), dir), true,
      'no CLOSING fence ⇒ the body is not frontmatter ⇒ release, never wedge')
  })
})

// ── declaredRole: the CREDIT-path first-line role predicate (TRDD-BA0DCW98, 2026-09-24) ─────────────
//
// declaredRole reads the PARENT's own composed `Agent` tool_use `input.prompt` -- never wrapped by
// the harness, so it is anchored to POSITION as well as shape: the marker must be a WHOLE LINE
// (trailing `\s*` tolerated -- a stray trailing space or `\r` is fine, but prose after the marker is
// not) AND the prompt's literal FIRST non-whitespace line -- no longer matched anywhere in the
// prompt. TRDD-BA0DCW98: matching "anywhere" let a quoted marker line buried in untrusted
// third-party text (a fetched doc, an issue body, a pasted transcript) that the PARENT pasted into a
// spawned agent's brief falsely credit that spawn as the real REVIEW/MEASURE agent -- releasing the
// parent's own gate with no reviewer ever actually asked for. The harness always writes the
// `ROLE: ...` line FIRST and any boilerplate/directive text after it, so first-line anchoring costs
// no legitimate spawn its credit (candidate option 3 in the card). The former LOOSE variant (no
// trailing `$`) is the separate defect fixture K exposed (2026-09-15): a worker fork's prose line
// beginning "ROLE: REVIEW is the marker..." credited the review role with no reviewer ever spawned
// -- whole-line equality (unchanged here) is what keeps fixture K closed; first-line anchoring (new
// here) is what keeps BA0DCW98 closed on the credit path; the two checks are independent and this
// suite covers both. `declaredRoleOwnTranscript` (own suite below) is the SEPARATE self-exemption
// predicate and is deliberately NOT anchored the same way -- do not unify the two.
suite('reviewGate — declaredRole: the marker must be the prompt\'s literal first line', () => {
  test('the marker AS the prompt\'s first line is credited, trailing whitespace or \\r tolerated', () => {
    assert.strictEqual(declaredRole('ROLE: MEASURE'), 'measure')
    assert.strictEqual(declaredRole('ROLE: REVIEW'), 'review')
    assert.strictEqual(declaredRole('ROLE: REVIEW \r\ndo the thing'), 'review', 'trailing space/\\r on the marker line is tolerated')
    assert.strictEqual(declaredRole('ROLE: MEASURE\ndo the thing'), 'measure', 'boilerplate AFTER the marker line does not defeat it')
  })

  test('leading blank lines before the marker still credit -- trimEnd only strips trailing whitespace', () => {
    assert.strictEqual(declaredRole('\n\n   \nROLE: REVIEW\ndo the thing'), 'review')
    assert.strictEqual(declaredRole('\nROLE: MEASURE'), 'measure')
  })

  test('a marker buried after 50+ lines of quoted external material is NOT credited -- TRDD-BA0DCW98', () => {
    const quoted = Array.from({ length: 55 }, (_, i) => `quoted line ${i} pasted from an untrusted fetched document`).join('\n')
    assert.strictEqual(declaredRole(`${quoted}\nROLE: REVIEW\ndo the thing`), null, 'a marker not on the first non-blank line must not self-exempt')
  })

  test('trailing prose on the marker line does NOT credit -- the loose defect fixture K exposed', () => {
    assert.strictEqual(declaredRole('ROLE: REVIEW the following diff and then edit it'), null)
    assert.strictEqual(declaredRole('ROLE: MEASURE the assumptions below'), null)
  })

  test('a second marker on a later line is ignored -- only the first line decides -- and neither marker credits neither', () => {
    // TRDD-BA0DCW98: previously "both markers present" (each its own whole line, anywhere)
    // credited neither; now only the first line is read, so this credits 'measure' -- the
    // second `ROLE: REVIEW` line is inert prose as far as declaredRole is concerned.
    assert.strictEqual(declaredRole('ROLE: MEASURE\nROLE: REVIEW\n'), 'measure')
    assert.strictEqual(declaredRole('just a plain prompt'), null)
  })

  test('the marker quoted mid-sentence is not an anchored marker LINE', () => {
    assert.strictEqual(declaredRole('see ROLE: MEASURE above, then do X'), null)
  })

  test('a marker after even one short line of preceding prose is NOT credited -- position is strict, not boilerplate-length-bounded', () => {
    assert.strictEqual(declaredRole('Here is the protocol:\nROLE: REVIEW\nThat is what it looks like.'), null, 'was credited before BA0DCW98; strict first-line anchoring closes this too')
  })

  test('MUTATION CHECK: dropping the first-line anchor lets a buried marker self-exempt again', () => {
    const withoutPositionAnchor = (prompt: string): 'measure' | 'review' | null => {
      const m = /^ROLE: MEASURE\s*$/m.test(prompt)
      const r = /^ROLE: REVIEW\s*$/m.test(prompt)
      return m === r ? null : (m ? 'measure' : 'review')
    }
    const quoted = Array.from({ length: 55 }, (_, i) => `quoted line ${i}`).join('\n')
    const buried = `${quoted}\nROLE: REVIEW\ndo the thing`
    assert.strictEqual(withoutPositionAnchor(buried), 'review', 'without position anchoring the hole reopens')
    assert.strictEqual(declaredRole(buried), null, 'the real predicate keeps the hole closed')
  })

  test('MUTATION CHECK: dropping the $ anchor must let the trailing-prose hole back in', () => {
    const withoutWholeLineAnchor = (prompt: string): 'measure' | 'review' | null => {
      const firstLine = prompt.split('\n').find((l) => l.trimEnd() !== '')?.trimEnd() ?? ''
      const m = /^ROLE: MEASURE/.test(firstLine)
      const r = /^ROLE: REVIEW/.test(firstLine)
      return m === r ? null : (m ? 'measure' : 'review')
    }
    assert.strictEqual(withoutWholeLineAnchor('ROLE: REVIEW the following diff and then edit it'), 'review', 'without the dollar anchor the hole reopens')
    assert.strictEqual(declaredRole('ROLE: REVIEW the following diff and then edit it'), null, 'the real predicate keeps the hole closed')
  })
})

// ── declaredRoleOwnTranscript: the SELF-EXEMPTION predicate, deliberately NOT first-line-anchored ───
//
// This reads the SPAWNED agent's own first transcript entry, not the parent's raw `input.prompt` --
// per TRDD-3U8AIHXK it may arrive with harness-added preamble ahead of the marker, so anchoring it
// to the first line (the `declaredRole` fix above) risks falsely de-exempting every real REVIEW/
// MEASURE fork and deadlocking the gate (each fork's own SubagentStop would then demand it spawn a
// reviewer of itself). Left loose deliberately (owner direction, 2026-09-24): TRDD-BA0DCW98's
// self-exemption residual therefore stays OPEN on this specific predicate pending a real measurement
// of the harness-wrapped shape -- these tests lock the CURRENT (unchanged) behaviour so nobody
// "fixes" it here without reading why.
suite('reviewGate — declaredRoleOwnTranscript: self-exemption, unanchored by design (BA0DCW98 residual)', () => {
  test('the marker anywhere in the prompt still exempts, trailing whitespace or \\r tolerated', () => {
    assert.strictEqual(declaredRoleOwnTranscript('ROLE: MEASURE'), 'measure')
    assert.strictEqual(declaredRoleOwnTranscript('ROLE: REVIEW \r\ndo the thing'), 'review')
    assert.strictEqual(declaredRoleOwnTranscript('<fork-boilerplate>\nROLE: REVIEW\nAttack the proposal.'), 'review', 'harness-prepended boilerplate must not defeat a real fork\'s exemption')
  })

  test('BA0DCW98 residual: a marker quoted after preceding text still exempts (not fixed on this predicate, by design)', () => {
    assert.strictEqual(declaredRoleOwnTranscript('Here is the protocol:\nROLE: REVIEW\nThat is what it looks like.'), 'review')
  })

  test('trailing prose on the marker line still does NOT exempt -- the fixture K fix is unaffected', () => {
    assert.strictEqual(declaredRoleOwnTranscript('ROLE: REVIEW the following diff and then edit it'), null)
  })

  test('both markers, or neither, exempts neither', () => {
    assert.strictEqual(declaredRoleOwnTranscript('ROLE: MEASURE\nROLE: REVIEW\n'), null)
    assert.strictEqual(declaredRoleOwnTranscript('just a plain prompt'), null)
  })
})

// ── KEPT VERBATIM — runReviewGate: the global kill-switch stderr line ───────────────────────────────
suite('reviewGate — runReviewGate: the global kill-switch stderr line', () => {
  test('AGENTLENS_DISABLED=1 allows the stop AND names which half of the switch fired', async () => {
    const savedEnv = process.env.AGENTLENS_DISABLED
    const writes: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown): boolean => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      process.env.AGENTLENS_DISABLED = '1'
      const code = await runReviewGate([])
      assert.strictEqual(code, 0)
    } finally {
      process.stderr.write = originalWrite
      if (savedEnv === undefined) delete process.env.AGENTLENS_DISABLED
      else process.env.AGENTLENS_DISABLED = savedEnv
    }
    const joined = writes.join('')
    assert.ok(/\[review-gate\]/.test(joined), `no kill-switch line was written: ${JSON.stringify(writes)}`)
    assert.ok(joined.includes('AGENTLENS_DISABLED=1'), `the line must name the env half, not "disabled by the owner": ${joined}`)
  })
})

// ── scanTranscriptLines (owner order 2026-09-15) ─────────────────────────────────────────────────────
suite('reviewGate — scanTranscriptLines', () => {
  test("an Edit outside the ephemeral roots sets work {cause 'edit', detail 'Edit a.ts'} at its index", () => {
    const scan = scanTranscriptLines([assistantLine([editBlock])], CWD)
    assert.deepStrictEqual(scan.work, { index: 0, cause: 'edit', detail: 'Edit a.ts' })
  })

  test("a Bash `git commit -m x` sets work cause 'write-shaped command' with detail 'git commit'", () => {
    const scan = scanTranscriptLines([assistantLine([bashBlock('git commit -m x')])], CWD)
    assert.deepStrictEqual(scan.work, { index: 0, cause: 'write-shaped command', detail: 'git commit' })
  })

  test('an Edit under /tmp does not arm (work null)', () => {
    const tmpEdit = { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/x' } }
    const scan = scanTranscriptLines([assistantLine([tmpEdit])], CWD)
    assert.strictEqual(scan.work, null)
  })

  test('a Write into ~/.claude/plans/ is never gated and does not arm', () => {
    const planWrite = { type: 'tool_use', id: 'toolu_p1', name: 'Write', input: { file_path: path.join(os.homedir(), '.claude', 'plans', 'p.md') } }
    assert.strictEqual(scanTranscriptLines([assistantLine([planWrite])], CWD).work, null)
  })

  test('a Write to a src file still arms with the edit cause', () => {
    const srcWrite = { type: 'tool_use', id: 'toolu_p2', name: 'Write', input: { file_path: '/repo/src/a.ts' } }
    assert.strictEqual(scanTranscriptLines([assistantLine([srcWrite])], CWD).work?.cause, 'edit')
  })

  test("a text block starting with `PROPOSAL FOR ACTION - PLEASE REVIEW` sets work cause 'proposal text' AND lastProposal at its index", () => {
    const scan = scanTranscriptLines([assistantLine([{ type: 'text', text: 'PROPOSAL FOR ACTION - PLEASE REVIEW\n\ndo X' }])], CWD)
    assert.deepStrictEqual(scan.work, { index: 0, cause: 'proposal text', detail: '' })
    assert.strictEqual(scan.lastProposal, 0)
  })

  test('`**PROPOSAL FOR ACTION - PLEASE REVIEW**` and `## PROPOSAL FOR ACTION - PLEASE REVIEW` both arm; the old `PROPOSAL: do X` marker and the phrase mid-sentence do not', () => {
    for (const text of ['**PROPOSAL FOR ACTION - PLEASE REVIEW**\nbody', '## PROPOSAL FOR ACTION - PLEASE REVIEW\nbody']) {
      const scan = scanTranscriptLines([assistantLine([{ type: 'text', text }])], CWD)
      assert.strictEqual(scan.work?.cause, 'proposal text', text)
    }
    for (const text of ['PROPOSAL: do X', 'I wrote a PROPOSAL FOR ACTION - PLEASE REVIEW mid-sentence']) {
      const scan = scanTranscriptLines([assistantLine([{ type: 'text', text }])], CWD)
      assert.strictEqual(scan.work, null, text)
    }
  })

  test('an Agent spawn whose prompt starts `ROLE: REVIEW` credits roles.review at its index ONLY for subagent_type fork', () => {
    const forkScan = scanTranscriptLines([assistantLine([agentBlock('fork', 'ROLE: REVIEW\ndo it')])], CWD)
    assert.strictEqual(forkScan.roles.review, 0)
    assert.strictEqual(forkScan.roles.measure, -1)
  })

  test('a `lean-worker` spawn whose prompt starts `ROLE: REVIEW` does NOT credit review — only a fork does', () => {
    const scan = scanTranscriptLines([assistantLine([agentBlock('lean-worker', 'ROLE: REVIEW\ndo it')])], CWD)
    assert.strictEqual(scan.roles.review, -1)
    assert.strictEqual(scan.roles.measure, -1)
  })

  test('fixture K: a fork spawn whose prompt merely DESCRIBES the marker (prose after it on the same line) after an Edit leaves review uncredited and the gate still demands review', () => {
    const lines = [
      assistantLine([editBlock]),
      assistantLine([agentBlock('fork', 'Refactor the parser.\nROLE: REVIEW is the marker the gate looks for; do not use it here.')]),
    ]
    const scan = scanTranscriptLines(lines, CWD)
    assert.strictEqual(scan.roles.review, -1)
    assert.strictEqual(decideGate(scan), 'review')
  })

  test('a fork spawn whose prompt is `ROLE: REVIEW \\r\\nreview this` credits review', () => {
    const scan = scanTranscriptLines([assistantLine([agentBlock('fork', 'ROLE: REVIEW \r\nreview this')])], CWD)
    assert.strictEqual(scan.roles.review, 0)
  })

  // TRDD-QQ2XIIZ6 amendment B: INVESTIGATE is a worker-scan role only (workerDeclaredRole); gate credit stays MEASURE/REVIEW.
  test('an INVESTIGATE fork earns NO credit: it can never satisfy a MEASURE or a REVIEW demand', () => {
    const scan = scanTranscriptLines([assistantLine([agentBlock('fork', 'ROLE: INVESTIGATE\nfind it')])], CWD)
    assert.deepStrictEqual(scan.roles, { measure: -1, review: -1 })
    assert.strictEqual(declaredRole('ROLE: INVESTIGATE'), null)
    assert.strictEqual(workerDeclaredRole('ROLE: INVESTIGATE\nfind it'), 'investigate', 'control: the worker scan does recognise it')
  })

  test('a `lean-worker` spawn whose prompt starts `ROLE: MEASURE` earns NO measure credit: only a fork does (QQ2XIIZ6)', () => {
    const scan = scanTranscriptLines([assistantLine([agentBlock('lean-worker', 'ROLE: MEASURE\nsettle it')])], CWD)
    assert.strictEqual(scan.roles.measure, -1)
    assert.strictEqual(scan.roles.review, -1)
  })

  test('an Agent FORK spawn whose prompt starts `ROLE: MEASURE` credits roles.measure; a second marker on a later line is ignored, and no marker credits nothing', () => {
    const measureScan = scanTranscriptLines([assistantLine([agentBlock('fork', 'ROLE: MEASURE\nsettle it')])], CWD)
    assert.strictEqual(measureScan.roles.measure, 0)
    assert.strictEqual(measureScan.roles.review, -1)
    // TRDD-BA0DCW98: only the FIRST line is read, so a second marker line can no longer make
    // "both" true — the first line alone decides, and here it is exactly `ROLE: MEASURE`.
    const secondLineIgnoredScan = scanTranscriptLines([assistantLine([agentBlock('fork', 'ROLE: MEASURE\nROLE: REVIEW\n')])], CWD)
    assert.deepStrictEqual(secondLineIgnoredScan.roles, { measure: 0, review: -1 })
    const neitherScan = scanTranscriptLines([assistantLine([agentBlock('lean-worker', 'just do it')])], CWD)
    assert.deepStrictEqual(neitherScan.roles, { measure: -1, review: -1 })
  })

  test('a spawn credit is PERMANENT: a later tool_result for that spawn with no heading, and a later `<task-notification>` string entry, leave roles unchanged', () => {
    const lines = [
      assistantLine([agentBlock('fork', 'ROLE: REVIEW\ndo it')]),
      toolResultLine('t1', 'looks fine, no heading here'),
      userStringLine('<task-notification>fork finished</task-notification>'),
    ]
    const scan = scanTranscriptLines(lines, CWD)
    assert.strictEqual(scan.roles.review, 0)
  })

  test('the no-review sentinel text credits both roles at its index; the sentinel followed by an essay credits nothing', () => {
    const scan = scanTranscriptLines([assistantLine([{ type: 'text', text: `${NO_REVIEW_SENTINEL} — rate-limited` }])], CWD)
    assert.strictEqual(scan.roles.measure, 0)
    assert.strictEqual(scan.roles.review, 0)
    const essayScan = scanTranscriptLines(
      [assistantLine([{ type: 'text', text: `${NO_REVIEW_SENTINEL} — rate-limited\n\nAnyway, here is what I changed.` }])], CWD)
    assert.deepStrictEqual(essayScan.roles, { measure: -1, review: -1 })
  })

  test('a `[janitor-heartbeat]…` string prompt after an Edit is a floor: work null, lastProposal -1; an Edit AFTER the floor arms again', () => {
    const lines = [assistantLine([editBlock]), userStringLine('[janitor-heartbeat] findings: none')]
    const scan = scanTranscriptLines(lines, CWD)
    assert.strictEqual(scan.work, null)
    assert.strictEqual(scan.lastProposal, -1)
    const scan2 = scanTranscriptLines([...lines, assistantLine([editBlock])], CWD)
    assert.deepStrictEqual(scan2.work, { index: 2, cause: 'edit', detail: 'Edit a.ts' })
  })

  test('`[Request interrupted by user]` and `[Request interrupted by user for tool use]` text-block entries are floors; a `Stop hook feedback:` string entry, a `<task-notification>` string entry and a tool_result entry are NOT floors', () => {
    for (const text of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
      const lines = [assistantLine([editBlock]), userTextLine(text)]
      const scan = scanTranscriptLines(lines, CWD)
      assert.strictEqual(scan.work, null, text)
    }
    for (const line of [
      userStringLine('Stop hook feedback: something'),
      userStringLine('<task-notification>done</task-notification>'),
      toolResultLine('t1', 'ok'),
    ]) {
      const scan = scanTranscriptLines([assistantLine([editBlock]), line], CWD)
      assert.deepStrictEqual(scan.work, { index: 0, cause: 'edit', detail: 'Edit a.ts' })
    }
  })

  test('a user entry whose content array pairs a tool_result with an interrupt text block IS a floor', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'x' },
        { type: 'text', text: '[Request interrupted by user for tool use]' },
      ] },
    })
    const scan = scanTranscriptLines([assistantLine([editBlock]), line], CWD)
    assert.strictEqual(scan.work, null)
  })

  test('isSidechain entries and malformed lines are skipped; ownRole comes from the FIRST user entry only (string and text-block shapes), a later `ROLE: MEASURE` user entry does not set it', () => {
    const sidechainLine = JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [editBlock] } })
    const malformed = '{not json'
    const scan = scanTranscriptLines([sidechainLine, malformed, assistantLine([editBlock])], CWD)
    assert.deepStrictEqual(scan.work, { index: 2, cause: 'edit', detail: 'Edit a.ts' })

    const stringOwn = scanTranscriptLines([userStringLine('ROLE: REVIEW\nattack it'), assistantLine([editBlock])], CWD)
    assert.strictEqual(stringOwn.ownRole, 'review')
    const textOwn = scanTranscriptLines([userTextLine('ROLE: MEASURE\nsettle it'), assistantLine([editBlock])], CWD)
    assert.strictEqual(textOwn.ownRole, 'measure')
    const laterRole = scanTranscriptLines([
      userStringLine('do some work'),
      assistantLine([editBlock]),
      userStringLine('ROLE: MEASURE\nsettle it'),
    ], CWD)
    assert.strictEqual(laterRole.ownRole, null)
  })
})

// ── decideGate ────────────────────────────────────────────────────────────────────────────────────
suite('reviewGate — decideGate', () => {
  test('null when work is null', () => {
    assert.strictEqual(decideGate({ work: null, lastProposal: -1, roles: { measure: -1, review: -1 } }), null)
  })

  test("'review' when an edit has no review credit at or after it", () => {
    const s = { work: { index: 2, cause: 'edit' as const, detail: 'Edit a.ts' }, lastProposal: -1, roles: { measure: -1, review: -1 } }
    assert.strictEqual(decideGate(s), 'review')
  })

  test('null when roles.review >= work.index (equal index releases)', () => {
    const s = { work: { index: 2, cause: 'edit' as const, detail: 'Edit a.ts' }, lastProposal: -1, roles: { measure: -1, review: 2 } }
    assert.strictEqual(decideGate(s), null)
  })

  test("'both' when a proposal has neither credit", () => {
    const s = { work: { index: 2, cause: 'proposal text' as const, detail: '' }, lastProposal: 2, roles: { measure: -1, review: -1 } }
    assert.strictEqual(decideGate(s), 'both')
  })

  test("'measure' when a proposal has a review credit after it but no measure credit", () => {
    const s = { work: { index: 2, cause: 'proposal text' as const, detail: '' }, lastProposal: 2, roles: { measure: -1, review: 3 } }
    assert.strictEqual(decideGate(s), 'measure')
  })

  test("'review' when proposal + measure + review are credited in order and a LATER edit follows", () => {
    const s = { work: { index: 4, cause: 'edit' as const, detail: 'Edit a.ts' }, lastProposal: 1, roles: { measure: 2, review: 3 } }
    assert.strictEqual(decideGate(s), 'review')
  })

  test('null when proposal then measure then review, all in order', () => {
    const s = { work: { index: 1, cause: 'proposal text' as const, detail: '' }, lastProposal: 1, roles: { measure: 2, review: 3 } }
    assert.strictEqual(decideGate(s), null)
  })
})

// ── subagentExempt ────────────────────────────────────────────────────────────────────────────────
suite('reviewGate — demandText is short enough to read inside a block (C)', () => {
  test('the demandText for a review spawn is under 1200 characters and says a write after the spawn re-arms the gate', () => {
    const t = demandText('review')
    assert.ok(t.length < 1200, 'demandText review is ' + t.length + ' characters')
    assert.ok(t.includes('re-arms'))
  })

  test('the demandText for a both spawn is under 2700 characters', () => {
    const t = demandText('both')
    assert.ok(t.length < 2700, 'demandText both is ' + t.length + ' characters')
  })
})
suite('reviewGate — subagentExempt', () => {
  test("'' and 'fork' (case-folded, padded) are exempt", () => {
    assert.strictEqual(subagentExempt('', null), true)
    assert.strictEqual(subagentExempt('  ', null), true)
    assert.strictEqual(subagentExempt('fork', null), true)
    assert.strictEqual(subagentExempt('FORK', null), true)
    assert.strictEqual(subagentExempt(' fork ', null), true)
  })

  test('`ai-maestro-janitor:janitor-memory-subconscious-agent` and bare `janitor-repair-agent` are exempt', () => {
    assert.strictEqual(subagentExempt('ai-maestro-janitor:janitor-memory-subconscious-agent', null), true)
    assert.strictEqual(subagentExempt('janitor-repair-agent', null), true)
  })

  test('`lean-worker`, `wtfork`, `my-janitor-x` are NOT exempt', () => {
    for (const type of ['lean-worker', 'wtfork', 'my-janitor-x']) {
      assert.strictEqual(subagentExempt(type, null), false, type)
    }
  })

  test("any type with ownRole 'measure' or 'review' is exempt", () => {
    assert.strictEqual(subagentExempt('lean-worker', 'measure'), true)
    assert.strictEqual(subagentExempt('lean-worker', 'review'), true)
  })

  test("JANITOR_AGENT_RE is anchored: 'ai-maestro-janitor:' alone without 'janitor-' after it is not exempt", () => {
    assert.strictEqual(JANITOR_AGENT_RE.test('ai-maestro-janitor:something-else'), false)
    assert.strictEqual(subagentExempt('ai-maestro-janitor:something-else', null), false)
  })
})

// ── isFloorPrompt / userPromptText ───────────────────────────────────────────────────────────────
suite('reviewGate — isFloorPrompt / userPromptText', () => {
  test("userPromptText returns the string content, joins text blocks, and returns '' for a tool_result array", () => {
    assert.strictEqual(userPromptText('hello'), 'hello')
    assert.strictEqual(userPromptText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
    assert.strictEqual(userPromptText([{ type: 'tool_result', tool_use_id: 't1', content: 'x' }]), '')
  })

  test('isFloorPrompt is true for HEARTBEAT_PREFIX and INTERRUPT_PREFIX after leading whitespace', () => {
    assert.strictEqual(isFloorPrompt(`  ${HEARTBEAT_PREFIX} findings: none`), true)
    assert.strictEqual(isFloorPrompt(`\n${INTERRUPT_PREFIX}]`), true)
  })

  test('isFloorPrompt is false for a heartbeat quoted mid-text and for an empty content', () => {
    assert.strictEqual(isFloorPrompt(`quoting ${HEARTBEAT_PREFIX} mid text`), false)
    assert.strictEqual(isFloorPrompt(''), false)
    assert.strictEqual(isFloorPrompt([]), false)
  })

  test('isFloorPrompt is true for an array pairing a tool_result with an interrupt text block, and false for a tool_result-only array', () => {
    assert.strictEqual(isFloorPrompt([
      { type: 'tool_result', tool_use_id: 't1', content: 'x' },
      { type: 'text', text: '[Request interrupted by user for tool use]' },
    ]), true)
    assert.strictEqual(isFloorPrompt([{ type: 'tool_result', tool_use_id: 't1', content: 'x' }]), false)
  })
})

// ── messages ──────────────────────────────────────────────────────────────────────────────────────
suite('reviewGate — messages', () => {
  test("demandText('review') contains REVIEW_ROLE_RULE and not MEASURE_ROLE_RULE", () => {
    const t = demandText('review')
    assert.ok(t.includes(REVIEW_ROLE_RULE))
    assert.ok(!t.includes(MEASURE_ROLE_RULE))
  })

  test("demandText('both') contains both rules with the MEASURE rule first", () => {
    const t = demandText('both')
    assert.ok(t.includes(REVIEW_ROLE_RULE))
    assert.ok(t.includes(MEASURE_ROLE_RULE))
    assert.ok(t.indexOf(MEASURE_ROLE_RULE) < t.indexOf(REVIEW_ROLE_RULE))
  })

  test("demandText('measure') contains only the MEASURE rule", () => {
    const t = demandText('measure')
    assert.ok(t.includes(MEASURE_ROLE_RULE))
    assert.ok(!t.includes(REVIEW_ROLE_RULE))
  })

  test("demandText('measure') names a MEASURE fork with no isolation, and requires a numbered step list", () => {
    const t = demandText('measure')
    assert.ok(t.includes('MEASURE fork'))
    assert.ok(t.includes('NO isolation parameter'))
    assert.ok(!t.includes('fast-worker'))
    assert.ok(t.includes('numbered'))
  })

  test('every demandText carries NO_REVIEW_SENTINEL, PROPOSAL_MARKER, the word LAST and `review-gate --directive`', () => {
    for (const d of ['review', 'measure', 'both'] as const) {
      const t = demandText(d)
      assert.ok(t.includes(NO_REVIEW_SENTINEL), d)
      assert.ok(t.includes(PROPOSAL_MARKER), d)
      assert.ok(/\bLAST\b/.test(t), d)
      assert.ok(t.includes('review-gate --directive'), d)
      assert.ok(t.includes('the ROLE marker is the FIRST NON-BLANK line of its'), d)
    }
  })

  test('mainBlockReason and subagentBlockReason name ARM_CAUSE_TEXT[cause] + detail; the subagent one ends with the sentinel-start sentence', () => {
    const main = mainBlockReason('edit', 'Edit a.ts', 'review')
    assert.ok(main.includes(ARM_CAUSE_TEXT.edit))
    assert.ok(main.includes('Edit a.ts'))
    const sub = subagentBlockReason('edit', 'Edit a.ts', 'review')
    assert.ok(sub.includes(ARM_CAUSE_TEXT.edit))
    assert.ok(sub.includes('Edit a.ts'))
    assert.ok(sub.trim().endsWith('a quoted copy will not count).'), sub)
  })

  test('REVIEW_GATE_DIRECTIVE carries PROPOSAL_MARKER, both role rules, `[janitor-heartbeat]`, `interrupted`, `ai-maestro-janitor` and every NO_REVIEW_SENTINEL_EXAMPLES entry', () => {
    assert.ok(REVIEW_GATE_DIRECTIVE.includes(PROPOSAL_MARKER))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes(REVIEW_ROLE_RULE))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes(MEASURE_ROLE_RULE))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes('[janitor-heartbeat]'))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes('interrupted'))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes('ai-maestro-janitor'))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes('Only a `fork` spawn with NO `isolation` parameter credits a role'))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes('only the turn that just ended decides'))
    for (const ex of NO_REVIEW_SENTINEL_EXAMPLES) assert.ok(REVIEW_GATE_DIRECTIVE.includes(ex), ex)
  })

  // TRDD-BA0DCW98: the directive text (REVIEW_ROLE_RULE/MEASURE_ROLE_RULE) and demandText's own
  // wording both instruct "the marker must be the prompt's FIRST line" -- this pins that the
  // instruction and the enforcing predicate (`declaredRole`) actually agree, so a future edit to
  // either cannot silently drift the promise from the enforcement again (the original bug this
  // card fixed was exactly that mismatch, just for the OTHER direction -- "a line", not "the first
  // line").
  test('the FIRST-line instruction and declaredRole agree: a prompt built exactly as instructed is credited, one line of prose before the marker is not', () => {
    assert.ok(REVIEW_ROLE_RULE.includes('FIRST line'))
    assert.ok(MEASURE_ROLE_RULE.includes('FIRST line'))
    assert.ok(demandText('both').includes('the ROLE marker is the FIRST NON-BLANK line of its'))
    // Built exactly as REVIEW_ROLE_RULE/MEASURE_ROLE_RULE instructs: the marker on its own as the
    // prompt's first line, nothing before it.
    assert.strictEqual(declaredRole('ROLE: REVIEW\nAttack the proposal.'), 'review')
    assert.strictEqual(declaredRole('ROLE: MEASURE\nSettle the assumptions.'), 'measure')
    // One line of prose before the marker -- the directive says "nothing before it", so this must
    // NOT be credited; a laxer implementation ("a line", not "the FIRST line") would have credited it.
    assert.strictEqual(declaredRole('Understood, spawning the reviewer now.\nROLE: REVIEW\nAttack the proposal.'), null)
    assert.strictEqual(declaredRole('Understood.\nROLE: MEASURE\nSettle the assumptions.'), null)
    // The realistic failure this card fixed: a parent that follows the rule's OWN text literally,
    // pasting the rule line ABOVE the marker instead of the marker first, must still be rejected --
    // and the marker followed by the pasted rule (as REVIEW_ROLE_RULE/MEASURE_ROLE_RULE instruct)
    // must still be credited.
    assert.strictEqual(declaredRole('ROLE: REVIEW\n' + REVIEW_ROLE_RULE), 'review')
    assert.strictEqual(declaredRole(REVIEW_ROLE_RULE + '\nROLE: REVIEW'), null)
    assert.strictEqual(declaredRole('ROLE: MEASURE\n' + MEASURE_ROLE_RULE), 'measure')
    assert.strictEqual(declaredRole(MEASURE_ROLE_RULE + '\nROLE: MEASURE'), null)
  })
})

// ── runMainGate / runReviewGate end to end (real temp dir, real transcript files) ───────────────────
suite('reviewGate — runMainGate / runReviewGate end to end', () => {
  const mkTranscript = (lines: string[]): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-e2e-'))
    const file = path.join(dir, 'transcript.jsonl')
    fs.writeFileSync(file, lines.join('\n') + '\n')
    return file
  }

  test("edit-only transcript → a JSON block whose reason contains 'edited a file'", async () => {
    const transcript_path = mkTranscript([assistantLine([editBlock])])
    const out = await runMainGate({ transcript_path, cwd: CWD })
    assert.ok(out !== null)
    const parsed = JSON.parse(out as string) as { decision: string; reason: string }
    assert.strictEqual(parsed.decision, 'block')
    assert.ok(parsed.reason.includes('edited a file'))
  })

  test('edit then a `ROLE: REVIEW` fork spawn → null; edit then heartbeat prompt then text → null; edit then interrupt entry → null', async () => {
    const t1 = mkTranscript([assistantLine([editBlock]), assistantLine([agentBlock('fork', 'ROLE: REVIEW\nattack it')])])
    assert.strictEqual(await runMainGate({ transcript_path: t1, cwd: CWD }), null)
    const t2 = mkTranscript([
      assistantLine([editBlock]),
      userStringLine('[janitor-heartbeat] findings: none'),
      assistantLine([{ type: 'text', text: 'janitor heartbeat' }]),
    ])
    assert.strictEqual(await runMainGate({ transcript_path: t2, cwd: CWD }), null)
    const t3 = mkTranscript([assistantLine([editBlock]), userTextLine('[Request interrupted by user]')])
    assert.strictEqual(await runMainGate({ transcript_path: t3, cwd: CWD }), null)
  })

  test('mutation check: the same heartbeat fixture with the prompt `janitor-heartbeat` (no brackets) → still blocks', async () => {
    const t = mkTranscript([assistantLine([editBlock]), userStringLine('janitor-heartbeat findings: none')])
    const out = await runMainGate({ transcript_path: t, cwd: CWD })
    assert.ok(out !== null, 'without the brackets, the prefix must not match — the gate must still block')
  })

  test('SubagentStop via runReviewGate with a piped payload is out of scope; instead call runMainGate with a missing transcript_path → null, and with an unreadable path → null', async () => {
    assert.strictEqual(await runMainGate({}), null)
    assert.strictEqual(await runMainGate({ transcript_path: '/nonexistent/path/x.jsonl' }), null)
  })

  test("SubagentStop decision through the exported pieces: for an edit-only transcript, subagentExempt('ai-maestro-janitor:janitor-memory-subconscious-agent', null) is true and decideGate(scanTranscriptLines(lines,'/repo')) is 'review' for a non-exempt type", () => {
    const lines = [assistantLine([editBlock])]
    assert.strictEqual(subagentExempt('ai-maestro-janitor:janitor-memory-subconscious-agent', null), true)
    const scan = scanTranscriptLines(lines, '/repo')
    assert.strictEqual(decideGate(scan), 'review')
  })
})

// ── SubagentStop sees the worker's OWN sidechain entries (TRDD-LZ2JDIJP) ─────────────────────────
// A subagent's own transcript is isSidechain:true on every entry, each carrying its own agentId.
// Skipping all sidechain entries made the gate scan nothing: 382 of 387 writing subagents were never reviewed.
suite('reviewGate — runSubagentGate: own sidechain entries are scanned (TRDD-LZ2JDIJP)', () => {
  const sc = (agentId: string, entry: Record<string, unknown>): string => JSON.stringify({ isSidechain: true, agentId, ...entry })
  const scUser = (agentId: string, text: string): string => sc(agentId, { type: 'user', message: { role: 'user', content: text } })
  const scAssistant = (agentId: string, blocks: unknown[]): string => sc(agentId, { type: 'assistant', message: { content: blocks } })
  const writeBlock = bashBlock("fastedit create evals/x.md --force --content 'a'")
  const mkTranscript = (lines: string[]): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-sub-'))
    const file = path.join(dir, 'agent-w1.jsonl')
    fs.writeFileSync(file, lines.join('\n') + '\n')
    return file
  }
  const stop = (agent_transcript_path: string) =>
    runSubagentGate({ hook_event_name: 'SubagentStop', agent_id: 'w1', agent_type: 'general-purpose', agent_transcript_path, cwd: CWD })

  test('a worker whose every entry is its own sidechain and which wrote a file is BLOCKED', async () => {
    const t = mkTranscript([scUser('w1', 'do the thing'), scAssistant('w1', [writeBlock])])
    const out = await stop(t)
    assert.ok(out !== null, 'the worker wrote and spawned no reviewer — must block')
    assert.strictEqual((JSON.parse(out) as { decision: string }).decision, 'block')
  })

  test('the same write attributed to a nested grandchild (other agentId) is excluded → allow', async () => {
    const t = mkTranscript([scUser('w1', 'do the thing'), scAssistant('grandchild', [writeBlock])])
    assert.strictEqual(await stop(t), null)
  })

  test('`ROLE: MEASURE` mid-sentence does not exempt a worker; as a whole line it does (existing declaredRoleOwnTranscript behaviour)', async () => {
    const mid = mkTranscript([scUser('w1', 'Explain how ROLE: MEASURE works in the gate'), scAssistant('w1', [writeBlock])])
    assert.ok(await stop(mid) !== null, 'a mid-sentence mention must not exempt')
    const whole = mkTranscript([scUser('w1', 'preamble\nROLE: MEASURE\nmeasure it'), scAssistant('w1', [writeBlock])])
    assert.strictEqual(await stop(whole), null, 'a whole-line marker anywhere in the brief self-exempts (unanchored by design)')
  })

  test('the MAIN Stop gate still ignores a transcript whose only write is a sidechain entry', async () => {
    const t = mkTranscript([scUser('w1', 'x'), scAssistant('w1', [writeBlock])])
    assert.strictEqual(await runMainGate({ transcript_path: t, cwd: CWD }), null)
  })
})

// ── Record writes after a review (TRDD-9YWTNFU8) ─────────────────────────────────────────────────
// One card append and one path-limited card commit ride each review; a second of either arms, and a
// write that is not a record arms whatever came before it.
suite('reviewGate — scanTranscriptLines: record writes after a review', () => {
  const CARD = 'ABCD1234'
  const reviewOf = (id: string) => agentBlock('fork', `ROLE: REVIEW\nReview the change recorded on TRDD-${id}.`)
  const append = (id: string) => bashBlock(`trddgrep append ${id} "## Review" "no findings"`)
  const cardCommit = bashBlock('git commit -m x -- design/tasks/a.md')
  // Each inner array is one assistant entry, in transcript order.
  const gate = (entries: unknown[][]) => decideGate(scanTranscriptLines(entries.map((blocks) => assistantLine(blocks)), CWD))

  test('a review followed by one card append releases the gate', () => {
    assert.strictEqual(gate([[reviewOf(CARD)], [append(CARD)]]), null)
  })

  test('a review followed by one card append and one path-limited card commit releases the gate', () => {
    assert.strictEqual(gate([[reviewOf(CARD)], [append(CARD)], [cardCommit]]), null)
  })

  test('a second append after the review arms the gate', () => {
    assert.strictEqual(gate([[reviewOf(CARD)], [append(CARD)], [append(CARD)]]), 'review')
  })

  test('a second card commit after the review arms the gate', () => {
    assert.strictEqual(gate([[reviewOf(CARD)], [cardCommit], [cardCommit]]), 'review')
  })

  test('a second review re-opens one append and one card commit', () => {
    assert.strictEqual(gate([[reviewOf(CARD)], [cardCommit], [reviewOf(CARD)], [cardCommit]]), null)
  })

  test('an append to a card the review did not name arms the gate', () => {
    assert.strictEqual(gate([[reviewOf(CARD)], [append('WXYZ9876')]]), 'review')
  })

  test('an id that is only a substring of a longer token in the review prompt does not count as named', () => {
    assert.strictEqual(gate([[reviewOf(`X${CARD}Y`)], [append(CARD)]]), 'review')
  })

  test('an edit after the review arms the gate, and an append after that edit is not exempt', () => {
    assert.strictEqual(gate([[reviewOf(CARD)], [editBlock], [append(CARD)]]), 'review')
  })

  test('an append with no review at all arms the gate', () => {
    assert.strictEqual(gate([[append(CARD)]]), 'review')
  })

  test('a no-review sentinel is not a review to record against', () => {
    assert.strictEqual(gate([[{ type: 'text', text: `${NO_REVIEW_SENTINEL} — rate-limited` }], [append(CARD)]]), 'review')
  })

  test('a trddgrep edit after the review arms the gate', () => {
    assert.strictEqual(gate([[reviewOf(CARD)], [bashBlock('trddgrep edit ABCD1234 --expect a --replace b')]]), 'review')
  })

  test('a commit that is not path-limited after the review arms the gate', () => {
    assert.strictEqual(gate([[reviewOf(CARD)], [bashBlock('git add design/tasks/a.md && git commit -m x')]]), 'review')
  })
})

// ── A delegate-gate-denied Edit never ran, so it must not arm (TRDD-PNB9FNJ0) ────────────────────
suite('reviewGate — scanTranscriptLines: a delegate-gate-denied edit does not arm', () => {
  const editWithId = (id: string) => ({ type: 'tool_use', id, name: 'Edit', input: { file_path: '/repo/src/a.ts' } })
  // The deny text is the one the delegate gate itself emits; the wrapper around it is the test's guess.
  const deniedResult = (id: string, isError: boolean): string =>
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: `PreToolUse:Edit hook error: ${DELEGATE_DENY_REASON}` }] } })

  test('a denied Edit (is_error tool_result carrying the deny text) is not work', () => {
    const scan = scanTranscriptLines([assistantLine([editWithId('toolu_d1')]), deniedResult('toolu_d1', true)], CWD)
    assert.strictEqual(scan.work, null)
  })

  test('an allowed Edit still arms, and the deny of a DIFFERENT tool_use does not un-arm it', () => {
    const allowed = scanTranscriptLines([assistantLine([editWithId('toolu_a1')]), toolResultLine('toolu_a1', 'updated')], CWD)
    assert.strictEqual(allowed.work?.cause, 'edit')
    const other = scanTranscriptLines([assistantLine([editWithId('toolu_a2')]), deniedResult('toolu_other', true)], CWD)
    assert.strictEqual(other.work?.cause, 'edit')
  })

  test('the deny text quoted in a NON-error result (an Edit echoing file content) does not un-arm', () => {
    const scan = scanTranscriptLines([assistantLine([editWithId('toolu_q1')]), deniedResult('toolu_q1', false)], CWD)
    assert.strictEqual(scan.work?.cause, 'edit')
  })

  // The gate denies editor tools only; a Bash that RAN, wrote, failed and printed the sentence is work.
  test('a write-shaped Bash whose error result quotes the deny sentence still arms', () => {
    const bash = { type: 'tool_use', id: 'toolu_b1', name: 'Bash', input: { command: 'sed -i s/a/b/ /repo/src/a.ts' } }
    const scan = scanTranscriptLines([assistantLine([bash]), deniedResult('toolu_b1', true)], CWD)
    assert.strictEqual(scan.work?.cause, 'write-shaped command')
  })


  // ── The turn scope and the fork-only, unisolated credit (QQ2XIIZ6) ──────────────────────────────────
  // Fixtures copy the entry SHAPES measured on real transcripts (2026-10-14), not their text: a turn
  // starts at a non-sidechain `user` entry with an object `turnPosition`; a heartbeat is one of those
  // with `isMeta: true`; the Stop hook's feedback is `isMeta` with no `turnPosition`.
  suite('reviewGate — per-turn scope and the fork-only credit (QQ2XIIZ6)', () => {
    const turnStart = (content: unknown, turnOrigin = 'human', turnIndex = 1): string => JSON.stringify({
      parentUuid: 'p', isSidechain: false, promptId: `prompt-${turnIndex}`, type: 'user',
      message: { role: 'user', content }, turnOrigin, turnPosition: { promptIndex: turnIndex, turnIndex }, userType: 'external',
    })
    const heartbeat = (turnIndex: number): string => JSON.stringify({
      parentUuid: 'p', isSidechain: false, isMeta: true, promptId: `hb-${turnIndex}`, type: 'user',
      message: { role: 'user', content: '[janitor-heartbeat]\n/x/dispatcher-stub.py\nHandle this fire.' },
      turnOrigin: 'scheduled', turnPosition: { promptIndex: turnIndex, turnIndex }, userType: 'external',
    })
    const stopFeedback = (): string => JSON.stringify({
      parentUuid: 'p', isSidechain: false, isMeta: true, type: 'user',
      message: { role: 'user', content: 'Stop hook feedback: [review-gate] demanded a review' },
    })
    const attachment = (text: string): string => JSON.stringify({
      parentUuid: 'p', isSidechain: false, type: 'attachment', attachment: { type: 'hook_success', content: text },
    })
    const notification = (id: string): string =>
      `<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>`
    const enqueue = (id: string): string => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: notification(id) })
    const forkSpawn = (prompt: string, isolation?: string) =>
      ({ type: 'tool_use', name: 'Agent', input: { subagent_type: 'fork', prompt, ...(isolation === undefined ? {} : { isolation }) } })
    const withFile = <T>(lines: string[], run: (file: string) => T): T => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-turn-'))
      try {
        const file = path.join(dir, 'main.jsonl')
        fs.writeFileSync(file, lines.join('\n') + '\n')
        return run(file)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    const runGate = (lines: string[]): Promise<string | null> =>
      withFile(lines, (file) => runMainGate({ transcript_path: file, cwd: CWD }))
    const reasonOf = (out: string | null): string => (JSON.parse(out as string) as { reason: string }).reason

    test('isTurnStart: a non-sidechain user entry with a turnPosition object starts a turn, even when isMeta; feedback, tool results, sidechain entries and heartbeat attachments do not', () => {
      assert.strictEqual(JSON.parse(heartbeat(2)).isMeta, true)
      assert.strictEqual(isTurnStart(JSON.parse(turnStart('fix it'))), true)
      assert.strictEqual(isTurnStart(JSON.parse(heartbeat(2))), true)
      assert.strictEqual(isTurnStart(JSON.parse(stopFeedback())), false)
      assert.strictEqual(isTurnStart(JSON.parse(toolResultLine('t1', 'ok'))), false)
      assert.strictEqual(isTurnStart(JSON.parse(JSON.stringify({ type: 'user', isSidechain: true, turnPosition: { turnIndex: 2 }, message: { content: 'x' } }))), false)
      assert.strictEqual(isTurnStart(JSON.parse(attachment('[janitor-heartbeat] status: quiet'))), false)
    })

    test('edit → isMeta Stop-hook feedback → BLOCKS: the feedback does not start a new turn', async () => {
      const out = await runGate([turnStart('fix it'), assistantLine([editBlock]), stopFeedback()])
      assert.ok(out !== null, 'the feedback must not end the turn that wrote the file')
      assert.ok(reasonOf(out).includes('edited a file'))
    })

    test('an edit in an earlier human turn does not block a later human turn with no writes', async () => {
      const out = await runGate([
        turnStart('edit it', 'human', 1), assistantLine([editBlock]), assistantLine([{ type: 'text', text: 'done' }]),
        turnStart('what time is it', 'human', 2), assistantLine([{ type: 'text', text: 'noon' }]),
      ])
      assert.strictEqual(out, null)
    })

    test('a heartbeat turn after a written human turn, with no writes, PASSES', async () => {
      const out = await runGate([
        turnStart('edit it', 'human', 1), assistantLine([editBlock]),
        heartbeat(2), assistantLine([{ type: 'text', text: 'janitor heartbeat' }]),
      ])
      assert.strictEqual(out, null)
    })

    test('a heartbeat turn that writes and spawns no review BLOCKS', async () => {
      const out = await runGate([
        turnStart('hi', 'human', 1), assistantLine([{ type: 'text', text: 'hello' }]),
        heartbeat(2), assistantLine([editBlock]),
      ])
      assert.ok(out !== null)
      assert.ok(reasonOf(out).includes('edited a file'))
    })

    test('an attachment quoting [janitor-heartbeat] between an edit and the Stop does not start a turn, so the edit still BLOCKS', async () => {
      const out = await runGate([
        turnStart('edit it'), assistantLine([editBlock]),
        attachment('[janitor-heartbeat] status: quiet'), assistantLine([{ type: 'text', text: 'ok' }]),
      ])
      assert.ok(out !== null, 'an attachment mid-turn must not split the turn and release the edit')
    })

    test('a REVIEW fork with isolation "worktree" earns no credit and BLOCKS; the same fork without isolation PASSES', async () => {
      const isolated = await runGate([turnStart('edit it'), assistantLine([editBlock]), assistantLine([forkSpawn('ROLE: REVIEW\nattack it', 'worktree')])])
      assert.ok(isolated !== null, 'an isolated spawn must not release the gate')
      const plain = await runGate([turnStart('edit it'), assistantLine([editBlock]), assistantLine([forkSpawn('ROLE: REVIEW\nattack it')])])
      assert.strictEqual(plain, null)
    })

    test('a review fork from an earlier turn does not release a later turn\'s edit', async () => {
      const out = await runGate([
        turnStart('edit it', 'human', 1), assistantLine([editBlock]), assistantLine([forkSpawn('ROLE: REVIEW\nreview it')]),
        turnStart('edit again', 'human', 2), assistantLine([editBlock]),
      ])
      assert.ok(out !== null, 'the review belongs to the earlier turn')
    })

    test('a MEASURE spawn credits only as a fork with no isolation: a lean-worker earns nothing, an isolated fork earns nothing, a plain fork credits', () => {
      const proposal = { type: 'text', text: 'PROPOSAL FOR ACTION - PLEASE REVIEW\nswitch the store to WAL' }
      const measureBy = (block: unknown): number => scanTranscriptLines([assistantLine([proposal]), assistantLine([block])], CWD).roles.measure
      assert.strictEqual(measureBy({ type: 'tool_use', name: 'Agent', input: { subagent_type: 'lean-worker', prompt: 'ROLE: MEASURE\nsettle it' } }), -1)
      assert.strictEqual(measureBy({ type: 'tool_use', name: 'Agent', input: { subagent_type: 'fork', prompt: 'ROLE: MEASURE\nsettle it', isolation: 'worktree' } }), -1)
      assert.strictEqual(measureBy({ type: 'tool_use', name: 'Agent', input: { subagent_type: 'fork', prompt: 'ROLE: MEASURE\nsettle it' } }), 1)
    })

    test('isCreditedFork: a case-folded fork with no isolation credits; any non-empty isolation, or another subagent type, does not', () => {
      assert.strictEqual(isCreditedFork({ subagent_type: 'FORK' }), true)
      assert.strictEqual(isCreditedFork({ subagent_type: ' fork ', isolation: '' }), true)
      assert.strictEqual(isCreditedFork({ subagent_type: 'fork', isolation: 'worktree' }), false)
      assert.strictEqual(isCreditedFork({ subagent_type: 'fork', isolation: false }), false)
      assert.strictEqual(isCreditedFork({ subagent_type: 'lean-worker' }), false)
    })

    test('a worker return enqueued just before a task-notification turn is counted: the main gate blocks on the worker write', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-ret-'))
      try {
        const subagents = path.join(dir, 'main', 'subagents')
        fs.mkdirSync(subagents, { recursive: true })
        fs.writeFileSync(path.join(subagents, 'agent-w.meta.json'), JSON.stringify({ toolUseId: 'toolu_W1', agentType: 'lean-worker' }))
        fs.writeFileSync(path.join(subagents, 'agent-w.jsonl'), assistantLine([editBlock]) + '\n')
        const transcript = path.join(dir, 'main.jsonl')
        const spawnTurn = [turnStart('spawn the worker', 'human', 1), assistantLine([{ type: 'text', text: 'spawned' }])]
        const returnTurn = [turnStart(notification('toolu_W1'), 'human', 2), assistantLine([{ type: 'text', text: 'worker finished' }])]
        fs.writeFileSync(transcript, [...spawnTurn, enqueue('toolu_W1'), ...returnTurn].join('\n') + '\n')
        const out = await runMainGate({ transcript_path: transcript, cwd: CWD })
        assert.ok(out !== null, 'the return belongs to this turn, so its worker write must block')
        assert.ok(reasonOf(out).includes('a worker you spawned wrote files'))
        fs.writeFileSync(transcript, [...spawnTurn, ...returnTurn].join('\n') + '\n')
        assert.strictEqual(await runMainGate({ transcript_path: transcript, cwd: CWD }), null, 'with no enqueue line there is no return to judge')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

  test('readCurrentTurn returns the current turn from its start with the non-conversation run before it, across chunk boundaries and multi-byte text', () => {
    const lines = [
      turnStart('old é—', 'human', 1), assistantLine([editBlock]), enqueue('toolu_X'),
      turnStart('new ✓ prompt', 'human', 2), assistantLine([{ type: 'text', text: 'ok ✓' }]),
    ]
    withFile(lines, (file) => {
      assert.deepStrictEqual(readCurrentTurn(file, { chunkBytes: 16 }), lines.slice(2))
      assert.deepStrictEqual(readCurrentTurn(file), lines.slice(2))
    })
  })

    test('readCurrentTurn reads a file with no turn start whole, and returns null for an unreadable path', () => {
      const sc = (entry: Record<string, unknown>): string => JSON.stringify({ isSidechain: true, agentId: 'w1', ...entry })
      const lines = [sc({ type: 'user', message: { role: 'user', content: 'do it' } }), sc({ type: 'assistant', message: { content: [editBlock] } })]
      withFile(lines, (file) => assert.deepStrictEqual(readCurrentTurn(file), lines))
      assert.strictEqual(readCurrentTurn('/nonexistent/rg-turn/x.jsonl'), null)
    })

    test('a turn longer than 4 MB still shows its first write: no fixed window cuts the turn short', async () => {
      const filler = assistantLine([{ type: 'text', text: 'x'.repeat(1024 * 1024) }])
      const out = await runGate([turnStart('edit it'), assistantLine([editBlock]), filler, filler, filler, filler, filler])
      assert.ok(out !== null, 'the edit lies more than 4 MB before the Stop and must still block')
    })

    test('runSubagentGate: a worker whose only reviewer is an isolated fork is still BLOCKED; a plain fork releases it', async () => {
      const sc = (entry: Record<string, unknown>): string => JSON.stringify({ isSidechain: true, agentId: 'w1', ...entry })
      const userLine = sc({ type: 'user', message: { role: 'user', content: 'do the thing' } })
      const writeLine = sc({ type: 'assistant', message: { content: [bashBlock("fastedit create evals/x.md --force --content 'a'")] } })
      const spawnLine = (input: Record<string, unknown>): string => sc({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input }] } })
      const stopWith = (lines: string[]): Promise<string | null> => withFile(lines, (file) => runSubagentGate({
        hook_event_name: 'SubagentStop', agent_id: 'w1', agent_type: 'general-purpose', agent_transcript_path: file, cwd: CWD,
      }))
      assert.notStrictEqual(await stopWith([userLine, writeLine, spawnLine({ subagent_type: 'fork', isolation: 'worktree', prompt: 'ROLE: REVIEW\nattack it' })]), null)
      assert.strictEqual(await stopWith([userLine, writeLine, spawnLine({ subagent_type: 'fork', prompt: 'ROLE: REVIEW\nattack it' })]), null)
    })


    // Captures what a call writes to stderr (the review gate's own notices), without changing what it returns.
    const captureStderr = async <T>(run: () => Promise<T> | T): Promise<{ result: T; stderr: string }> => {
      const real = process.stderr.write
      let stderr = ''
      process.stderr.write = ((chunk: string | Uint8Array): boolean => { stderr += String(chunk); return true }) as typeof process.stderr.write
      try {
        return { result: await run(), stderr }
      } finally {
        process.stderr.write = real
      }
    }
    const withFileAsync = async <T>(lines: string[], run: (file: string) => Promise<T>): Promise<T> => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-disp-'))
      try {
        const file = path.join(dir, 'agent-f1.jsonl')
        fs.writeFileSync(file, lines.join('\n') + '\n')
        return await run(file)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    const finished = (agent_type: string, last: string, file: string): Promise<string | null> => runSubagentGate({
      hook_event_name: 'SubagentStop', agent_id: 'f1', agent_type, agent_transcript_path: file, last_assistant_message: last, cwd: CWD,
    })

    test('skipUnstartedTurn: the new prompt is already written and unanswered, so the window is the last COMPLETED turn', () => {
      const lines = [turnStart('edit it', 'human', 1), assistantLine([editBlock]), turnStart('next question', 'human', 2)]
      withFile(lines, (file) => {
        assert.deepStrictEqual(readCurrentTurn(file, { skipUnstartedTurn: true }), lines.slice(0, 2))
        assert.deepStrictEqual(readCurrentTurn(file), [lines[2]], 'without the option the unanswered turn is the window')
      })
    })

    test('skipUnstartedTurn: the new prompt is not yet written, so the completed turn is the window either way', () => {
      const lines = [turnStart('edit it', 'human', 1), assistantLine([editBlock])]
      withFile(lines, (file) => assert.deepStrictEqual(readCurrentTurn(file, { skipUnstartedTurn: true }), lines))
    })

    test('skipUnstartedTurn: a worker return enqueued before the unanswered turn belongs to that turn, not the completed one', () => {
      const lines = [turnStart('edit it', 'human', 1), assistantLine([editBlock]), enqueue('toolu_Y'), turnStart('next', 'human', 2)]
      withFile(lines, (file) => assert.deepStrictEqual(readCurrentTurn(file, { skipUnstartedTurn: true }), lines.slice(0, 2)))
    })

    test('skipUnstartedTurn: a first turn with no answer yet has no completed turn to judge', () => {
      withFile([turnStart('first question', 'human', 1)], (file) => assert.deepStrictEqual(readCurrentTurn(file, { skipUnstartedTurn: true }), []))
    })

    test('a main transcript with no turn start is judged whole and the stderr names it; a subagent transcript with none prints nothing', async () => {
      const lines = [userStringLine('no turn start here'), assistantLine([editBlock])]
      await withFileAsync(lines, async (file) => {
        const main = await captureStderr(() => readCurrentTurn(file, { warnNoTurnStart: true }))
        assert.deepStrictEqual(main.result, lines)
        assert.ok(main.stderr.includes(`no turn start found in ${file}; judging the whole transcript`), main.stderr)
        const sub = await captureStderr(() => readCurrentTurn(file))
        assert.deepStrictEqual(sub.result, lines)
        assert.strictEqual(sub.stderr, '')
      })
    })

  test('a finished review fork shows its report to the USER as systemMessage, exactly as written', async () => {
    const report = `${REVIEW_HEADING}\n\nFinding 1: the reader drops the last line when the file ends without a newline.`
    const out = await withFileAsync([userStringLine('review the change')], (file) => finished('fork', report, file))
    assert.deepStrictEqual(JSON.parse(out as string), { systemMessage: report })
  })

  test('the review heading may follow # and spaces, and a MEASURE report is shown the same way', async () => {
    const report = `  ## * ${MEASURE_HEADING}   \nASSUMPTION 1: the file exists\nCOMMAND: ls\nOBSERVED: yes\nVERDICT: confirmed`
    const out = await withFileAsync([userStringLine('measure it')], (file) => finished('fork', report, file))
    assert.deepStrictEqual(JSON.parse(out as string), { systemMessage: report })
  })

  test('an agent whose last message is not a report shows nothing, and the retired review and measure headings no longer trigger the display', async () => {
    const plain = await withFileAsync([userStringLine('rename it')], (file) => finished('general-purpose', 'Renamed the file.', file))
    assert.strictEqual(plain, null)
    for (const retired of ['ADVERSARIAL-REVIEW\nlooked at it', 'MEASURE-AND-VERIFY-REPORT\nVERDICT: confirmed']) {
      const out = await withFileAsync([userStringLine('rename it')], (file) => finished('general-purpose', retired, file))
      assert.strictEqual(out, null, retired)
    }
  })

  test('an agent the gate blocks gets the block decision and no systemMessage', async () => {
    const out = await withFileAsync([userStringLine('edit it'), assistantLine([bashBlock("fastedit create evals/x.md --force --content 'a'")])],
      (file) => finished('general-purpose', `${REVIEW_HEADING}\nlooked at it`, file))
    const parsed = JSON.parse(out as string) as Record<string, unknown>
    assert.strictEqual(parsed.decision, 'block')
    assert.strictEqual('systemMessage' in parsed, false)
  })

  test('a review longer than the display cap is cut to exactly the cap and names the full transcript', async () => {
    const report = `${REVIEW_HEADING}\n` + 'x'.repeat(12000)
    await withFileAsync([userStringLine('review the change')], async (file) => {
      const message = (JSON.parse(await finished('fork', report, file) as string) as { systemMessage: string }).systemMessage
      assert.strictEqual(message.length, 9500)
      assert.ok(message.startsWith(`${REVIEW_HEADING}\n`))
      assert.ok(message.endsWith(`… (truncated; full text: ${file})`), message.slice(-120))
    })
  })

  test('a review of exactly the cap is shown whole', async () => {
    const report = `${REVIEW_HEADING}\n` + 'x'.repeat(9500 - `${REVIEW_HEADING}\n`.length)
    const out = await withFileAsync([userStringLine('review the change')], (file) => finished('fork', report, file))
    assert.deepStrictEqual(JSON.parse(out as string), { systemMessage: report })
  })

  test('a long review with no transcript path says so on stderr and shows nothing', async () => {
    const report = `${REVIEW_HEADING}\n` + 'x'.repeat(12000)
    const { result, stderr } = await captureStderr(() => runSubagentGate({
      hook_event_name: 'SubagentStop', agent_id: 'f1', agent_type: 'fork', last_assistant_message: report, cwd: CWD,
    }))
    assert.strictEqual(result, null)
    assert.ok(stderr.includes('review display skipped'), stderr)
  })


  test('a marker quoted mid-line or on a later line does not trigger the display', async () => {
    const quoted = [
      `Summary first.\n${REVIEW_HEADING}\nis below`,
      `I will open with ${REVIEW_HEADING} once the check passes`,
      `The verdict follows the ${REVIEW_HEADING} marker`,
    ]
    for (const last of quoted) {
      const out = await withFileAsync([userStringLine('review it')], (file) => finished('general-purpose', last, file))
      assert.strictEqual(out, null, last)
    }
  })


  test('a marker decorated with **, backticks or same-line text still displays; a marker run into a word does not', async () => {
    const decorated = [
      `**${REVIEW_HEADING}**\nFinding 1: the reader drops the last line.`,
      `\`${REVIEW_HEADING}\`\nFinding 1: the reader drops the last line.`,
      `${REVIEW_HEADING} notes on the first pass\nFinding 1: the reader drops the last line.`,
    ]
    for (const report of decorated) {
      const out = await withFileAsync([userStringLine('review the change')], (file) => finished('fork', report, file))
      assert.deepStrictEqual(JSON.parse(out as string), { systemMessage: report }, report)
    }
    const glued = `${REVIEW_HEADING}notes`
    const none = await withFileAsync([userStringLine('review it')], (file) => finished('general-purpose', glued, file))
    assert.strictEqual(none, null)
  })


  test('a marker followed by a colon or by decorated text still displays; one followed by a letter, digit, underscore or hyphen does not', async () => {
    const opening = [
      `**${REVIEW_HEADING}** Task: review the change\nFinding 1: the reader drops the last line.`,
      `\`${REVIEW_HEADING}\` the change\nFinding 1: the reader drops the last line.`,
      `${REVIEW_HEADING}: review of the change\nFinding 1: the reader drops the last line.`,
    ]
    for (const report of opening) {
      const out = await withFileAsync([userStringLine('review the change')], (file) => finished('fork', report, file))
      assert.deepStrictEqual(JSON.parse(out as string), { systemMessage: report }, report)
    }
    for (const glued of [`${REVIEW_HEADING}X`, `${REVIEW_HEADING}7`, `${REVIEW_HEADING}_x`, `${REVIEW_HEADING}-x`]) {
      const out = await withFileAsync([userStringLine('review it')], (file) => finished('general-purpose', glued, file))
      assert.strictEqual(out, null, glued)
    }
  })

  })

})
