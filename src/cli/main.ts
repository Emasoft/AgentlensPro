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
import { runReviewGate } from './reviewGate'
import { runReviewSupervisor } from './reviewSupervisor'
import { runDelegateGateCli } from './delegateGate'
import { runHeartbeatCost } from './heartbeatCostCli'
import { runConfigCli } from './configCli'
import { runStoreCli } from './storeAdmin'
import { runEnvCli } from './envCli'
import { runDisableCli, runEnableCli } from './disableCli'
import { ensureServer, openDashboard, serverCommand, daemonCommand } from './serverControl'
import { runSetupCli } from './setup'
import { autoSetupOnServerStart, forceInstallTelemetry, maybeAutoSetup } from './autoSetup'
import { disabledNotice, isAllAccountsStatus } from './foreignTelemetry'
import { beginLaunchNotices, endLaunchNotices, flushNoticesToStderr } from './launchNotices'
import { runBudgetCli } from './budgetCli'
import { runWatchCli } from './watchCli'
import { runCtxmapCli } from './ctxmapCli'
import { runCtxvisCli } from './ctxvisCli'
import { runStatuslineCommand } from './statuslineCapture'
import { runStatuslineHistoryCli } from './statuslineHistoryCli'
import { runAllAccountsCli } from './allAccountsCli'
import { runCacheExpiredCli } from './cacheExpiredCli'
import { runCacheStateCli } from './cacheStateCli'
import { runLastCompactCli } from './lastCompactCli'
import { runModelHeadroomCli } from './modelHeadroomCli'
import { runSearchCli } from './searchCli'
import { runHookContextCostCli } from './hookContextCostCli'

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
  // Not run by Claude Code, but polled in loops by agents and heartbeats, and documented to answer with the
  // server DOWN. cache-state and last-compact read only local files; cache-expired queries the server over MCP
  // when no harness-reported sample exists, bounded by the connect deadline (cliCore.ts CONNECT_TIMEOUT_MS,
  // 800 ms), and its budget covers that wait. None of them may run the launch self-heal (READ_ONLY_VERBS;
  // autoSetup.test.ts pins every key here to AUTOSETUP_EXCLUDED_VERBS).
  'cache-expired': 1_500,
  'cache-state': 1_500,
  'last-compact': 1_500,
}

// Every verb the dispatch switch below owns (i.e. NOT a server-side diagnostics tool), plus the
// listing verb. The help intercept keys on this: `<verb> --help` for these prints the static
// USAGE with zero network I/O, while an unknown name is presumed a diagnostics tool whose real
// help lives in the server's schema. Keep in lockstep with the switch — a verb added there but
// not here still gets safe help (USAGE covers it), just after one wasted server probe.
export const MANAGEMENT_VERBS: ReadonlySet<string> = new Set([
  'hook', 'gate', 'review-gate', 'review-supervisor', 'delegate-gate', 'statusline', 'statusline-history', 'get_account_status', 'disable', 'enable',
  'telemetry', 'setup', 'server', 'daemon', 'dashboard', 'cache-expired', 'cache-state', 'last-compact',
  'budget', 'watch', 'heartbeat-cost', 'config', 'env', 'ctxmap', 'ctxvis', 'list',
  'search', 'model-headroom', 'hook-context-cost',
])

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
  env: 'environment detection report; a diagnostic a human reads',
  ctxmap: 'decomposes captured request bodies with real token counting — inherently slow, and asked once',
  ctxvis: 'SPAWNS an agent and measures two of its turns; it is the slowest verb we ship, deliberately',
  search: 'an investigation verb a human or agent invokes deliberately; DuckDB streams a possibly-60MB transcript',
  'review-gate': 'a Stop/SubagentStop hook that never touches the network — it reads a local transcript tail off disk, so the DROP-address hang this table guards against cannot occur here',
  'delegate-gate': 'a PreToolUse hook that never touches the network — it reads a local transcript tail off disk, same as review-gate',
  'review-supervisor': 'a UserPromptSubmit metahook over the review gate — reads a transcript tail and the settings cascade off disk, no network',
  'model-headroom': 'FETCHES the OAuth usage endpoint (10-minute cached), so it is network-bound by design and cannot carry a hot-path ceiling. It is not on any per-turn path: an agent calls it ONCE before deciding whether to spawn the advisor, which is itself a minutes-long operation — the check cannot be the expensive half',
  store: 'operator repair verb (repair-parked STAGES and fully re-verifies the whole bodies table) — run with the server stopped, a human watching',
  'hook-context-cost': 'an analysis verb that streams the day buckets of the log-event sink (~170 MB/day); asked deliberately, never per turn',
}

