// src/cli/main.ts — the top-level dispatcher of the SINGLE `agentlenspro` executable
// (TRDD-7284WCW7). standalone/cli.ts is a 3-line shim around this so the whole dispatch
// lives under src/ where BOTH tsc gates (tsconfig.json + tsconfig.test.json) type-check it.
//
// Dispatch order is load-bearing:
//   1. --version/-v and --help/-h answer from static data BEFORE anything touches the data
//      dir or the network. Field defect: `npx agentlenspro --version` used to boot the whole
//      span store just to parse a flag (and then exited 1). Never reintroduce side effects
//      on these paths.
//   2. `hook`/`gate` are the hot hook-fire paths — they read stdin and talk to the server,
//      nothing else.
//   3. Bare no-args keeps the original `npx agentlenspro` behavior: run the server in the
//      foreground (it serves the dashboard). The server module has top-level side effects
//      (it binds ports on load), so the shim injects it as a LAZY loader — it must never be
//      imported on any other path.

import { packageVersion } from '../packageVersion'
import { runTelemetryCli } from '../telemetryConfig'
import { runDiagnosticsCli, USAGE } from './diagnosticsCli'
import { runHookCommand } from './hookHandlers'
import { runHeartbeatCost } from './heartbeatCostCli'
import { runConfigCli } from './configCli'
import { runSpoolCli } from './spoolCli'
import { runEnvCli } from './envCli'
import { runDisableCli, runEnableCli } from './disableCli'
import { ensureServer, openDashboard, serverCommand, daemonCommand } from './serverControl'
import { runSetupCli } from './setup'
import { runBudgetCli } from './budgetCli'
import { runWatchCli } from './watchCli'
import { runCtxmapCli } from './ctxmapCli'
import { runCtxvisCli } from './ctxvisCli'
import { runStatuslineCommand } from './statuslineCapture'
import { runStatuslineHistoryCli } from './statuslineHistoryCli'
import { runAllAccountsCli } from './allAccountsCli'
import { runCacheExpiredCli } from './cacheExpiredCli'
import { runLastCompactCli } from './lastCompactCli'

/** CLI entry. `startServer` lazily imports standalone/server (injected by the shim — src/
 *  cannot import standalone/ without inverting the build layering). Returns the exit code. */
/** Exit NOW for the three hot-path commands, instead of returning and letting the event loop drain.
 *
 *  MEASURED, and this is a user-visible freeze, not a tidiness issue: with the server unreachable in
 *  a way that HANGS rather than refuses (a firewall DROP, a suspended container, a VPN flap),
 *  `agentlenspro statusline` took **10.6 seconds** — on a surface Claude Code re-runs on every render.
 *
 *  The abort is not the problem and was never the problem. `AbortSignal.timeout(700)` fires correctly
 *  (measured: the fetch rejects in 704 ms). But aborting a fetch does NOT destroy the underlying TCP
 *  socket, the socket keeps the event loop alive until the OS connect timeout, and cli.ts finishes by
 *  setting `process.exitCode` — i.e. by waiting for that loop to drain. So the timeout bounded the
 *  REQUEST and nothing bounded the PROCESS.
 *
 *  BUT `process.exit()` DISCARDS a pending piped stdout write. MEASURED: write 262,144 bytes to a
 *  pipe and exit, and the reader gets 65,536 — one pipe buffer. `gate` writes its verdict to stdout
 *  and Claude Code READS it to decide whether to block a tool call, so a truncated write there is a
 *  corrupted safety decision, not cosmetic damage. Hence flush first, and bound the flush too: a
 *  reader that never drains must not reintroduce exactly the hang this function exists to prevent.
 *
 *  Scoped to these three commands. Every other subcommand keeps the normal drain-and-exit path.
 *
 *  Exported for the latency guard (TRDD-E8XIC2PM): the flush-vs-exit invariant lives HERE, not in any
 *  one command, so a test that drives this function covers every command that exits through it —
 *  including ones added later. */
export async function exitNow(code: number): Promise<never> {
  await new Promise<void>(resolve => {
    const t = setTimeout(resolve, 500)
    t.unref?.()
    // A zero-length write's callback fires once everything queued before it has flushed.
    process.stdout.write('', () => { clearTimeout(t); resolve() })
  })
  process.exit(code)
}

