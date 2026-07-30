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

/** CLI entry. `startServer` lazily imports standalone/server (injected by the shim — src/
 *  cannot import standalone/ without inverting the build layering). Returns the exit code. */
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

  switch (cmd) {
    case 'hook':
      return runHookCommand('hook')
    case 'gate':
      return runHookCommand('gate')
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
