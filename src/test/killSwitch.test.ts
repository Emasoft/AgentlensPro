// The GLOBAL kill-switch (TRDD-K3WDPR7M). Born from the 2026-07-14 SSD incident: raw-body capture
// was burning ~35 GB/day and there was NO way to stop it machine-wide. A settings edit reached ZERO
// of the 13 already-running Claude sessions (they load config at launch); killing the server was
// futile (the next hook resurrected it); and AGENTLENS_GATE=off could not be retrofitted onto a
// running agent (a hook inherits CLAUDE's env, not the operator's).
//
// So the contract under test is precisely: a FILE on disk disarms hooks in processes that are
// ALREADY RUNNING, because every hook is a fresh process that re-reads the filesystem.
import * as assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { Readable } from 'stream'

// This suite MUST resolve the data dir to a tmpdir — pointing it at the user's real ~/.agentlens
// would arm their live kill-switch. AGENTLENS_DATA_DIR is the namespaced override and takes
// precedence over the generic DATA_DIR (src/dataDir.ts).
//
// It is set in suiteSetup and RESTORED in suiteTeardown, never at module scope. Mocha loads every
// test file into ONE process, so a module-scope assignment leaks into every file imported after
// this one: it silently redirected the "against REAL captured bodies" suites to this tmpdir, and
// they skipped instead of running. Safe to do late — the resolver reads the environment on each
// call rather than capturing it at import time.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-ks-'))

import { agentlensDisabled, armKillSwitch, disarmKillSwitch, killSwitchHalf, killSwitchPath, noRevivePath, overrideKillSwitchEnv, reviveBraked } from '../cli/killSwitch'
import { runHookCommand } from '../cli/hookHandlers'
import { alcoreServeArgs, ensureServer, serverCommand } from '../cli/serverControl'
import { makeFakeAlcore, spawnCliModule, stopChild, waitFor } from './helpers/fakeAlcore'

