// TRDD-F1VX3M7C — the supervisor's exit policy. Fail-closed embed-key boot exits EX_CONFIG (78): a
// DELIBERATE config refusal, not a crash (the DISABLED kill-switch no longer exits 78 — since TRDD-RBBEX59R
// c1 alcore boots in no-collection mode under it). Respawning a 78 would
// just re-refuse forever — the documented hook-revive crash loop. So the supervisor treats 78 as
// TERMINAL (stop, don't restart) while every other non-clean exit is a crash that gets the
// backoff-respawn. The live handler's terminal branch calls process.exit(78), so the decision is
// factored into the pure predicate isTerminalExit() and pinned here without spawning a process.
// EX_USAGE (64) is NOT terminal (usage() also covers transient filesystem state); it only gets a crash.log note.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { alcoreServeArgs, exitDiagnostic, isTerminalExit } from '../cli/serverControl'
import { makeFakeAlcore, spawnCliModule, stopChild, waitFor } from './helpers/fakeAlcore'

// The Rust entry point, read as text: the parity test below pins the flag the CLI's spawn args rely on.
const ALCORE_RS = path.resolve(__dirname, '..', '..', '..', 'rust-core', 'crates', 'agentlens-core', 'src', 'bin', 'alcore.rs')

suite('supervisor exit policy — EX_CONFIG(78) is terminal, crashes respawn (TRDD-F1VX3M7C)', () => {
  test('exit 78 (EX_CONFIG config refusal) is terminal — the supervisor must not respawn it', () => {
    assert.strictEqual(isTerminalExit(78), true)
  })
  test('a clean exit 0 is not a config refusal (it is a deliberate stop, handled elsewhere)', () => {
    assert.strictEqual(isTerminalExit(0), false)
  })
  test('a generic error exit 1 is a crash — respawns, not terminal', () => {
    assert.strictEqual(isTerminalExit(1), false)
  })
  test('a V8 OOM abort (code 134) is a crash — respawns, not terminal', () => {
    assert.strictEqual(isTerminalExit(134), false)
  })
  test('a signal kill (code null) is a crash — respawns, not terminal', () => {
    assert.strictEqual(isTerminalExit(null), false)
  })
})

suite('alcore.rs parity — the flag the CLI passes (TRDD-RBBEX59R c2)', () => {
  const src = fs.readFileSync(ALCORE_RS, 'utf8')
  test('alcore parses the --no-collection flag the CLI passes under the kill-switch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-parity-'))
    fs.writeFileSync(path.join(dir, 'DISABLED'), 'parity test\n')
    let passed: string[]
    try { passed = alcoreServeArgs(process.env, dir).filter(a => a.startsWith('--no-')) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    assert.ok(passed.includes('--no-collection'), `the CLI passes --no-collection: ${passed.join(' ')}`)
    assert.match(src, /"--no-collection" => no_collection_flag = true/, 'alcore.rs no longer parses --no-collection: the spawn would exit 64')
  })
  test('exit 64 still respawns; crash.log names version skew only when stderr proves it (TRDD-RBBEX59R c2 round 4)', () => {
    // Not terminal: usage() also covers filesystem-state errors (a briefly absent --media-dir), which a respawn can outlive.
    assert.strictEqual(isTerminalExit(64), false)
    const skew = /alcore rejected its arguments \(exit 64\) — an alcore older than this CLI rejects --no-collection; deploy the matching alcore/
    assert.match(exitDiagnostic(64, '2026 alcore: unknown arg --no-collection | usage: alcore serve ...'), skew)
    // Any other 64 (the --media-dir checks, alcore.rs:205/:207) gets the generic note, never the skew claim.
    const other = exitDiagnostic(64, '2026 alcore: --media-dir /x: no index.html there | usage: alcore serve ...')
    assert.strictEqual(other, ' — alcore rejected an argument or a path (exit 64); see stderr-tail')
    assert.doesNotMatch(other, /older than this CLI/)
    for (const c of [0, 1, 78, 134, null]) assert.strictEqual(exitDiagnostic(c, 'unknown arg --no-collection'), '', String(c))
  })
  test('wiring: the supervisor respawns an exit 64 and writes the skew note into crash.log (TRDD-RBBEX59R c2 round 4)', async function () {
    // Pins that runSupervise actually passes the child's stderr tail to exitDiagnostic: a pure-function test cannot
    // see a call site that drops the note. Run in a CHILD process: runSupervise installs signal handlers and never returns.
    this.timeout(40_000)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-sup64-'))
    const data = path.join(dir, 'data')
    const fake = makeFakeAlcore(path.join(dir, 'fake'), { exitCode: 64, stderr: 'alcore: unknown arg --no-collection' })
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, AGENTLENS_DATA_DIR: data, AGENTLENS_ALCORE: fake.bin, AGENTLENS_SUPERVISE_MAX_BACKOFF_MS: '100' }
    delete env.AGENTLENS_DISABLED
    const child = spawnCliModule('serverControl.js', 'runSupervise', [], env)
    const crashLog = path.join(data, 'crash.log')
    const readLog = (): string => { try { return fs.readFileSync(crashLog, 'utf8') } catch { return '' } }
    try {
      assert.ok(await waitFor(() => fake.calls().length >= 2, 15_000), `exit 64 must be respawned: ${JSON.stringify(fake.calls())}`)
      assert.ok(await waitFor(() => /code=64 .*older than this CLI rejects --no-collection; deploy the matching alcore/.test(readLog()), 5_000), `crash.log must carry the skew note: ${readLog()}`)
    } finally {
      await stopChild(child)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
