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

import { agentlensDisabled, armKillSwitch, disarmKillSwitch, killSwitchPath, noRevivePath, reviveBraked } from '../cli/killSwitch'
import { runHookCommand, reviveDisabledOnDisk } from '../cli/hookHandlers'
import { ensureServer, runSupervise } from '../cli/serverControl'

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

  test('a hook is a NO-OP while disabled — and must not even read stdin', async () => {
    // The load-bearing behavior: `agentlenspro hook` must return 0 immediately, touching nothing.
    // If it read stdin it could block on a pipe the runner holds open; if it did work it would keep
    // burning the disk. Returning 0 with no output is also an ALLOW for the gate, so a disabled
    // AgentlensPro can never block the user's tool calls.
    armKillSwitch()
    let stdinRead = false
    const realStdin = process.stdin
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      get() { stdinRead = true; return realStdin },
    })
    try {
      assert.strictEqual(await runHookCommand('hook'), 0)
      assert.strictEqual(await runHookCommand('gate'), 0)
      assert.strictEqual(stdinRead, false, 'a disabled hook must not touch stdin at all')
    } finally {
      Object.defineProperty(process, 'stdin', { configurable: true, value: realStdin })
    }
  })

  test('the global switch also blocks server auto-revive (defence in depth)', () => {
    assert.strictEqual(reviveDisabledOnDisk(), false)
    armKillSwitch()
    // Spawning a detached server is the one side-effect that must never slip a missed guard, so it
    // is gated independently of the hook entry point.
    assert.strictEqual(reviveDisabledOnDisk(), true)
  })

  test('ensureServer REFUSES while disabled — the CLI was the kill-switch bypass', async () => {
    // The widest hole, found by catching a live server running 2.5h AFTER `disable` stopped it: the
    // HOOK path was gated but the CLI path was not, and every diagnostics tool call funnels through
    // ensureServer(). The project CLAUDE.md tells every Claude session to run diagnostics BEFORE any
    // task — so a disabled install came straight back the next time any running session started work.
    armKillSwitch()
    await assert.rejects(() => ensureServer(), /DISABLED/, 'a disabled AgentlensPro must not spawn a server')
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

  test('brake and switch stay DISTINCT — a pause is not a kill', async () => {
    // The supervisor depends on the difference (under DISABLED its spawn must proceed so the child
    // exits EX_CONFIG 78 and the loop terminates). If ensureServer collapsed the two into
    // reviveDisabledOnDisk(), this assertion would report the wrong reason and the split would rot.
    armBrake()
    assert.strictEqual(agentlensDisabled(), false, 'arming the brake must not arm the global switch')
    await assert.rejects(() => ensureServer(), (e: Error) => /revive brake/.test(e.message) && !/DISABLED/.test(e.message))
  })

  test('runSupervise REFUSES while disabled — a supervisor would out-stubborn the switch', () => {
    // The supervisor exists to restart the server forever. Ungated, `disable` would stop a server
    // that launchd instantly brought back — the flag would be decorative.
    armKillSwitch()
    assert.throws(() => runSupervise(), /DISABLED/)
  })
})
