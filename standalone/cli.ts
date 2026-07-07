#!/usr/bin/env node
// AgentLens standalone CLI — run with: bunx agentlens  |  npx agentlens  |  node standalone/cli.js
//
//   agentlens                                     → start the dashboard server (default)
//   agentlens telemetry install|uninstall|status  → manage Claude Code full-telemetry config
//
// The server module (./server) has top-level side effects (it binds ports on load), so it is
// imported DYNAMICALLY only on the default path — a telemetry subcommand must never start it.
import { runTelemetryCli } from '../src/telemetryConfig'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv[0] === 'telemetry') {
    process.exit(await runTelemetryCli(argv.slice(1)))
  }
  await import('./server')
}

main()
