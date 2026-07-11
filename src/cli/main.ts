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

import * as fs from 'fs'
import * as path from 'path'
import { runTelemetryCli } from '../telemetryConfig'
import { runDiagnosticsCli, USAGE } from './diagnosticsCli'
import { runHookCommand } from './hookHandlers'
import { runHeartbeatCost } from './heartbeatCostCli'
import { ensureServer, openDashboard, serverCommand } from './serverControl'
import { runSetupCli } from './setup'

/** The package version, read from the package.json that ships next to the bundle. Walks up
 *  from __dirname because the bundle lives at <pkg>/standalone/cli.js while the test build
 *  lives at <repo>/out/test/cli/ — a fixed ../package.json would be wrong in one of them. */
export function packageVersion(): string {
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string; version?: string }
      if (pkg.name === 'agentlenspro' && pkg.version) return pkg.version
    } catch { /* not here — keep walking */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`cannot locate the agentlenspro package.json above ${__dirname}`)
}

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
    case 'telemetry':
      return runTelemetryCli(argv.slice(1))
    case 'setup':
      return runSetupCli(argv.slice(1))
    case 'server':
      await serverCommand(argv.slice(1))
      return 0
    case 'dashboard':
      await ensureServer()
      openDashboard()
      return 0
    case 'heartbeat-cost':
      await runHeartbeatCost(argv.slice(1))
      return 0
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