// ── Latency classification (TRDD-E8XIC2PM) ───────────────────────────────────────────────────────
// Every subcommand below is either on a HARNESS HOT PATH with a wall-clock ceiling, or exempt WITH A
// REASON. It lives beside the dispatch on purpose: the guard test derives the command set from the
// `case` labels in this file, so adding a case without classifying it FAILS rather than defaulting
// silently into the untested set — which is exactly how `statusline` shipped a 10.6 s stall while a
// thorough "server down" suite stayed green (every test pointed at a closed port, which REFUSES
// instantly; only an address that DROPS reproduces it).
//
// A blanket exemption list with no reasons rots into "everything is exempt", so each one says why.
export const HOT_PATH_BUDGET_MS: Readonly<Record<string, number>> = {
  // Claude Code runs these itself, per tool call and per render. The registered hook timeouts are
  // 2 s (lifecycle) and 3 s (gate), so the ceiling has to sit under the timeout the harness enforces.
  hook: 2_000,
  gate: 2_500,
  statusline: 2_000,
  // Not run by Claude Code, but polled in loops by agents and heartbeats, and both are documented to
  // answer with the server DOWN. Neither touches the network today; the budget is what catches the
  // day one of them grows a fetch.
  'cache-expired': 1_500,
  'last-compact': 1_500,
}

export const LATENCY_EXEMPT: Readonly<Record<string, string>> = {
  'statusline-history': 'an investigation verb a human or agent invokes deliberately; it may legitimately scan a large sample store',
  get_account_status: '--all is file-backed and fast, but the singular form proxies to the server BY DESIGN (it needs live session accessors); a rotator calls it out of band, never per render',
  disable: 'one-shot operator action (arms the global brake) — a human waits for it',
  enable: 'one-shot operator action, the counterpart of disable',
  telemetry: 'installer surface: edits user config through the verified transaction, which takes a cross-process lock',
  setup: 'the installer/repairer — detect, converge, verify, self-test; it is expected to take seconds',
  server: 'starts or stops the long-running server; it IS the thing a hot path calls, not a caller',
  daemon: 'same process as `server`, launched by launchd — long-running by definition',
  dashboard: 'ensures the server then opens a browser; a human is watching',
  budget: 'a preflight projection, and `--watch` observes for as long as the caller asks',
  watch: 'observes INDEFINITELY by design — a ceiling here would contradict the verb',
  'heartbeat-cost': 'an analysis verb over historical fires; not on any per-turn path',
  config: 'reads/writes the data-retention config; invoked by a human or an installer',
  spool: 'creates/removes a RAM-disk spool — mount work, run at login by a LaunchAgent',
  env: 'environment detection report; a diagnostic a human reads',
  ctxmap: 'decomposes captured request bodies with real token counting — inherently slow, and asked once',
  ctxvis: 'SPAWNS an agent and measures two of its turns; it is the slowest verb we ship, deliberately',
}