suite('global kill-switch', () => {
  let savedDataDir: string | undefined
  let savedGeneric: string | undefined
  let savedMcpUrl: string | undefined
  let notAnMcpServer: http.Server | undefined
  suiteSetup(async () => {
    savedDataDir = process.env.AGENTLENS_DATA_DIR
    savedGeneric = process.env.DATA_DIR
    savedMcpUrl = process.env.AGENTLENS_MCP_URL
    process.env.AGENTLENS_DATA_DIR = tmpHome
    // THE DATA DIR IS NOT ENOUGH — the endpoint is resolved by PORT, not by data dir, so a suite
    // isolated only by AGENTLENS_DATA_DIR still probes localhost:4316 and the DEVELOPER'S OWN
    // running server answers it. Measured 2026-08-27: with the brake armed, ensureServer() returned
    // instead of throwing because a real server (18h uptime, different data dir) satisfied init().
    // The pre-existing tests hid this: every gate they exercised sat ABOVE the probe, so no test
    // had ever reached the network.
    //
    // A port WE HOLD for the suite's lifetime, answering something that is not MCP. Two weaker
    // shapes were tried and rejected: a hardcoded "surely unused" port (something may listen on it
    // — every rejection test goes green for the wrong reason, intermittently), and an OS-assigned
    // port bound-then-RELEASED (the number is free again the instant close() returns; "the OS gave
    // it to me" is not a reservation — verified: it rebinds immediately). An OPEN listener is the
    // only thing nothing else can bind — that is the property this buys, unconditionally.
    // A narrower second one: ensureServer()'s probe SWALLOWS the rejection reason, so "500 body"
    // vs ECONNREFUSED is invisible to every test here; its only payoff is a DROP-ing firewall,
    // where refused would become a CONNECT_TIMEOUT_MS hang and a listening decoy never hangs.
    notAnMcpServer = http.createServer((_req, res) => { res.writeHead(500); res.end('not an mcp server') })
    await new Promise<void>(resolve => notAnMcpServer!.listen(0, '127.0.0.1', resolve))
    const port = (notAnMcpServer.address() as { port: number }).port
    process.env.AGENTLENS_MCP_URL = `http://127.0.0.1:${port}/mcp`
  })
  suiteTeardown(async () => {
    // closeAllConnections() FIRST: close() alone waits for idle keep-alive sockets to time out,
    // which was ~700ms of a 900ms suite — the teardown was the slowest thing in it (measured:
    // tests summed to ~210ms, suite reported 911ms).
    if (notAnMcpServer) {
      notAnMcpServer.closeAllConnections()
      await new Promise<void>(resolve => notAnMcpServer!.close(() => resolve()))
    }
    if (savedDataDir === undefined) delete process.env.AGENTLENS_DATA_DIR
    else process.env.AGENTLENS_DATA_DIR = savedDataDir
    if (savedGeneric === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = savedGeneric
    if (savedMcpUrl === undefined) delete process.env.AGENTLENS_MCP_URL
    else process.env.AGENTLENS_MCP_URL = savedMcpUrl
  })
  // The brake is cleared around EVERY test, not just the brake ones: it lives in the same tmp data
  // dir, and a leaked NO_REVIVE would make an unrelated ensureServer test pass for the wrong reason.
  const clearBrake = (): void => { try { fs.unlinkSync(noRevivePath()) } catch { /* absent is fine */ } }
  const armBrake = (): void => {
    fs.mkdirSync(path.dirname(noRevivePath()), { recursive: true })
    fs.writeFileSync(noRevivePath(), `server stop --stay-down ${new Date().toISOString()}\n`)
  }
  setup(() => { delete process.env.AGENTLENS_DISABLED; disarmKillSwitch(); clearBrake() })
  teardown(() => { delete process.env.AGENTLENS_DISABLED; disarmKillSwitch(); clearBrake() })

  test('absent flag means enabled — the default must never be "silently off"', () => {
    assert.strictEqual(agentlensDisabled(), false)
  })

  test('arming the flag disables, and it is observable WITHOUT restarting the process', () => {
    assert.strictEqual(agentlensDisabled(), false)
    armKillSwitch('SSD burning')
    // The same live process now reads disabled — this IS the property a settings edit lacks.
    assert.strictEqual(agentlensDisabled(), true)
  })

  test('disarming re-enables', () => {
    armKillSwitch()
    assert.strictEqual(agentlensDisabled(), true)
    disarmKillSwitch()
    assert.strictEqual(agentlensDisabled(), false)
  })

  test('arming is idempotent — re-arming an armed switch is not an error', () => {
    armKillSwitch('first')
    armKillSwitch('second')
    assert.strictEqual(agentlensDisabled(), true)
    assert.ok(fs.readFileSync(killSwitchPath(), 'utf8').includes('second'))
  })

  test('disarming a switch that was never armed is success, not a throw', () => {
    assert.doesNotThrow(() => disarmKillSwitch())
    assert.strictEqual(agentlensDisabled(), false)
  })

  test('the flag file explains itself — an operator who finds it must not need our source', () => {
    armKillSwitch('runaway ingestion')
    const body = fs.readFileSync(killSwitchPath(), 'utf8')
    assert.ok(body.includes('DISABLED'), 'says what state it puts the tool in')
    assert.ok(body.includes('runaway ingestion'), 'records WHY it was armed')
    assert.ok(body.includes('agentlenspro enable'), 'says how to undo it')
  })

  test('AGENTLENS_DISABLED=1 also disables, for the paths where env DOES reach the process', () => {
    process.env.AGENTLENS_DISABLED = '1'
    assert.strictEqual(agentlensDisabled(), true)
  })

  test('killSwitchHalf names WHICH half fired — env, file, or neither — so a caller never has to re-derive it', () => {
    assert.strictEqual(killSwitchHalf(), null)
    process.env.AGENTLENS_DISABLED = '1'
    assert.strictEqual(killSwitchHalf(), 'env')
    delete process.env.AGENTLENS_DISABLED
    armKillSwitch()
    assert.strictEqual(killSwitchHalf(), 'file')
    // env takes precedence when BOTH are set — matches agentlensDisabled()'s own check order.
    process.env.AGENTLENS_DISABLED = '1'
    assert.strictEqual(killSwitchHalf(), 'env')
  })

  // TRDD-RBBEX59R c2: under the switch the hook and the gate keep running against a no-collection server, so the
  // spawn guards (RUNAWAY_FANOUT, FANOUT_HEADSUP) and the image cache-guard stay on. Owner order 2026-11-03,
  // «keep the guards». What the switch still changes on the CLI side is the spool (decision 3: no spool).
  test('under the switch the hook still POSTs and never spools; the gate still runs', async () => {
    const seen: string[] = []
    const srv = http.createServer((req, res) => {
      seen.push(req.url ?? '')
      req.resume()
      // The hook endpoint FAILS, so forwardHookEvent reaches its spool decision; the gate endpoint answers a verdict.
      if (req.url === '/api/agent-gate') { res.writeHead(200); res.end('GATE-VERDICT') } else { res.writeHead(500); res.end() }
    })
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as { port: number }).port
    const saved = { ui: process.env.AGENTLENS_UI_URL, noRevive: process.env.AGENTLENS_NO_REVIVE, gate: process.env.AGENTLENS_GATE }
    const realStdin = process.stdin
    const realWrite = process.stdout.write.bind(process.stdout)
    const spoolDir = path.join(tmpHome, 'hook-spool')
    const spooled = (): number => { try { return fs.readdirSync(spoolDir).filter(n => n.endsWith('.json')).length } catch { return 0 } }
    const runWith = async (kind: 'hook' | 'gate', payload: string): Promise<string> => {
      Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from([Buffer.from(payload)]) })
      let out = ''
      process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true }) as typeof process.stdout.write
      try { assert.strictEqual(await runHookCommand(kind), 0) } finally {
        process.stdout.write = realWrite
        Object.defineProperty(process, 'stdin', { configurable: true, value: realStdin })
      }
      return out
    }
    process.env.AGENTLENS_UI_URL = `http://127.0.0.1:${port}`
    process.env.AGENTLENS_NO_REVIVE = '1' // the failed POST would otherwise spawn a revive
    delete process.env.AGENTLENS_GATE
    fs.rmSync(spoolDir, { recursive: true, force: true })
    try {
      armKillSwitch()
      await runWith('hook', JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 'ks-1' }))
      assert.ok(seen.includes('/api/hook-events'), `the hook must POST under the switch: ${seen.join(',')}`)
      assert.strictEqual(spooled(), 0, 'no spool file under the switch')
      const verdict = await runWith('gate', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' } }))
      assert.ok(seen.includes('/api/agent-gate'), 'the gate must ask the server under the switch')
      assert.strictEqual(verdict, 'GATE-VERDICT', 'the gate prints the server verdict verbatim under the switch')
      // Control: the same failed POST WITHOUT the switch does spool — so the zero above is the switch, not a blind check.
      disarmKillSwitch()
      await runWith('hook', JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 'ks-2' }))
      assert.strictEqual(spooled(), 1, 'outside the switch a failed POST spools the event')
    } finally {
      for (const [k, v] of [['AGENTLENS_UI_URL', saved.ui], ['AGENTLENS_NO_REVIVE', saved.noRevive], ['AGENTLENS_GATE', saved.gate]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
      fs.rmSync(spoolDir, { recursive: true, force: true })
      srv.closeAllConnections()
      await new Promise<void>(resolve => srv.close(() => resolve()))
    }
  })

  test('the switch no longer blocks the auto-revive; NO_REVIVE still does', async () => {
    // reviveDisabledOnDisk() (switch OR brake) is deleted: with the switch half gone it equalled reviveBraked().
    // The revive verb is what the hook spawns; under the switch it must reach the spawn — with --no-collection.
    armKillSwitch()
    assert.strictEqual(reviveBraked(), false, 'the switch alone is not a revive brake')
    const fake = makeFakeAlcore(path.join(tmpHome, 'fake-revive'))
    const savedAlcore = process.env.AGENTLENS_ALCORE
    const savedNoRevive = process.env.AGENTLENS_NO_REVIVE
    process.env.AGENTLENS_ALCORE = fake.bin
    delete process.env.AGENTLENS_NO_REVIVE
    try {
      await assert.rejects(() => serverCommand(['revive']), /exited during startup/, 'the revive reaches the (fake) spawn under the switch')
      assert.strictEqual(fake.calls().length, 1)
      assert.ok(fake.calls()[0].includes('--no-collection'), `the revived server runs in no-collection mode: ${fake.calls()[0].join(' ')}`)
      armBrake()
      await assert.rejects(() => serverCommand(['revive']), /server revive refused/, 'NO_REVIVE still refuses')
      assert.strictEqual(fake.calls().length, 1, 'no spawn under NO_REVIVE')
    } finally {
      if (savedAlcore === undefined) delete process.env.AGENTLENS_ALCORE; else process.env.AGENTLENS_ALCORE = savedAlcore
      if (savedNoRevive === undefined) delete process.env.AGENTLENS_NO_REVIVE; else process.env.AGENTLENS_NO_REVIVE = savedNoRevive
      fs.rmSync(path.join(tmpHome, 'fake-revive'), { recursive: true, force: true })
    }
  })

  test('ensureServer under the switch SPAWNS, with --no-collection for its data dir', async () => {
    // It used to refuse (the 2026-07-14 diagnostics-path revival). Now the server runs, storing nothing, so the
    // guards answer. A fake alcore records the argv and exits, so the start fails AFTER the spawn — the argv is the proof.
    armKillSwitch()
    const fake = makeFakeAlcore(path.join(tmpHome, 'fake-ensure'))
    const savedAlcore = process.env.AGENTLENS_ALCORE
    process.env.AGENTLENS_ALCORE = fake.bin
    try {
      await assert.rejects(() => ensureServer('test'), /exited during startup/)
      const argv = fake.calls()[0] ?? []
      assert.ok(argv.includes('--no-collection'), `flag expected: ${argv.join(' ')}`)
      assert.strictEqual(argv[argv.indexOf('--data-dir') + 1], tmpHome)
    } finally {
      if (savedAlcore === undefined) delete process.env.AGENTLENS_ALCORE; else process.env.AGENTLENS_ALCORE = savedAlcore
      fs.rmSync(path.join(tmpHome, 'fake-ensure'), { recursive: true, force: true })
    }
  })

  test('alcoreServeArgs adds --no-collection exactly when the switch is armed for THAT dir (file half, env half; the env override gives none)', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-ks-other-'))
    const has = (dir: string): boolean => alcoreServeArgs(process.env, dir).includes('--no-collection')
    try {
      assert.strictEqual(has(tmpHome), false, 'no switch, no flag')
      armKillSwitch()
      assert.strictEqual(has(tmpHome), true, 'file half armed for this dir')
      assert.strictEqual(has(other), false, 'the file half of ANOTHER dir does not count — keyed on the --data-dir value')
      disarmKillSwitch()
      process.env.AGENTLENS_DISABLED = '1'
      assert.strictEqual(has(other), true, 'env half arms every dir')
      overrideKillSwitchEnv(true)
      assert.strictEqual(has(other), false, '--force-install-telemetry overrides the env half: no flag')
    } finally {
      overrideKillSwitchEnv(false)
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  test('the revive brake reads armed the moment the file exists — no restart, like the switch', () => {
    assert.strictEqual(reviveBraked(), false)
    armBrake()
    assert.strictEqual(reviveBraked(), true)
  })

  test('ensureServer REFUSES while the revive brake is set — TRDD-8VGQK9L9 regression', async () => {
    // `server stop --stay-down` promises "hooks and the supervisor will not resurrect the server",
    // and for 1h53m on 2026-08-26 that promise was false: ensureServer() gated only on DISABLED, so
    // any diagnostics command carrying the GLOBAL --start-server/--dashboard flags revived a braked
    // server while the operator swapped the store underneath it.
    armBrake()
    await assert.rejects(() => ensureServer(), /revive brake/, 'a braked AgentlensPro must not spawn a server')
  })

  test('a REACHABLE server is still used while braked — the brake refuses the SPAWN, not the server', async () => {
    // REGRESSION for the first cut of this gate (caught in review, never shipped): it sat ABOVE the
    // init() probe, so it threw whenever the brake was set — even with a healthy server answering.
    // That prevents nothing (the writer the store was being protected from is already running) while
    // breaking every diagnostics call against it.
    //
    // THIS is the test that discriminates. The two rejection tests around it pass under BOTH
    // orderings, because they run with nothing listening; only a reachable server tells the two
    // apart. A stub MCP endpoint is enough — init() needs one successful JSON-RPC `initialize`.
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
    })
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as { port: number }).port
    const saved = process.env.AGENTLENS_MCP_URL
    process.env.AGENTLENS_MCP_URL = `http://127.0.0.1:${port}/mcp`
    try {
      armBrake()
      await ensureServer()  // must RETURN: the brake blocks starting a server, not using one
    } finally {
      // Always restore and always close — a leaked listener would let a later test reach this stub.
      if (saved === undefined) delete process.env.AGENTLENS_MCP_URL
      else process.env.AGENTLENS_MCP_URL = saved
      srv.closeAllConnections()  // same keep-alive drain as the suite listener; see suiteTeardown
      await new Promise<void>(resolve => srv.close(() => resolve()))
    }
  })

  test('the brake can still be LIFTED: ensureServer honours overrideBrake and `server start` clears it', async () => {
    // ai_review regression (never shipped): the gate above refused the spawn BEFORE `server start`
    // reached clearReviveBrake(), so the one command every message names as the way out failed with
    // "clear it with: agentlenspro server start" — a dead end with rm as the only escape.
    //
    // Two halves. FIRST the gate itself, on the UNREACHABLE path (the gate sits below the probe,
    // so a reachable stub never reaches it — round 2 of review showed the contract half alone
    // passes with the override deleted). Reaching the gate without spawning the real bundle: a
    // closed port forces the probe past init(), and a bogus AGENTLENS_ALCORE makes the spawn fail
    // ENOENT one tick later (alcoreBin() returns the env value verbatim, no existence check). On
    // the pre-fix code the override call rejects with /revive brake/; now it must get PAST it.
    armBrake()
    const savedUrl = process.env.AGENTLENS_MCP_URL
    const savedAlcore = process.env.AGENTLENS_ALCORE
    process.env.AGENTLENS_MCP_URL = 'http://127.0.0.1:1/mcp'
    process.env.AGENTLENS_ALCORE = path.join(os.tmpdir(), 'agentlens-no-such-alcore-' + process.pid)
    try {
      await assert.rejects(() => ensureServer('test'), /revive brake/, 'no override ⇒ the gate refuses')
      await assert.rejects(
        () => ensureServer('test', { overrideBrake: true }),
        (e: Error) => !/revive brake/.test(e.message) && /spawn|ENOENT/.test(e.message),
        'override ⇒ past the gate, failing only at the (deliberately impossible) spawn',
      )
      assert.strictEqual(reviveBraked(), true, 'a failed start must leave the brake armed')
      // And the CALL SITE: `server start` must pass the override (this is the line the round-1
      // regression lived on). Same env ⇒ it must fail at the spawn, never at the brake.
      await assert.rejects(
        () => serverCommand(['start']),
        (e: Error) => !/revive brake/.test(e.message) && /spawn|ENOENT/.test(e.message),
        '`server start` must reach the spawn through the brake',
      )
      assert.strictEqual(reviveBraked(), true, 'a failed `server start` must leave the brake armed')
    } finally {
      if (savedUrl === undefined) delete process.env.AGENTLENS_MCP_URL; else process.env.AGENTLENS_MCP_URL = savedUrl
      if (savedAlcore === undefined) delete process.env.AGENTLENS_ALCORE; else process.env.AGENTLENS_ALCORE = savedAlcore
    }
    // SECOND the contract: the whole `server start` command against a reachable stub lifts the brake.
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
    })
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as { port: number }).port
    const saved = process.env.AGENTLENS_MCP_URL
    process.env.AGENTLENS_MCP_URL = `http://127.0.0.1:${port}/mcp`
    try {
      await serverCommand(['start'])
      assert.strictEqual(reviveBraked(), false, '`server start` must lift the brake it is documented to lift')
    } finally {
      if (saved === undefined) delete process.env.AGENTLENS_MCP_URL
      else process.env.AGENTLENS_MCP_URL = saved
      srv.closeAllConnections()
      await new Promise<void>(resolve => srv.close(() => resolve()))
    }
  })

  test('brake and switch stay DISTINCT — the brake keeps the process down, the switch only stops collection', async () => {
    // NO_REVIVE keeps the server process DOWN; DISABLED only turns collection off (TRDD-RBBEX59R c2). If ensureServer
    // read the brake and the switch as one predicate, this assertion would report the wrong reason and the split
    // would rot.
    armBrake()
    assert.strictEqual(agentlensDisabled(), false, 'arming the brake must not arm the global switch')
    await assert.rejects(() => ensureServer(), (e: Error) => /revive brake/.test(e.message) && !/DISABLED/.test(e.message))
  })

  test('runSupervise under the switch STARTS, and every respawn recomputes --no-collection (TRDD-RBBEX59R c2)', async function () {
    // It used to refuse a disabled install. Now the switch means "collect nothing", not "run nothing": every child
    // the supervisor spawns goes through alcoreServeArgs(), so it carries --no-collection while the switch is armed
    // for the data dir — and a respawn AFTER the flag is lifted carries none (the enable verb's supervisor branch
    // depends on exactly that). Run in a CHILD process: runSupervise installs signal handlers and never returns.
    this.timeout(40_000)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-ks-sup-'))
    const data = path.join(dir, 'data')
    const fake = makeFakeAlcore(path.join(dir, 'fake'))
    armKillSwitch(undefined, data)
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, AGENTLENS_DATA_DIR: data, AGENTLENS_ALCORE: fake.bin, AGENTLENS_SUPERVISE_MAX_BACKOFF_MS: '100' }
    delete env.AGENTLENS_DISABLED
    const child = spawnCliModule('serverControl.js', 'runSupervise', [], env)
    const flagged = (c: string[]): boolean => c.includes('--no-collection')
    try {
      assert.ok(await waitFor(() => fake.calls().length >= 2, 15_000), `the supervisor must spawn and respawn: ${JSON.stringify(fake.calls())}`)
      assert.ok(fake.calls().every(flagged), `every spawn under the switch carries the flag: ${JSON.stringify(fake.calls())}`)
      assert.ok(fake.calls().every((c) => c[c.indexOf('--data-dir') + 1] === data), 'the flag is keyed on the dir passed as --data-dir')
      const before = fake.calls().length
      disarmKillSwitch(data)
      assert.ok(await waitFor(() => fake.calls().slice(before).some((c) => !flagged(c)), 15_000), `a respawn after the lift carries no flag: ${JSON.stringify(fake.calls())}`)
    } finally {
      await stopChild(child)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
