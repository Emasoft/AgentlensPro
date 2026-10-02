// `agentlenspro disable` / `agentlenspro enable` — the global brake (TRDD-K3WDPR7M).
//
// The 2026-07-14 SSD incident is the whole reason this exists: raw-body capture was burning ~35 GB/day,
// and there was NO way to stop it across the machine. Editing settings.json stopped ZERO of the 13
// Claude sessions that had loaded the config days earlier; killing the server was futile because the
// next hook resurrected it; and AGENTLENS_GATE=off could not be retrofitted onto a running agent
// (a hook inherits CLAUDE's env, not the operator's). A flag FILE is the only channel that reaches
// every already-running session, because every hook is a fresh process that re-reads the disk.
import * as path from 'path'
import { killSwitchPath, agentlensDisabled } from './killSwitch'
import { disableAgentlensSurfaces, enableAgentlensSurfaces } from './surfaces'
import { AutoSetupDeps, ensureInstalled } from './autoSetup'
import { findServerPid, stopServer } from './serverControl'
import { dataDir } from './cliCore'
import { EXIT } from './cliErrors'
import { RAW_BODIES_KEY } from '../captureConfig'
import { removeRawBodiesKey } from '../telemetryConfig'

export async function runDisableCli(args: string[]): Promise<number> {
  const reason = args.filter(a => !a.startsWith('-')).join(' ') || undefined
  // Kill-switch AND the skills/rules move together (owner order 2026-10-02): one function, so the two
  // can never disagree. The agents stay installed — they do not depend on the CLI.
  const { flag: p, moved } = disableAgentlensSurfaces(reason)

  // Arming the flag stops hooks from SPAWNING a server, but a server already running would keep
  // ingesting — "disabled" would be a lie. Stop it too, so the state the user asked for is the state
  // they get. Best-effort: a server we cannot stop is reported, never silently ignored.
  let stopped = 'no server was running'
  if (await findServerPid() !== null) {   // async — awaiting it is what makes the check real
    try {
      await stopServer()
      stopped = (await findServerPid()) === null
        ? 'running server stopped'
        : 'WARNING: server did not stop — kill it manually'
    } catch (e) {
      stopped = `WARNING: could not stop the server (${(e as Error).message}) — kill it manually`
    }
  }

  // The single biggest write AgentlensPro causes is not one WE make — it is the one we ASK Claude
  // Code to make: OTEL_LOG_RAW_API_BODIES makes it dump the whole conversation to disk on every
  // request (~35 GB/day, TRDD-K3WDPR7M). A kill-switch that stops our server but leaves that key in
  // settings.json would still be burning the disk, so "disabled" would be a lie. Raw capture is mandatory
  // for an ENABLED install (owner reversal 2026-10-02), so this is a deliberate emergency strip that
  // `agentlenspro enable` + the next launch undo.
  let capture = 'raw-body key was not set'
  try {
    capture = (await removeRawBodiesKey())
      ? 'raw-body key removed from settings.json (restart Claude sessions to stop them writing); re-added after `agentlenspro enable`'
      : 'raw-body key was not set'
  } catch (e) {
    // Never fail the kill-switch on this: the flag is already armed and the server already stopped.
    // Report loudly instead of silently leaving the user believing the burn is off.
    capture = `WARNING: could not remove ${RAW_BODIES_KEY} (${(e as Error).message}) — remove it from settings.json by hand`
  }

  console.log('AgentlensPro is now DISABLED.')
  console.log(`  flag:    ${p}`)
  console.log(`  server:  ${stopped}`)
  console.log(`  capture: ${capture}`)
  console.log(`  skills:  ${moved.length ? `${moved.length} moved to ${path.join(dataDir(), 'disabled-surfaces')} (agents stay installed)` : 'none were installed'}`)
  console.log('')
  console.log('  Every hook, the burn-gate, auto-revive and background ingestion are OFF —')
  console.log('  in every Claude session already running, from its next hook fire. No restart needed.')
  console.log('')
  console.log('  Re-enable with:  agentlenspro enable')
  // The flag is armed either way (the brake IS on for AgentlensPro's own hooks), but if we could not
  // stop a running server OR strip the capture key, the ~35 GB/day burn may still be flowing. A script
  // that keys on the exit code to confirm "the burn is stopped" must NOT read that as success.
  const partialFailure = stopped.startsWith('WARNING') || capture.startsWith('WARNING')
  return partialFailure ? EXIT.ABORT : EXIT.OK
}

export async function runEnableCli(forceInstall = false, deps: AutoSetupDeps = {}): Promise<number> {
  // Steps 1-2 of the shared order (autoSetup.ts ensureInstalled): the telemetry verdict FIRST — a company
  // setup still in place re-disables agentlenspro and refuses; only an absent/ours verdict goes on to
  // restore anything. Only then is the switch lifted below.
  const blocked = await ensureInstalled('enable', 'enable', { ...deps, forceInstall })
  if (blocked !== null) return blocked
  if (!agentlensDisabled()) {
    console.log('AgentlensPro is already enabled (no kill-switch flag present).')
    return EXIT.OK
  }
  // An env-set AGENTLENS_DISABLED cannot be cleared by deleting a file — say so, and return non-zero
  // (cannot-answer) rather than claim a success the user will not observe: the flag is gone but every
  // process inheriting the env stays disabled, so "enable" did not achieve what was asked.
  if (process.env.AGENTLENS_DISABLED === '1') {
    enableAgentlensSurfaces()
    console.log('Removed the kill-switch flag, but AGENTLENS_DISABLED=1 is set in this environment —')
    console.log('AgentlensPro stays disabled for any process that inherits it. Unset it to re-enable.')
    return EXIT.UNKNOWN
  }
  // Disarm AND put the parked skills back — the mirror of disableAgentlensSurfaces.
  const { restored } = enableAgentlensSurfaces()
  console.log('AgentlensPro is now ENABLED.')
  console.log(`  removed: ${killSwitchPath()}`)
  if (restored.length > 0) console.log(`  skills:  ${restored.length} restored to their place`)
  console.log('  Hooks resume on their next fire; the server is revived by the next hook.')
  return EXIT.OK
}
