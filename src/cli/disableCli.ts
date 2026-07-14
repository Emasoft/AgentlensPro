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

  console.log('AgentlensPro is now DISABLED.')
  console.log(`  flag:   ${p}`)
  console.log(`  server: ${stopped}`)
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