/** Test seams for the server/daemon verbs — the verb itself and the install check that follows it — so a test can
 *  prove the wiring (the check runs, and runs AFTER the verb) without spawning a collector; and for the launch check
 *  and the diagnostics surface, so a test can prove WHEN the launch notices print (TRDD-YL3EWT6N item 7) without a
 *  server or a real install. Production passes none. */
export interface CliMainDeps {
  serverCommand?: (argv: string[]) => Promise<void>
  daemonCommand?: (argv: string[]) => Promise<void>
  serverStartCheck?: (argv: string[]) => Promise<void>
  launchCheck?: (argv: string[]) => Promise<number | null>
  diagnostics?: (argv: string[]) => Promise<void>
}

/** Every verb the dispatch switch in cliMainBody handles itself; any other name falls to its `default`, the
 *  diagnostics surface. Pinned to the switch's `case` labels by a test (autoSetup.test.ts), so a new case cannot be
 *  missed here — a miss would hold that verb's launch notices until it returns, or forever if it never does. */
export const DISPATCHED_VERBS: ReadonlySet<string> = new Set([
  'hook', 'gate', 'review-gate', 'review-supervisor', 'delegate-gate', 'statusline', 'statusline-history',
  'get_account_status', 'disable', 'enable', 'telemetry', 'setup', 'server', 'daemon', 'dashboard', 'cache-expired',
  'cache-state', 'last-compact', 'model-headroom', 'hook-context-cost', 'search', 'budget', 'watch',
  'heartbeat-cost', 'config', 'store', 'env', 'ctxmap', 'ctxvis',
])

/** Does this invocation go to the diagnostics surface (runDiagnosticsCli) — the only place a tool can refuse? */
function reachesDiagnosticsSurface(cmd: string | undefined, argv: string[]): boolean {
  if (cmd === undefined) return false // the bare foreground server
  // only the plural form is file-backed; a read must never be blocked by the brake or write settings (owner directive 2026-10-29)
  if (cmd === 'get_account_status') return !isAllAccountsStatus(argv)
  return !DISPATCHED_VERBS.has(cmd)
}

// The CLI dispatcher. `deps` is a test seam only (CliMainDeps); production calls it with two arguments.
export async function cliMain(rawArgv: string[], startServer: () => Promise<unknown>, deps: CliMainDeps = {}): Promise<number> {
  // The launch install check's notices belong to THIS invocation only (launchNotices.ts, TRDD-YL3EWT6N item 7):
  // reset first, so an earlier in-process call can never leak lines in; and whatever is still held when the verb
  // returns — not printed on entry, not folded into a refusal — prints now, after the verb's own output. Then the
  // invocation ends: a notice pushed outside it prints at once instead of waiting in a buffer nobody flushes.
  beginLaunchNotices()
  try {
    return await cliMainBody(rawArgv, startServer, deps)
  } finally {
    flushNoticesToStderr()
    endLaunchNotices()
  }
}

