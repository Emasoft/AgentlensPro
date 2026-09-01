#!/usr/bin/env node
// AgentlensPro — the ONE executable (TRDD-7284WCW7): npx agentlenspro | node standalone/cli.js
//
//   agentlenspro                    → run the server in the foreground (serves the dashboard)
//   agentlenspro <subcommand> …     → setup / server / dashboard / hook / gate / telemetry /
//                                     heartbeat-cost / diagnostics — see src/cli/main.ts
//
// This file is a shim: the entire dispatcher lives in src/cli/main.ts, where BOTH tsc gates
// type-check it. Only the bare-invocation server runner lives here.
import { spawn, exec } from 'child_process'
import { cliMain, exitNow } from '../src/cli/main'
import { EXIT, UsageError } from '../src/cli/cliErrors'
import { alcoreBin, alcoreServeArgs } from '../src/cli/serverControl'

// Bare `agentlenspro` / `npx agentlenspro`: run the Rust server in the foreground, forwarding
// its stdio, and open the browser once it is listening — the same opt-in contract
// standalone/server.ts used to implement (AGENTLENS_OPEN_BROWSER=1 or --open) before it was
// retired (TRDD-1B98LCVR box 4; alcore is the only server left to run here).
function runServerForeground(): Promise<void> {
  const alcore = alcoreBin()
  if (!alcore) {
    const platform = `${process.platform}-${process.arch}`
    throw new Error(
      `No server available for ${platform} — AgentlensPro ships a Rust backend only ` +
      `(bin-native/<platform>-<arch>/alcore), and this platform has no prebuilt binary. ` +
      'Set AGENTLENS_ALCORE to a binary you built yourself, or build one from a git checkout ' +
      '(`cargo build --release --manifest-path rust-core/Cargo.toml -p agentlens-core --bin alcore`).',
    )
  }
  const wantsBrowser = process.env.AGENTLENS_OPEN_BROWSER === '1' || process.argv.includes('--open')
  let opened = !wantsBrowser
  return new Promise((resolve, reject) => {
    const child = spawn(alcore, alcoreServeArgs(), { stdio: ['inherit', 'pipe', 'inherit'] })
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk)
      if (!opened && /UI\/API listening/.test(chunk.toString())) {
        opened = true
        const url = `http://localhost:${process.env.UI_PORT ?? '3000'}`
        const cmd = process.platform === 'darwin' ? `open "${url}"`
                  : process.platform === 'win32' ? `start "" "${url}"`
                  : `xdg-open "${url}"`
        exec(cmd, (err) => { if (err) console.log(`\nOpen ${url} in your browser\n`) })
      }
    })
    child.on('error', reject)
    child.on('exit', (code) => { process.exitCode = code ?? 0; resolve() })
  })
}

cliMain(process.argv.slice(2), runServerForeground)
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