export async function cliMain(argv: string[], startServer: () => Promise<unknown>): Promise<number> {
  const cmd = argv[0]

  // Zero-side-effect global flags FIRST (see the dispatch-order note above).
  if (cmd === '--version' || cmd === '-v') {
    console.log(packageVersion())
    return 0
  }
  if (cmd === '--help' || cmd === '-h') {
    console.log(USAGE)
    return 0
  }

  // HELP IS TOTAL — `--help`/`-h` ANYWHERE in argv means "describe, never do" (owner directive
  // 2026-08-05). The incident that mandates it: `agentlenspro disable --help` EXECUTED the
  // disable — runDisableCli folds non-flag args into the reason and arms the kill-switch
  // unconditionally, so a help probe stopped the server, disarmed every hook on the machine and
  // stripped the telemetry env. "Every verb parses its own flags before acting" is a property no
  // dispatcher can guarantee verb-by-verb (any new verb can regress it), so the guarantee lives
  // HERE, before any dispatch — the git/npm contract: `git commit --help` never commits.
  // A diagnostics tool gets its real schema help when the server is up; anything else (or a down
  // server) gets the global USAGE, which documents every management verb.
  if (argv.some(a => a === '--help' || a === '-h')) {
    if (cmd && !cmd.startsWith('-')) {
      try {
        await runDiagnosticsCli(['help', cmd])
        return 0
      } catch { /* not a known tool, or no server — the global usage below covers the verbs */ }
    }
    console.log(USAGE)
    return 0
  }

  switch (cmd) {
    case 'hook':
      return exitNow(await runHookCommand('hook'))
    case 'gate':
      return exitNow(await runHookCommand('gate'))
    case 'statusline':
      // The status-line capture wrapper. Sits on the RENDER path (every assistant message plus a
      // refreshInterval timer), so it belongs beside hook/gate in the hot-path band: read stdin,
      // exec the real status-line command, forward the payload. It must reach `return` before any
      // module with side effects is touched.
      return exitNow(await runStatuslineCommand(argv.slice(1)))
    case 'statusline-history':
      // Reads the sample store straight off disk (no server), because the moment someone asks what
      // burned the window is exactly when the server may be down.
      return runStatuslineHistoryCli(argv.slice(1))
    case 'get_account_status':
      // Only the PLURAL form short-circuits the server. `--all` is assembled entirely from files (the
      // account-state timeline + the per-account usage archive), and its whole audience is a rotator
      // deciding what to do about a wedged machine — where proxying to a server that may itself be
      // down turns the one useful answer into "cannot reach localhost:4316". The singular form still
      // goes over the wire: it needs the live session accessors, which only the server has.
      if (argv.includes('--all')) return runAllAccountsCli(argv.slice(1))
      // Not `--all`: fall through to the diagnostics surface, which proxies it to the server.
      await runDiagnosticsCli(argv)
      return 0
    case 'disable':
      // THE GLOBAL BRAKE. Arms <dataDir>/DISABLED, which disarms every hook, the burn-gate, server
      // auto-revive and all background ingestion — in EVERY Claude session already running, on its
      // next hook fire. This is the only channel that reaches an agent whose env and settings were
      // fixed at launch; a settings edit reaches nothing that is already running (see killSwitch.ts).
      return runDisableCli(argv.slice(1))
    case 'enable':
      return runEnableCli()
    case 'telemetry':
      return runTelemetryCli(argv.slice(1))
    case 'setup':
      return runSetupCli(argv.slice(1))
    case 'server':
      await serverCommand(argv.slice(1))
      return 0
    case 'daemon':
      // The always-on ingestion daemon (D3K7QM2P) — same process as `server`, named for its role;
      // adds hook-spool depth to status. `daemon start --supervise` is what launchd runs.
      await daemonCommand(argv.slice(1))
      return 0
    case 'dashboard':
      await ensureServer()
      openDashboard()
      return 0
    case 'cache-expired':
      // "Has MY cache expired — true or false?" The verdict is check_cache_expiry's; this verb is
      // the SHAPE a shell can branch on (one word on stdout, or `-q` for a pure exit-code
      // predicate) plus the project scoping that makes "my" mean this repo and not the busiest one
      // on the machine. It never prints a verdict it could not verify: cannot-answer is exit 2.
      return runCacheExpiredCli(argv.slice(1))
    case 'last-compact':
      // "How long ago did this project compact?" — the age of the newest PreCompact (manual OR
      // auto), read off the hook store, so it answers with the server down. Sibling of
      // cache-expired: the delta on stdout, the WHICH on stderr, and a never-compacted project
      // exits 2 with stdout empty rather than reporting an age of zero.
      return runLastCompactCli(argv.slice(1))
    case 'budget':
      // "Will the rate-limit window outlast this run?" — the preflight + self-updating abort
      // watch for any timed batch. Its exit code IS the interface (0 go / 1 abort / 2 cannot
      // project), so a harness can wire `budget --watch` straight to its own kill path.
      return runBudgetCli(argv.slice(1))
    case 'watch':
      // Generic peak/threshold watcher over ANY usage metric. Sibling of `budget`, not a
      // duplicate of it: budget answers one question and EXITS on the answer; watch observes
      // indefinitely and never stops on an alert.
      return runWatchCli(argv.slice(1))
    case 'heartbeat-cost':
      await runHeartbeatCost(argv.slice(1))
      return 0
    case 'config':
      // Data-retention config (TRDD-ZAV74M8Q): read/write DATA_DIR/config.json directly — no
      // server needed, so it works while the server is down and the values persist across uninstall.
      return runConfigCli(argv.slice(1))
    case 'spool':
      // RAM-disk spool for raw-body capture (TRDD-K3WDPR7M Phase 3). `spool ensure` is what the
      // boot-remount LaunchAgent runs at login — re-create the spool iff capture is on, else no-op.
      return runSpoolCli(argv.slice(1))
    case 'env':
      // Environment/system detection (TRDD-HUWJVQJA): terminal kind, OS, Claude/ai-maestro/CI/
      // container context, filesystem/worktree, network, cloud, tooling, MCP — all client-side, no
      // server. One facet at a time or the whole report; `--out FILE` keeps big reports off stdout.
      return runEnvCli(argv.slice(1))
    case 'ctxmap':
      // What is actually INSIDE a captured request (TRDD-CTXMAP1): every system block, tool schema,
      // message block and named section of an injected context blob, with tokens calibrated to the
      // exact input total from the paired response. Purely local — reads the captured bodies, never
      // the server. This is the only surface that can answer "what is in the context", as opposed to
      // "what did it cost"; the session JSONL records none of it.
      return runCtxmapCli(argv.slice(1))
    case 'ctxvis':
      // The turn-over-turn half of the same question: ctxmap says what is in ONE request, ctxvis
      // says what changed on the agent's SECOND turn and whether that broke the cache prefix —
      // which is what decides whether the agent is cheap to keep running or only cheap to start.
      return runCtxvisCli(argv.slice(1))
    case undefined:
      // Bare `agentlenspro` / `npx agentlenspro`: the original behavior — run the server in
      // the foreground; it serves the dashboard (and opens the browser unless
      // AGENTLENS_OPEN_BROWSER=0). Resolves when the server module loads; the process then
      // stays alive on the server's own listeners.
      await startServer()
      return 0
    default:
      // Everything else — list/help <tool>/call/batch/<tool>/ops flags — is the diagnostics
      // surface (schemas fetched live from the server).
      await runDiagnosticsCli(argv)
      return 0
  }
}