async function cliMainBody(rawArgv: string[], startServer: () => Promise<unknown>, deps: CliMainDeps): Promise<number> {
  // `--force-install-telemetry` is a GLOBAL, per-invocation flag (owner order 2026-10-02): consumed here, before
  // any verb parses its own flags, so no verb ever sees it and nothing persists it.
  const forceInstall = rawArgv.includes('--force-install-telemetry')
  const argv = rawArgv.filter(a => a !== '--force-install-telemetry')
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
  //
  // Management verbs answer from USAGE without touching ANY socket (PR-15 review): the first cut
  // routed every `X --help` through the diagnostics help path, which initializes the MCP client —
  // so `disable --help` against an accept-then-hang server waited on the network to print static
  // text. Only a name that is NOT a management verb (i.e. a diagnostics tool) tries the schema
  // help, and only because that help genuinely lives in the server's live schema; a down or slow
  // server falls back to USAGE via the client's own connect deadline.
  if (argv.some(a => a === '--help' || a === '-h')) {
    if (cmd && !cmd.startsWith('-') && !MANAGEMENT_VERBS.has(cmd)) {
      try {
        await runDiagnosticsCli(['help', cmd])
        return 0
      } catch { /* not a known tool, or no server — the global usage below covers the verbs */ }
    }
    console.log(USAGE)
    return 0
  }

  // `help <verb>` is the SAME question as `<verb> --help`, so it must get the same answer. It did
  // not: every management verb fell through to the diagnostics path, which resolves a name against
  // the server's live TOOL schema, and failed with `unknown tool "budget" (agentlenspro list)`.
  // The remedy that message names leads nowhere either — `list` enumerates diagnostics tools only,
  // never CLI verbs — so the user is told to run the one command that cannot answer them. CLAUDE.md
  // documents `agentlenspro help <tool>`, which makes generalizing it to a verb the natural move.
  //
  // Answered from static USAGE with no socket, exactly as the `--help` branch above does, so a down
  // or wedged server cannot turn a help request into a wait. Only a KNOWN management verb
  // short-circuits: an unrecognized name must keep falling through to the diagnostics lookup and
  // fail loudly, or a typo would be answered with usage and a success code — which is worse than
  // the dead-end it replaced, because nothing tells the user the name was wrong.
  if (cmd === 'help' && argv[1] !== undefined && MANAGEMENT_VERBS.has(argv[1])) {
    console.log(USAGE)
    return 0
  }

  // The install heals itself at every launch (owner order 2026-10-02, TRDD-AGZ0XZKW): missing or stale
  // skills/agents/hooks/telemetry env are restored here, AFTER the describe-only paths above (help and
  // version never mutate anything) and BEFORE the verb runs. Silent when current. A non-null result is
  // an exit code: another telemetry setup is in place, so the verb must not run (autoSetup.ts).
  if (forceInstall) {
    // `--force-install-telemetry` = enable + overwrite + full restore (autoSetup.ts), then the verb. Alone, with no
    // verb, it only reports what it did — it must not start the foreground server.
    const code = await forceInstallTelemetry(cmd ?? '')
    if (code !== null) return code
    if (cmd === undefined) return 0
  } else {
    const blocked = await (deps.launchCheck ?? maybeAutoSetup)(argv)
    // A non-null code means the check STOPPED the verb (another telemetry setup is in place): its held lines are the
    // reason, and the finally in cliMain prints them on the way out — no verb output can come before them.
    if (blocked !== null) return blocked
  }

  // Disabled (kill-switch flag or AGENTLENS_DISABLED): say so, name the reactivation command, exit
  // EXIT.DISABLED without running the verb (owner order 2026-10-02) — written for an agent as much as a
  // human. After maybeAutoSetup on purpose: a switch armed for foreign telemetry is lifted there once that
  // setup is gone. Hook-path verbs, enable/disable/setup and `server status` pass through.
  const disabled = disabledNotice(argv)
  if (disabled) {
    flushNoticesToStderr() // the launch check's lines came first; keep that order
    console.error(disabled.text)
    return disabled.code
  }

  // ONE decision for the launch notices (launchNotices.ts, TRDD-YL3EWT6N item 7): only the diagnostics surface can end
  // in a tool refusal, whose stderr must be exactly one JSON object, so only there do they wait (runDiagnosticsCli
  // folds them into a refusal or prints them for its own non-tool sub-commands). Every other verb prints them now,
  // BEFORE it runs, exactly as before — including the ones that never return (watch, budget --watch, the bare
  // foreground server), which would otherwise hold them forever.
  if (!reachesDiagnosticsSurface(cmd, argv)) flushNoticesToStderr()
  switch (cmd) {
    case 'hook':
      return exitNow(await runHookCommand('hook'))
    case 'gate':
      return exitNow(await runHookCommand('gate'))
    case 'review-gate':
      // The adversarial-review Stop/SubagentStop gate — local-only, no network round trip.
      return exitNow(await runReviewGate(argv.slice(1)))
    case 'review-supervisor':
      // The METAHOOK: watches whether the review gate is actually running and warns the user AND the
      // agent when it is not. Never blocks; runs on a different event than the gate, so a gate that
      // has gone silent is exactly the condition it still catches.
      return exitNow(await runReviewSupervisor())
    case 'delegate-gate':
      // Fable plans, Sonnet executes (owner order 2026-09-10) — PreToolUse, local-only, no
      // network round trip, same shape as review-gate.
      return exitNow(await runDelegateGateCli())
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
      // Only the PLURAL form short-circuits the server. `--all` is assembled from files (the
      // account-state timeline + the per-account usage archive) plus one probe per owner-supplied long-lived key (src/longOAuthKeys.ts); it needs no server, and its whole audience is a rotator
      // deciding what to do about a wedged machine — where proxying to a server that may itself be
      // down turns the one useful answer into "cannot reach localhost:4316". The singular form still
      // goes over the wire: it needs the live session accessors, which only the server has.
      if (isAllAccountsStatus(argv)) return await runAllAccountsCli(argv.slice(1))
      // Not `--all`: fall through to the diagnostics surface, which proxies it to the server.
      await (deps.diagnostics ?? runDiagnosticsCli)(argv)
      return 0
    case 'disable':
      // THE GLOBAL BRAKE. Arms <dataDir>/DISABLED, which disarms every hook, the burn-gate, server
      // auto-revive and all background ingestion — in EVERY Claude session already running, on its
      // next hook fire. This is the only channel that reaches an agent whose env and settings were
      // fixed at launch; a settings edit reaches nothing that is already running (see killSwitch.ts).
      return runDisableCli(argv.slice(1))
    case 'enable':
      return runEnableCli(forceInstall)
    case 'telemetry':
      return runTelemetryCli(argv.slice(1))
    case 'setup':
      return runSetupCli(argv.slice(1), forceInstall)
    case 'server':
      // The install heals itself when the server is STARTED too (owner 2026-10-14, TRDD-YL3EWT6N): `server` is excluded
      // from maybeAutoSetup above because hooks reach it, so `start`/`restart` run the check here. `revive` (the hook
      // path) does not. The check runs AFTER the verb, never before it: run first, every millisecond of it (drift
      // hashing, a safeConfigEdit subprocess under a lock, a synchronous `--version` probe) was collector downtime, and
      // run "concurrently" its synchronous prefix would still execute before the verb's first await. `start`/`restart`
      // resolve once the server answers; `--supervise` resolves once the child is spawned. Never throws.
      await (deps.serverCommand ?? serverCommand)(argv.slice(1))
      await (deps.serverStartCheck ?? autoSetupOnServerStart)(argv)
      return 0
    case 'daemon':
      // The always-on ingestion daemon (D3K7QM2P) — same process as `server`, named for its role;
      // adds hook-spool depth to status. `daemon start --supervise` is what launchd runs.
      // `daemon start|restart` (incl. the launchd `daemon start --supervise`) is a server start: same check as `server`,
      // after the verb for the same reason.
      await (deps.daemonCommand ?? daemonCommand)(argv.slice(1))
      await (deps.serverStartCheck ?? autoSetupOnServerStart)(argv)
      return 0
    case 'dashboard':
      await ensureServer('dashboard')
      openDashboard()
      return 0
    case 'cache-expired':
      // "Has MY cache expired — true or false?" The verdict is check_cache_expiry's; this verb is
      // the SHAPE a shell can branch on (one word on stdout, or `-q` for a pure exit-code
      // predicate) plus the project scoping that makes "my" mean this repo and not the busiest one
      // on the machine. It never prints a verdict it could not verify: cannot-answer is exit 2.
      return runCacheExpiredCli(argv.slice(1))
    case 'cache-state':
      // "Is MY cache warm or cold RIGHT NOW?" — the same harness-reported row cache-expired reads,
      // projected to one word with the predicate exit codes (0 warm / 1 cold / 2 cannot answer).
      // Disk-only, never the server: a session with no recent sample is exit 2, never `cold`.
      return runCacheStateCli(argv.slice(1))
    case 'last-compact':
      // "How long ago did this project compact?" — the age of the newest PreCompact (manual OR
      // auto), read off the hook store, so it answers with the server down. Sibling of
      // cache-expired: the delta on stdout, the WHICH on stderr, and a never-compacted project
      // exits 2 with stdout empty rather than reporting an age of zero.
      return runLastCompactCli(argv.slice(1))
    case 'model-headroom':
      // "Is THIS model's own weekly window spent?" — a per-model sibling of cache-expired, for the
      // models metered separately from weekly_all (Fable). Exists so an agent can decide whether
      // consulting the advisor is even possible BEFORE spawning it: the aggregate window cannot
      // answer that, and spawning against an exhausted window costs the full wait for a verdict
      // that never arrives. Same contract as its siblings — one word, and cannot-answer is exit 2,
      // never a confident `ok`.
      return runModelHeadroomCli(argv.slice(1))
    case 'hook-context-cost':
      // "How much text do my hooks inject?" — sums the hook_execution_complete size attributes
      // (CC ≥2.1.280) from the gated-out log-event sink, disk-only (TRDD-ZQQYRYBO I15).
      return runHookContextCostCli(argv.slice(1))
    case 'search':
      // Grep a session's transcript jsonl (tool outputs, agent responses) via DuckDB's streaming
      // NDJSON reader (TRDD-P31SWA8I). Disk-only — works with the server down, like its siblings.
      return runSearchCli(argv.slice(1))
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
    case 'store':
      // Durable-store administration (TRDD-8TM7I49X): `store repair-parked` repairs the ts rows
      // permanently-parked bodies were parked for (from their files' own mtimes, via the full
      // staged-migration protocol) and unparks them through the alstore flock.
      return runStoreCli(argv.slice(1))
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
      await (deps.diagnostics ?? runDiagnosticsCli)(argv)
      return 0
  }
}
