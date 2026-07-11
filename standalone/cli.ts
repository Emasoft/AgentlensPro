#!/usr/bin/env node
// AgentlensPro — the ONE executable (TRDD-7284WCW7): npx agentlenspro | node standalone/cli.js
//
//   agentlenspro                    → run the server in the foreground (serves the dashboard)
//   agentlenspro <subcommand> …     → setup / server / dashboard / hook / gate / telemetry /
//                                     heartbeat-cost / diagnostics — see src/cli/main.ts
//
// This file is a shim: the entire dispatcher lives in src/cli/main.ts, where BOTH tsc gates
// type-check it. Only the server loader lives here, because src/ cannot import standalone/.
// The server module (./server) has top-level side effects (it binds ports on load), so it is
// injected as a LAZY loader, executed ONLY on the bare no-args path, and marked external in
// esbuild.js — cli.js requires the sibling server.js bundle at runtime instead of inlining a
// second copy of the whole server.
import { cliMain } from '../src/cli/main'

cliMain(process.argv.slice(2), () => import('./server'))
  .then(code => { process.exitCode = code })
  .catch(e => {
    console.error(`FAIL: ${(e as Error).message}`)
    process.exit(1)
  })
