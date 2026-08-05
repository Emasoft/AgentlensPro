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
import { cliMain, exitNow } from '../src/cli/main'
import { EXIT, UsageError } from '../src/cli/cliErrors'

cliMain(process.argv.slice(2), () => import('./server'))
  // `code || process.exitCode` and not a bare assignment: a command that COMPLETED (returns 0) may
  // still have refused to answer, and it records that by setting process.exitCode as it prints the
  // refusal (see emit() — issue #9 §1). Overwriting with the returned 0 would republish "success"
  // for a payload the CLI just told the caller not to parse. An explicit non-zero return still wins.
  .then(code => { process.exitCode = code || process.exitCode || 0 })
  .catch(e => {
    console.error(`FAIL: ${(e as Error).message}`)
    // EX_USAGE for a caller mistake, 1 only for a runtime failure: 1 doubles as the watchers'
    // ABORT signal, so a typo'd tool name or flag must never read as a legitimate abort — and
    // the tool help has promised "64 = bad command line" since issue #9.
    //
    // exitNow, NOT process.exit: a command can have written a large payload to stdout and THEN
    // failed (a report streamed out, an error on the way to finishing), and `process.exit()`
    // DISCARDS a queued pipe write past the ~64 KiB buffer — measured, 262,144 written and 65,536
    // received. A consumer would then get a truncated payload alongside a non-zero exit, which
    // reads as a corrupt result rather than a clean failure. exitNow flushes first and BOUNDS the
    // flush, so a reader that never drains cannot turn this into a hang (TRDD-E8XIC2PM).
    void exitNow(e instanceof UsageError ? EXIT.USAGE : 1)
  })
