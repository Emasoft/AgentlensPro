// `agentlenspro disable` / `agentlenspro enable` — the global brake (TRDD-K3WDPR7M).
//
// The 2026-07-14 SSD incident is the whole reason this exists: raw-body capture was burning ~35 GB/day,
// and there was NO way to stop it across the machine. Editing settings.json stopped ZERO of the 13
// Claude sessions that had loaded the config days earlier; killing the server was futile because the
// next hook resurrected it; and AGENTLENS_GATE=off could not be retrofitted onto a running agent
// (a hook inherits CLAUDE's env, not the operator's). A flag FILE is the only channel that reaches
// every already-running session, because every hook is a fresh process that re-reads the disk.
import { armKillSwitch, disarmKillSwitch, killSwitchPath, agentlensDisabled } from './killSwitch'
import { findServerPid, stopServer } from './serverControl'
import { dataDir } from './cliCore'
import { setRawBodyCapture, rawBodyCaptureEnabled, RAW_BODIES_KEY } from '../captureConfig'
import { ensureTelemetryConfig } from '../telemetryConfig'

export async function runDisableCli(args: string[]): Promise<number> {
  const reason = args.filter(a => !a.startsWith('-')).join(' ') || undefined
  const p = armKillSwitch(reason)

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
  // settings.json would still be burning the disk, so "disabled" would be a lie. Turn capture off
  // durably (so no later server boot re-arms it) and strip the key now.
  let capture = 'raw-body capture was already off'
  try {
    if (rawBodyCaptureEnabled(dataDir(), process.env)) {
      setRawBodyCapture(dataDir(), false)
    }
    const r = await ensureTelemetryConfig({ captureRawBodies: false })
    capture = r.removed.includes(RAW_BODIES_KEY)
      ? 'raw-body capture OFF — key removed from settings.json (restart Claude sessions to stop them writing)'
      : 'raw-body capture was already off'
  } catch (e) {
    // Never fail the kill-switch on this: the flag is already armed and the server already stopped.
    // Report loudly instead of silently leaving the user believing the burn is off.
    capture = `WARNING: could not remove ${RAW_BODIES_KEY} (${(e as Error).message}) — remove it from settings.json by hand`
  }

  console.log('AgentlensPro is now DISABLED.')
  console.log(`  flag:    ${p}`)
  console.log(`  server:  ${stopped}`)
  console.log(`  capture: ${capture}`)
  console.log('')
  console.log('  Every hook, the burn-gate, auto-revive and background ingestion are OFF —')
  console.log('  in every Claude session already running, from its next hook fire. No restart needed.')
  console.log('')
  console.log('  Re-enable with:  agentlenspro enable')
  return 0
}

export function runEnableCli(): number {
  if (!agentlensDisabled()) {
    console.log('AgentlensPro is already enabled (no kill-switch flag present).')
    return 0
  }
  // An env-set AGENTLENS_DISABLED cannot be cleared by deleting a file — say so rather than claim a
  // success the user will not observe.
  if (process.env.AGENTLENS_DISABLED === '1') {
    disarmKillSwitch()
    console.log('Removed the kill-switch flag, but AGENTLENS_DISABLED=1 is set in this environment —')
    console.log('AgentlensPro stays disabled for any process that inherits it. Unset it to re-enable.')
    return 0
  }
  disarmKillSwitch()
  console.log('AgentlensPro is now ENABLED.')
  console.log(`  removed: ${killSwitchPath()}`)
  console.log('  Hooks resume on their next fire; the server is revived by the next hook.')
  return 0
}
