import * as assert from 'assert'
import { spawn, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { safeConfigEdit, SafeEditOp } from '../safeConfigEdit'
import { ensureTelemetryConfig, removeTelemetryConfig, type TelemetryConfigOptions } from '../telemetryConfig'
import { installHooks } from '../cli/hookInstall'

// Adversarial safety suite for every ~/.claude/settings.json write (owner order 2026-10-02: "edit
// settings.json in a SUPER SAFE WAY"). Real files in a temp dir, the real scripts/safe_config_edit.py,
// no mocks. The real ~/.claude/settings.json is never touched: every path is explicit.

const EDITOR = path.resolve(__dirname, '..', '..', '..', 'scripts', 'safe_config_edit.py')
const BACKUP_RE = /\.agentlens-bak-/

interface Run { status: number | null; stdout: string; stderr: string }
function runPy(file: string, ops: unknown[], extra: string[] = [], shellPrefix = ''): Run {
  const args = [EDITOR, '--file', file, '--format', 'json', ...extra]
  const r = shellPrefix
    ? spawnSync('sh', ['-c', `${shellPrefix}; exec python3 "$@"`, 'sh', ...args], { input: JSON.stringify({ ops }), encoding: 'utf-8' })
    : spawnSync('python3', args, { input: JSON.stringify({ ops }), encoding: 'utf-8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

function userObject(): Record<string, unknown> {
  return {
    model: 'opus',
    permissions: { allow: ['Bash(git:*)', 'Read(~/x)'], deny: [], defaultMode: 'acceptEdits' },
    env: { FOO: 'bar', UNI: 'héllo ☃ 😀 \\ " /' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook.sh', timeout: 5 }] }],
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'user-stop.sh' }] }],
    },
    statusLine: { type: 'command', command: 'my-line', padding: 0 },
    nested: { a: { b: { c: [1, 2.5, { d: null, e: true }] } } },
    big: 777777777,
  }
}
function userText(indent: number | string = 2, eol = '\n', trailing = true): string {
  const t = JSON.stringify(userObject(), null, indent).replace('777777777', '12345678901234567890')
  return (eol === '\n' ? t : t.replace(/\n/g, eol)) + (trailing ? eol : '')
}
function parse(file: string): Record<string, unknown> { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> }
const siblings = (dir: string): string[] => fs.readdirSync(dir).sort()
const backups = (dir: string): string[] => siblings(dir).filter(f => BACKUP_RE.test(f))

/** Every top-level key of `before` not in `touched` must be deep-equal after, and keep its relative order. */
function assertUntouched(before: Record<string, unknown>, after: Record<string, unknown>, touched: string[] = []): void {
  for (const k of Object.keys(before)) if (!touched.includes(k)) assert.deepStrictEqual(after[k], before[k], `top-level key ${k} changed`)
  const order = Object.keys(after).filter(k => k in before)
  assert.deepStrictEqual(order, Object.keys(before), 'top-level key order changed')
}

