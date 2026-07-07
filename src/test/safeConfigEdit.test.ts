import * as assert from 'assert'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Real tests against the REAL editor: every case spawns python3 on the actual
// scripts/safe_config_edit.py with real files in a temp dir. No mocks — the
// whole point of this suite is proving the on-disk transaction semantics that
// the 2026-07-07 settings.json wipe violated.

const EDITOR = path.resolve(__dirname, '..', '..', '..', 'scripts', 'safe_config_edit.py')

interface RunOutcome {
  status: number
  stdout: string
  stderr: string
}

function runEditor(file: string, spec: unknown, extraArgs: string[] = []): RunOutcome {
  try {
    const stdout = execFileSync(
      'python3',
      [EDITOR, '--file', file, ...extraArgs],
      { input: JSON.stringify(spec), encoding: 'utf-8' }
    )
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

// A settings.json-shaped fixture rich enough that key loss is detectable:
// top-level scalars, nested objects, arrays, and an env block.
function richFixture(): Record<string, unknown> {
  return {
    statusLine: { type: 'command', command: 'python3 ~/.claude/statusline.py' },
    permissions: { allow: ['Bash(ls:*)', 'Bash(git status:*)'], deny: [] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    },
    enabledPlugins: { 'some-marketplace': ['plugin-a', 'plugin-b'] },
    theme: 'dark',
    env: { EXISTING_KEY: 'user-value', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:14318' },
    model: 'claude-fable-5',
  }
}

suite('safe_config_edit.py — transactional config editor', () => {
  let dir: string
  let file: string

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeedit-'))
    file = path.join(dir, 'settings.json')
  })

  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('REFUSES an existing-but-corrupt file and leaves it byte-identical (the wipe scenario)', () => {
    const corrupt = '{ "statusLine": { "type": "command"  BROKEN'
    fs.writeFileSync(file, corrupt)
    const r = runEditor(file, { ops: [{ op: 'set', path: ['env', 'X'], value: '1' }] })
    assert.strictEqual(r.status, 2, `expected refusal exit 2, got ${r.status}: ${r.stderr}`)
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), corrupt, 'corrupt file must remain untouched')
    assert.match(r.stderr, /REFUSING/)
  })

  test('REFUSES JSONC (comments — the VS Code settings hazard) without writing', () => {
    const jsonc = '{\n  // user comment\n  "theme": "dark"\n}\n'
    fs.writeFileSync(file, jsonc)
    const r = runEditor(file, { ops: [{ op: 'set', path: ['env', 'X'], value: '1' }] })
    assert.strictEqual(r.status, 2)
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), jsonc)
  })

  test('REFUSES a missing file unless --create-if-missing', () => {
    const r = runEditor(file, { ops: [{ op: 'set', path: ['env', 'X'], value: '1' }] })
    assert.strictEqual(r.status, 2)
    assert.ok(!fs.existsSync(file))
  })

  test('creates a fresh file with --create-if-missing containing exactly the ops', () => {
    const r = runEditor(
      file,
      { ops: [{ op: 'set', path: ['env', 'A'], value: '1' }] },
      ['--create-if-missing']
    )
    assert.strictEqual(r.status, 0, r.stderr)
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { env: { A: '1' } })
  })

  test('merges ONLY the declared op paths and preserves every other key (nothing-lost guarantee)', () => {
    const original = richFixture()
    fs.writeFileSync(file, JSON.stringify(original, null, 2))
    const r = runEditor(file, {
      ops: [
        { op: 'set', path: ['env', 'OTEL_EXPORTER_OTLP_ENDPOINT'], value: 'http://localhost:4318' },
        { op: 'set', path: ['env', 'NEW_KEY'], value: 'added' },
        { op: 'delete', path: ['env', 'EXISTING_KEY'] },
      ],
    })
    assert.strictEqual(r.status, 0, r.stderr)
    const after = JSON.parse(fs.readFileSync(file, 'utf-8')) as ReturnType<typeof richFixture>
    // Intended changes applied:
    assert.deepStrictEqual(after.env, {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      NEW_KEY: 'added',
    })
    // Everything else byte-for-byte preserved:
    const { env: _e1, ...restBefore } = original
    const { env: _e2, ...restAfter } = after
    assert.deepStrictEqual(restAfter, restBefore)
    // Backup exists and holds the ORIGINAL content:
    const result = JSON.parse(r.stdout) as { changed: boolean; backupPath: string }
    assert.strictEqual(result.changed, true)
    assert.ok(result.backupPath && fs.existsSync(result.backupPath))
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(result.backupPath, 'utf-8')), original)
  })

  test('append_unique adds the Stop hook once and is idempotent on re-run', () => {
    fs.writeFileSync(file, JSON.stringify(richFixture(), null, 2))
    const hookOp = {
      op: 'append_unique',
      path: ['hooks', 'Stop'],
      value: { matcher: '', hooks: [{ type: 'command', command: 'f=$HOME/.agentlens/pending-prompt.txt; [ -f "$f" ] && cat "$f" && rm "$f"' }] },
      unique_by_substring: '.agentlens/pending-prompt.txt',
    }
    const r1 = runEditor(file, { ops: [hookOp] })
    assert.strictEqual(r1.status, 0, r1.stderr)
    assert.strictEqual((JSON.parse(r1.stdout) as { changed: boolean }).changed, true)
    const afterOnce = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      hooks: { Stop: unknown[]; PreToolUse: unknown[] }
    }
    assert.strictEqual(afterOnce.hooks.Stop.length, 1)
    assert.strictEqual(afterOnce.hooks.PreToolUse.length, 1, 'sibling hooks preserved')

    const r2 = runEditor(file, { ops: [hookOp] })
    assert.strictEqual(r2.status, 0, r2.stderr)
    assert.strictEqual((JSON.parse(r2.stdout) as { changed: boolean }).changed, false, 'second run is a no-op')
  })

  test('no-op spec (values already in place) changes nothing and writes no backup', () => {
    const original = richFixture()
    fs.writeFileSync(file, JSON.stringify(original, null, 2))
    const before = fs.readFileSync(file, 'utf-8')
    const r = runEditor(file, {
      ops: [{ op: 'set', path: ['env', 'EXISTING_KEY'], value: 'user-value' }],
    })
    assert.strictEqual(r.status, 0, r.stderr)
    assert.strictEqual((JSON.parse(r.stdout) as { changed: boolean }).changed, false)
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), before)
    assert.strictEqual(fs.readdirSync(dir).length, 1, 'no backup/tmp litter on no-op')
  })

  test('refuses to overwrite a non-object in the path (env is a string)', () => {
    fs.writeFileSync(file, JSON.stringify({ env: 'not-an-object', theme: 'dark' }, null, 2))
    const r = runEditor(file, { ops: [{ op: 'set', path: ['env', 'X'], value: '1' }] })
    assert.strictEqual(r.status, 2, r.stderr)
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { env: 'not-an-object', theme: 'dark' })
  })

  test('rejects a bad spec (unknown op) without touching the file', () => {
    fs.writeFileSync(file, JSON.stringify(richFixture(), null, 2))
    const before = fs.readFileSync(file, 'utf-8')
    const r = runEditor(file, { ops: [{ op: 'obliterate', path: ['env'] }] })
    assert.strictEqual(r.status, 6)
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), before)
  })

  test('TOML mode: ensure_line_in_section updates [otel] and preserves other sections', function () {
    // tomllib needs python ≥3.11; skip (visibly) on older interpreters.
    const ver = execFileSync('python3', ['-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf-8' }).trim()
    if (ver !== 'True') { this.skip() }
    const toml = path.join(dir, 'config.toml')
    fs.writeFileSync(toml, '[profile]\nname = "user"\n\n[otel]\nexporter = { otlp-http = { endpoint = "http://localhost:14318", protocol = "json" } }\n')
    const r = runEditor(toml, {
      ops: [{
        op: 'ensure_line_in_section',
        section: 'otel',
        key_prefix: 'exporter',
        line: 'exporter = { otlp-http = { endpoint = "http://localhost:4318", protocol = "json" } }',
      }],
    }, ['--format', 'toml'])
    assert.strictEqual(r.status, 0, r.stderr)
    const after = fs.readFileSync(toml, 'utf-8')
    assert.match(after, /localhost:4318/)
    assert.match(after, /\[profile\]\nname = "user"/, 'unrelated section preserved verbatim')
  })

  test('corrupt TOML is refused untouched', function () {
    const ver = execFileSync('python3', ['-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf-8' }).trim()
    if (ver !== 'True') { this.skip() }
    const toml = path.join(dir, 'config.toml')
    const corrupt = '[otel\nexporter = broken'
    fs.writeFileSync(toml, corrupt)
    const r = runEditor(toml, {
      ops: [{ op: 'ensure_line_in_section', section: 'otel', key_prefix: 'exporter', line: 'exporter = 1' }],
    }, ['--format', 'toml'])
    assert.strictEqual(r.status, 2)
    assert.strictEqual(fs.readFileSync(toml, 'utf-8'), corrupt)
  })
})