suite('settingsSafety — safe_config_edit.py against hostile real-world settings.json', function () {
  this.timeout(300_000)
  let dir: string
  let file: string

  setup(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-settings-safety-')))
    file = path.join(dir, 'settings.json')
  })
  teardown(() => {
    try { fs.chmodSync(dir, 0o755) } catch { /* removed */ }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // (a) --------------------------------------------------------------------------------------------
  test('(a) a settings.json SYMLINK (dotfiles manager) stays a symlink and the TARGET carries the edit', async () => {
    fs.mkdirSync(path.join(dir, 'dotfiles'))
    fs.mkdirSync(path.join(dir, '.claude'))
    const target = path.join(dir, 'dotfiles', 'settings.json')
    const link = path.join(dir, '.claude', 'settings.json')
    fs.writeFileSync(target, userText())
    fs.symlinkSync('../dotfiles/settings.json', link)
    const res = await safeConfigEdit(link, 'json', [{ op: 'set', path: ['env', 'NEW'], value: '1' }])
    assert.strictEqual(res.changed, true)
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink was replaced by a regular file')
    assert.strictEqual(fs.readlinkSync(link), '../dotfiles/settings.json')
    assert.strictEqual((parse(target).env as Record<string, string>).NEW, '1', 'the symlink TARGET did not receive the edit')
    assert.deepStrictEqual(siblings(path.join(dir, '.claude')), ['settings.json'], 'sidecars leaked next to the link')
  })

  // (b) --------------------------------------------------------------------------------------------
  test('(b) file permission bits survive an edit (0644, 0640, 0600)', async () => {
    for (const mode of [0o644, 0o640, 0o600]) {
      fs.writeFileSync(file, userText())
      fs.chmodSync(file, mode)
      await safeConfigEdit(file, 'json', [{ op: 'set', path: ['env', 'M'], value: String(mode) }])
      assert.strictEqual(fs.statSync(file).mode & 0o777, mode, `mode ${mode.toString(8)} not preserved`)
    }
  })

  // (c) --------------------------------------------------------------------------------------------
  test('(c) unparseable / empty / truncated / non-object / JSONC / BOM files are REFUSED: unchanged, no backup, no sidecar', () => {
    const decoy = path.join(dir, 'settings.json.agentlens-bak-00000000_000000000')
    const decoyBody = 'PRE-EXISTING BACKUP — must never be clobbered'
    fs.writeFileSync(decoy, decoyBody)
    const cases: Array<[string, string]> = [
      ['empty', ''], ['whitespace only', '  \n'], ['truncated mid-object', userText().slice(0, 120)],
      ['truncated mid-string', '{"env": {"FOO": "ba'], ['trailing garbage', '{"a":1}}'], ['top-level array', '[]'], ['null', 'null'],
      ['JSONC comment', '// my note\n{"a":1}'], ['trailing comma', '{"a":1,}'], ['UTF-8 BOM', '﻿{"a":1}'],
    ]
    for (const [name, body] of cases) {
      fs.writeFileSync(file, body)
      const before = siblings(dir)
      const r = runPy(file, [{ op: 'set', path: ['env', 'X'], value: '1' }])
      assert.strictEqual(r.status, 2, `${name}: expected refuse (exit 2), got ${r.status}: ${r.stderr}`)
      assert.strictEqual(fs.readFileSync(file, 'utf8'), body, `${name}: file changed`)
      assert.deepStrictEqual(siblings(dir), before, `${name}: sidecar/backup/tmp created`)
    }
    assert.strictEqual(fs.readFileSync(decoy, 'utf8'), decoyBody)
  })

  test('(c) invalid UTF-8 bytes: non-zero exit, file byte-identical, nothing written', () => {
    const bytes = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')])
    fs.writeFileSync(file, bytes)
    const r = runPy(file, [{ op: 'set', path: ['env', 'X'], value: '1' }])
    assert.notStrictEqual(r.status, 0)
    assert.ok(fs.readFileSync(file).equals(bytes))
    assert.deepStrictEqual(siblings(dir), ['settings.json'])
  })

  test('(c) missing file without --create-if-missing is refused and not created', () => {
    const r = runPy(file, [{ op: 'set', path: ['env', 'X'], value: '1' }])
    assert.strictEqual(r.status, 2)
    assert.deepStrictEqual(siblings(dir), [])
  })

  // (d) --------------------------------------------------------------------------------------------
  test('(d) 2-space LF file: result is byte-identical to the original plus ONLY the added key', async () => {
    fs.writeFileSync(file, userText().replace('12345678901234567890', '777777777'))
    await safeConfigEdit(file, 'json', [{ op: 'set', path: ['env', 'NEW'], value: '1' }])
    const expected = userObject()
    ;(expected.env as Record<string, string>).NEW = '1'
    assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify(expected, null, 2) + '\n')
  })

  test('(d) 4-space indent: values + key order preserved; indent is NORMALISED to 2 spaces (documented non-preservation)', async () => {
    fs.writeFileSync(file, userText(4))
    const before = parse(file)
    await safeConfigEdit(file, 'json', [{ op: 'set', path: ['env', 'NEW'], value: '1' }])
    assertUntouched(before, parse(file), ['env'])
    const out = fs.readFileSync(file, 'utf8')
    assert.ok(out.includes('\n  "model"') && !out.includes('\n    "model"'), 'expected 2-space layout')
    assert.ok(out.includes('12345678901234567890'), 'big integer lost precision')
    assert.ok(out.includes('héllo ☃ 😀'), 'non-ASCII was escaped/mangled')
    assert.ok(out.endsWith('}\n'))
  })

  test('(d) CRLF file: the BACKUP is byte-exact and values survive (output layout becomes LF)', async () => {
    const orig = Buffer.from(userText(2, '\r\n'))
    fs.writeFileSync(file, orig)
    const before = parse(file)
    const res = await safeConfigEdit(file, 'json', [{ op: 'set', path: ['env', 'NEW'], value: '1' }])
    assert.ok(res.backupPath, 'no backup reported')
    assert.ok(fs.readFileSync(res.backupPath as string).equals(orig), 'backup is not a byte-exact copy of the original')
    assertUntouched(before, parse(file), ['env'])
  })

  test('(d) no trailing newline in the original: result always ends with one (documented)', async () => {
    fs.writeFileSync(file, userText(2, '\n', false))
    await safeConfigEdit(file, 'json', [{ op: 'set', path: ['env', 'NEW'], value: '1' }])
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'))
  })

  // (e) --------------------------------------------------------------------------------------------
  test('(e) 8 parallel editors, 8 different ops: valid JSON, all 8 changes present, user content intact, no leftovers', async () => {
    fs.writeFileSync(file, userText())
    const before = parse(file)
    const ops: SafeEditOp[] = [
      { op: 'set', path: ['env', 'P0'], value: '0' }, { op: 'set', path: ['env', 'P1'], value: '1' },
      { op: 'set', path: ['env', 'P2'], value: '2' }, { op: 'set', path: ['p3', 'deep'], value: 3 },
      { op: 'append_unique', path: ['hooks', 'Stop'], value: { matcher: '', hooks: [{ type: 'command', command: 'ours-A' }] }, unique_by_substring: 'ours-A' },
      { op: 'append_unique', path: ['hooks', 'Stop'], value: { matcher: '', hooks: [{ type: 'command', command: 'ours-B' }] }, unique_by_substring: 'ours-B' },
      { op: 'append_unique', path: ['hooks', 'SessionStart'], value: { hooks: [{ type: 'command', command: 'ours-C' }] }, unique_by_substring: 'ours-C' },
      { op: 'set', path: ['p7'], value: 'seven' },
    ]
    await Promise.all(ops.map(op => safeConfigEdit(file, 'json', [op])))
    const after = parse(file)
    const env = after.env as Record<string, string>
    assert.deepStrictEqual([env.P0, env.P1, env.P2], ['0', '1', '2'])
    assert.strictEqual((after.p3 as { deep: number }).deep, 3)
    assert.strictEqual(after.p7, 'seven')
    const stop = JSON.stringify((after.hooks as Record<string, unknown>).Stop)
    assert.ok(stop.includes('ours-A') && stop.includes('ours-B') && stop.includes('user-stop.sh'))
    assert.ok(JSON.stringify((after.hooks as Record<string, unknown>).SessionStart).includes('ours-C'))
    assert.deepStrictEqual(after.permissions, before.permissions)
    assert.deepStrictEqual(after.nested, before.nested)
    assert.deepStrictEqual(siblings(dir).filter(f => !BACKUP_RE.test(f) && f !== 'settings.json'), [], 'lock/tmp leaked')
  })

  // (f) --------------------------------------------------------------------------------------------
  test('(f) a lock-less FOREIGN writer (Claude Code, read-modify-write + rename) racing 50 edits: never invalid JSON; losses quantified', async () => {
    const foreign = path.join(dir, 'foreign.js')
    fs.writeFileSync(foreign, [
      "const fs=require('fs');const f=process.argv[2];const n=+process.argv[3];",
      'for(let i=0;i<n;i++){const o=JSON.parse(fs.readFileSync(f,"utf8"));o.foreign=o.foreign||{};o.foreign["F"+i]=i;',
      'const t=f+".foreign.tmp";fs.writeFileSync(t,JSON.stringify(o,null,2)+"\\n");fs.renameSync(t,f)}',
    ].join('\n'))
    const N_FOREIGN = 400
    const stats = { rounds: 50, oursApplied: 0, oursCancelled: 0, oursCommittedThenOverwritten: 0, foreignKeysDropped: 0, roundsWithForeignLoss: 0, invalidJson: 0 }
    for (let round = 0; round < stats.rounds; round++) {
      fs.writeFileSync(file, userText())
      const fp = spawn('node', [foreign, file, String(N_FOREIGN)], { stdio: 'ignore' })
      const foreignDone = new Promise<void>(res => fp.on('close', () => res()))
      let ok = true
      try { await safeConfigEdit(file, 'json', [{ op: 'set', path: ['ours', `r${round}`], value: round }]) } catch { ok = false }
      await foreignDone
      let final: Record<string, unknown>
      try { final = parse(file) } catch { stats.invalidJson++; continue }
      const f = (final.foreign ?? {}) as Record<string, number>
      const missing = N_FOREIGN - Object.keys(f).length
      if (missing > 0) { stats.foreignKeysDropped += missing; stats.roundsWithForeignLoss++ }
      const present = ((final.ours ?? {}) as Record<string, number>)[`r${round}`] === round
      if (!ok) stats.oursCancelled++
      else if (present) stats.oursApplied++
      else stats.oursCommittedThenOverwritten++
      assert.deepStrictEqual(final.permissions, userObject().permissions, 'user content damaged')
    }
    console.log(`      (f) race stats: ${JSON.stringify(stats)}`)
    assert.strictEqual(stats.invalidJson, 0, 'a racing foreign writer produced an invalid settings.json')
    for (const f of fs.readdirSync(dir)) assert.ok(!/\.safeedit\.tmp$|agentlens-lock$/.test(f), `leftover ${f}`)
  })

  // (g) --------------------------------------------------------------------------------------------
  test('(g) idempotence: the same converge twice → the second run writes nothing (mtime, inode, size, backups unchanged)', async () => {
    fs.writeFileSync(file, userText())
    const ops: SafeEditOp[] = [
      { op: 'set', path: ['env', 'OTEL_X'], value: 'v' },
      { op: 'append_unique', path: ['hooks', 'Stop'], value: { matcher: '', hooks: [{ type: 'command', command: 'ours' }] }, unique_by_substring: 'ours' },
      { op: 'remove_by_substring', path: ['hooks', 'Gone'], substring: 'nothing', nested_key: 'hooks', prune_empty: true },
    ]
    assert.strictEqual((await safeConfigEdit(file, 'json', ops)).changed, true)
    const s1 = fs.statSync(file); const dir1 = siblings(dir)
    await new Promise(r => setTimeout(r, 30))
    const second = await safeConfigEdit(file, 'json', ops)
    const s2 = fs.statSync(file)
    assert.strictEqual(second.changed, false)
    assert.strictEqual(second.backupPath, null)
    assert.strictEqual(s2.mtimeMs, s1.mtimeMs); assert.strictEqual(s2.ino, s1.ino); assert.strictEqual(s2.size, s1.size)
    assert.deepStrictEqual(siblings(dir), dir1)
  })

  // (h) --------------------------------------------------------------------------------------------
  test('(h) backup growth: 30 real repairs leave EXACTLY 2 backups, beside settings.json', async () => {
    fs.writeFileSync(file, userText())
    for (let i = 0; i < 30; i++) await safeConfigEdit(file, 'json', [{ op: 'set', path: ['env', 'COUNTER'], value: String(i) }])
    const n = backups(dir).length
    console.log(`      (h) backups after 30 repairs: ${n} (in ${dir}, beside settings.json)`)
    assert.strictEqual(n, 2, `${n} backups on disk; the owner's ruling is exactly 2`)
  })


  // Owner order 2026-10-02 (copy → validate → edit → re-validate → compare old vs current → atomic swap; on a
  // change redo the WHOLE cycle; two backups). Fault injection runs the REAL transact_json inside a python
  // wrapper that lands a genuine foreign write (read-modify-write + rename, no lock) at one exact point.
  const wrapper = (): string => {
    const w = path.join(dir, 'inject.py')
    fs.writeFileSync(w, [
      'import sys, os, json',
      `sys.path.insert(0, ${JSON.stringify(path.dirname(EDITOR))})`,
      'import safe_config_edit as m',
      'MODE = os.environ["SS_MODE"]; LIMIT = int(os.environ.get("SS_LIMIT", "1")); FILE = os.environ["SS_FILE"]',
      'calls = {"n": 0}',
      'def foreign():',
      '    with open(FILE) as f: o = json.load(f)',
      '    o.setdefault("foreign", {})["F%d" % (calls["n"] - 1)] = calls["n"] - 1',
      '    t = FILE + ".foreign.tmp"',
      '    with open(t, "w") as f: json.dump(o, f, indent=2); f.write("\\n")',
      '    os.replace(t, FILE)',
      'if MODE == "snapshot":',
      '    orig = m.atomic_backup',
      '    def hooked(target, raw):',
      '        r = orig(target, raw)',
      '        if calls["n"] < LIMIT: calls["n"] += 1; foreign()',
      '        return r',
      '    m.atomic_backup = hooked',
      'elif MODE == "prereplace":',
      '    real = os.replace',
      '    def rep(src, dst):',
      '        if dst == FILE and src.endswith(".safeedit.tmp") and calls["n"] < LIMIT: calls["n"] += 1; foreign()',
      '        return real(src, dst)',
      '    os.replace = rep',
      'elif MODE == "postcommit":',
      '    real = os.replace',
      '    def rep(src, dst):',
      '        real(src, dst)',
      '        if dst == FILE and src.endswith(".safeedit.tmp") and calls["n"] < LIMIT: calls["n"] += 1; foreign()',
      '    os.replace = rep',
      'elif MODE == "audit_fail":',
      '    real_verify = m.verify_diff',
      '    def v(*a):',
      '        calls["n"] += 1',
      '        if calls["n"] == 3: raise m.VerifyFailed("injected post-commit audit failure")',
      '        return real_verify(*a)',
      '    m.verify_diff = v',
      'sys.argv = ["safe_config_edit.py", "--file", FILE, "--format", "json", "--retries", "3"]',
      'm.main()',
    ].join('\n'))
    return w
  }
  const runInjected = (mode: string, ops: unknown[], limit = 1): Run => {
    const r = spawnSync('python3', [wrapper()], { input: JSON.stringify({ ops }), encoding: 'utf-8', env: { ...process.env, SS_MODE: mode, SS_LIMIT: String(limit), SS_FILE: file } })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }
  const OURS = [{ op: 'set', path: ['ours', 'k'], value: 'v' }]

  test('(1) a foreign write between snapshot and the compare → the WHOLE cycle is redone from a fresh snapshot; the foreign change survives', () => {
    fs.writeFileSync(file, userText())
    const r = runInjected('snapshot', OURS, 1)
    assert.strictEqual(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout) as { changed: boolean; attempts: number }
    assert.strictEqual(out.changed, true)
    assert.strictEqual(out.attempts, 2, 'the cycle was not redone')
    const final = parse(file)
    assert.deepStrictEqual(final.foreign, { F0: 0 }, 'the foreign write was lost')
    assert.deepStrictEqual(final.ours, { k: 'v' })
    assert.deepStrictEqual(final.permissions, userObject().permissions)
  })

  test('(2) continuous foreign churn exhausts the retry budget → the transaction CANCELS (exit 5) and our edit is never written', () => {
    fs.writeFileSync(file, userText())
    const r = runInjected('snapshot', OURS, 99)
    assert.strictEqual(r.status, 5, r.stderr)
    assert.ok(/cancelled after 3 attempts/.test(r.stderr), r.stderr)
    const final = parse(file)
    assert.ok(!('ours' in final), 'a cancelled transaction still wrote')
    assert.deepStrictEqual(final.foreign, { F0: 0, F1: 1, F2: 2 }, 'the file is not exactly the foreign writer\'s last state')
    assert.deepStrictEqual(final.permissions, userObject().permissions)
    assert.deepStrictEqual(siblings(dir).filter(f => /\.safeedit\.tmp$|agentlens-lock$/.test(f)), [], 'tmp/lock leaked')
  })

  test('(3) RESIDUAL WINDOW (documents an inherent limit): a foreign write landing after the last check and before os.replace IS overwritten', () => {
    fs.writeFileSync(file, userText())
    const r = runInjected('prereplace', OURS, 1)
    assert.strictEqual(r.status, 0, r.stderr)
    const final = parse(file)
    assert.deepStrictEqual(final.ours, { k: 'v' })
    assert.ok(!('foreign' in final), 'the window closed: update the report, this limit no longer holds')
  })

  test('(5) a foreign write landing right AFTER our commit is never rolled back over: the cycle is redone and BOTH changes survive', () => {
    fs.writeFileSync(file, userText())
    const r = runInjected('postcommit', OURS, 1)
    assert.strictEqual(r.status, 0, r.stderr)
    assert.strictEqual((JSON.parse(r.stdout) as { attempts: number }).attempts, 2)
    const final = parse(file)
    assert.deepStrictEqual(final.foreign, { F0: 0 }, 'the rollback clobbered the foreign write with a stale pre-image')
    assert.deepStrictEqual(final.ours, { k: 'v' })
  })

  test('(4) BACKUPS = TWO: 10 real edits leave exactly 2; the newest is the pre-image of the last edit; a rolled-back edit prunes nothing and later edits still converge on 2', () => {
    fs.writeFileSync(file, userText())
    const edit = (i: number): Run => runPy(file, [{ op: 'set', path: ['env', 'N'], value: String(i) }])
    let preImage = Buffer.alloc(0)
    for (let i = 1; i <= 10; i++) {
      if (i === 6) {
        const before = fs.readFileSync(file); const bk = backups(dir)
        const r = runInjected('audit_fail', [{ op: 'set', path: ['env', 'N'], value: 'bad' }])
        assert.strictEqual(r.status, 3, r.stderr)
        assert.ok(fs.readFileSync(file).equals(before), 'rollback did not restore the pre-image')
        assert.deepStrictEqual(backups(dir), bk, 'a FAILED transaction pruned or leaked backups')
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600 | (fs.statSync(file).mode & 0o077))
      }
      preImage = fs.readFileSync(file)
      assert.strictEqual(edit(i).status, 0)
      assert.ok(backups(dir).length <= 2)
    }
    const kept = backups(dir)
    assert.strictEqual(kept.length, 2)
    assert.ok(fs.readFileSync(path.join(dir, kept[1])).equals(preImage), 'newest backup is not the pre-image of the last edit')
    assert.strictEqual((JSON.parse(fs.readFileSync(path.join(dir, kept[0]), 'utf8')) as { env: { N: string } }).env.N, '8', 'the older backup is not the pre-image of edit 9')
    assert.strictEqual((parse(file).env as { N: string }).N, '10')
  })

  // (i) --------------------------------------------------------------------------------------------
  test('(i) read-only directory: refuse, original byte-identical, no sidecar', () => {
    fs.writeFileSync(file, userText())
    const orig = fs.readFileSync(file)
    fs.chmodSync(dir, 0o555)
    const r = runPy(file, [{ op: 'set', path: ['env', 'X'], value: '1' }])
    fs.chmodSync(dir, 0o755)
    assert.notStrictEqual(r.status, 0, 'edit "succeeded" in a read-only directory')
    assert.ok(fs.readFileSync(file).equals(orig))
    assert.deepStrictEqual(siblings(dir), ['settings.json'])
  })

  test('(i) disk-full simulation (RLIMIT_FSIZE → short write/EFBIG): original intact, any backup is a COMPLETE copy, no tmp left', () => {
    const body = JSON.stringify({ ...userObject(), pad: 'x'.repeat(3000) }, null, 2) + '\n'
    fs.writeFileSync(file, body)
    const orig = fs.readFileSync(file)
    assert.ok(orig.length > 2048, 'fixture too small for the limit')
    const r = runPy(file, [{ op: 'set', path: ['env', 'X'], value: '1' }], [], 'ulimit -f 1')
    assert.notStrictEqual(r.status, 0, `an edit under a 512-byte write limit reported success: ${r.stdout}`)
    assert.ok(fs.readFileSync(file).equals(orig), 'original damaged')
    for (const b of backups(dir)) assert.ok(fs.readFileSync(path.join(dir, b)).equals(orig), `backup ${b} is TRUNCATED (short write ignored)`)
    assert.deepStrictEqual(siblings(dir).filter(f => /\.tmp$|agentlens-lock$/.test(f)), [], 'tmp/lock leaked')
  })

  test('(i) a STALE lock (killed editor, >30 s old) is broken and the edit proceeds; the lock is removed after', async () => {
    fs.writeFileSync(file, userText())
    const lock = `${file}.agentlens-lock`
    fs.writeFileSync(lock, '99999 0\n')
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lock, old, old)
    const t0 = Date.now()
    await safeConfigEdit(file, 'json', [{ op: 'set', path: ['env', 'X'], value: '1' }])
    assert.ok(Date.now() - t0 < 10_000)
    assert.ok(!fs.existsSync(lock))
  })

  // (j) --------------------------------------------------------------------------------------------
  suite('(j) the per-launch repair path: telemetryConfig + hookInstall on a foreign-content settings.json', function () {
    let opts: Required<Pick<TelemetryConfigOptions, 'settingsPath' | 'markerPath' | 'bodiesDir' | 'otlpPort' | 'dataDir' | 'managedSettingsPaths' | 'processEnv'>>
    let shim: string
    setup(() => {
      opts = { settingsPath: file, markerPath: path.join(dir, 'marker.json'), bodiesDir: path.join(dir, 'bodies'), otlpPort: 4318, dataDir: dir, managedSettingsPaths: [], processEnv: {} }
      shim = path.join(dir, 'shim')
      fs.mkdirSync(shim)
      fs.writeFileSync(path.join(shim, 'agentlenspro'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    })
    const noop = (): void => { /* quiet */ }

    test('converge twice: user content survives, the second launch writes NOTHING', async () => {
      fs.writeFileSync(file, userText(4))
      const before = parse(file)
      await ensureTelemetryConfig(opts)
      await installHooks(false, { settingsPath: file, pathEnv: shim, log: noop })
      const mid = parse(file)
      assertUntouched(before, mid, ['env', 'hooks'])
      for (const k of Object.keys(before.env as object)) assert.deepStrictEqual((mid.env as Record<string, unknown>)[k], (before.env as Record<string, unknown>)[k])
      const userPre = JSON.stringify((mid.hooks as Record<string, unknown[]>).PreToolUse)
      assert.ok(userPre.includes('user-hook.sh') && userPre.includes('"timeout":5'), 'the user PreToolUse hook was damaged')
      assert.ok(JSON.stringify((mid.hooks as Record<string, unknown[]>).Stop).includes('user-stop.sh'))
      const s1 = fs.statSync(file); const list1 = siblings(dir)
      await new Promise(r => setTimeout(r, 30))
      const e2 = await ensureTelemetryConfig(opts)
      const h2 = await installHooks(false, { settingsPath: file, pathEnv: shim, log: noop })
      const s2 = fs.statSync(file)
      assert.strictEqual(e2.changed, false); assert.strictEqual(h2.changed, false)
      assert.strictEqual(s2.mtimeMs, s1.mtimeMs); assert.strictEqual(s2.ino, s1.ino)
      assert.deepStrictEqual(siblings(dir), list1, 'a converged launch created files')
    })

    test('drift repair touches ONLY the drifted key (OTEL_LOG_RAW_API_BODIES deleted → restored, rest byte-equal)', async () => {
      fs.writeFileSync(file, userText())
      await ensureTelemetryConfig(opts)
      const full = parse(file)
      const env = { ...(full.env as Record<string, string>) }
      delete env.OTEL_LOG_RAW_API_BODIES
      fs.writeFileSync(file, JSON.stringify({ ...full, env }, null, 2) + '\n')
      const r = await ensureTelemetryConfig(opts)
      assert.strictEqual(r.changed, true)
      assert.deepStrictEqual(parse(file), full, 'repair changed more than the drifted key')
    })

    test('--force-install-telemetry: foreign keys replaced in ONE transaction, everything else survives, uninstall restores them', async () => {
      const base = userObject()
      ;(base.env as Record<string, string>).OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer company'
      ;(base.env as Record<string, string>).OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.company.example'
      fs.writeFileSync(file, JSON.stringify(base, null, 2) + '\n')
      await assert.rejects(ensureTelemetryConfig(opts), 'foreign telemetry must be refused without --force')
      assert.deepStrictEqual(parse(file), JSON.parse(JSON.stringify(base)), 'a REFUSED run changed the file')
      await ensureTelemetryConfig({ ...opts, forceInstall: true })
      const forced = parse(file)
      assertUntouched(JSON.parse(JSON.stringify(base)), forced, ['env'])
      assert.strictEqual((forced.env as Record<string, string>).FOO, 'bar')
      assert.ok(!('OTEL_EXPORTER_OTLP_HEADERS' in (forced.env as object)), 'foreign headers still present')
      await removeTelemetryConfig(opts)
      const restored = parse(file).env as Record<string, string>
      assert.strictEqual(restored.OTEL_EXPORTER_OTLP_HEADERS, 'Authorization=Bearer company', 'uninstall did not restore the company header')
      assert.strictEqual(restored.OTEL_EXPORTER_OTLP_ENDPOINT, 'https://otel.company.example')
    })

    test('a corrupt settings.json is refused by both writers and left byte-identical', async () => {
      const bad = userText().slice(0, 200)
      fs.writeFileSync(file, bad)
      await assert.rejects(ensureTelemetryConfig(opts))
      await assert.rejects(installHooks(false, { settingsPath: file, pathEnv: shim, log: noop }))
      assert.strictEqual(fs.readFileSync(file, 'utf8'), bad)
      assert.deepStrictEqual(backups(dir), [])
    })
  })
})
