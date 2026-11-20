// src/cli/foreignTelemetry.ts — what agentlenspro does when ANOTHER telemetry setup is in place
// (owner orders 2026-10-02, TRDD-AGZ0XZKW).
//
// Without its own telemetry and raw body dumps agentlenspro is non-functional, so it cannot carry on
// beside a company gateway: it arms the kill-switch with FOREIGN_REASON when no switch stands (disableForForeignTelemetry;
// agents stay, and skills are parked). `--force-install-telemetry` or a manual removal of the foreign
// setup undoes it: the next launch repairs, and disarms the switch ONLY when it was armed for this reason — an
// operator-armed `agentlenspro disable` is never touched by a launch, `setup` or --force-install-telemetry (D10, D17). The
// one exception is the operator's own `enable` (runEnableCli): it records the lift as FOREIGN_REASON, so the switch lifts
// by itself once the foreign setup is gone. The switch refuses no verb; it stops only collection (killSwitch.ts).

import * as fs from "fs"
import { dataDir } from "./cliCore"
import { killSwitchPath } from "./killSwitch"
import { SurfaceDirs, defaultSurfaceDirs, enableAgentlensSurfaces, parkForForeign } from "./surfaces"

export const FOREIGN_REASON = "foreign telemetry configuration present — run with --force-install-telemetry"

/** Verbs Claude Code runs inside a turn under a timeout. Each handles the switch itself (killSwitch.ts)
 *  and stays silent (a message there would land inside the session); review-gate and review-supervisor ignore it. None of them is auto-repaired (a repair would blow their deadline). */
export const HOOK_PATH_VERBS: ReadonlySet<string> = new Set([
  "hook", "gate", "review-gate", "review-supervisor", "delegate-gate", "statusline",
])

/** Read-only diagnostics other tools poll from their hooks and loops: they never write user config, and may query
 *  the running server read-only (cache-expired asks it over MCP when no harness-reported sample exists), so they
 *  skip the per-launch check — a diagnostic call must never write settings.json.
 *  WHY cache-expired is here (TRDD-CS2W7E77): 896be44a excluded this class because a read must never write
 *  settings.json, and cache-expired was missed. So on a fresh machine a polled `agentlenspro cache-expired` ran a
 *  full first-run setup that wrote settings, hooks and telemetry env and could start a server. Found by the CLI
 *  hot-path latency guard in gate run B2.
 *
 *  The disk monitor (TRDD-HTARKH87) is exempt as a whole, BY OWNER DECISIONS 2026-11-16 ("Exempt the sampler"; "Install, even when
 *  DISABLED (Recommended)"): disk-sample, disk, disk-watch and disk-monitor (install, uninstall, status). A filling disk is exactly
 *  when everything else is switched off. All of them also skip the launch self-heal: the sampler fires every 5 minutes and must never
 *  write settings.json. */
// `search` (owner, 2026-11-18: «disable must disable only telemetry and event hooks logs, not jsonl parsing by duckdb»): it reads the
// project transcripts off disk with DuckDB, needs no server and writes no user config, so the launch self-heal never runs for it.
export const READ_ONLY_VERBS: ReadonlySet<string> = new Set(["cache-expired", "cache-state", "last-compact", "model-headroom", "statusline-history", "disk-sample", "disk", "disk-watch", "disk-monitor", "search"])

/** `get_account_status --all` — the PLURAL form, assembled from files (account-state timeline + per-account
 *  usage archive) plus one probe per owner-supplied long-lived key (src/longOAuthKeys.ts); it needs no server and writes no user config (main.ts case get_account_status). ONE rule shared by the dispatcher (no server proxy)
 *  and the launch self-heal. WHY: a read must never trigger
 *  writes to user config — owner directive 2026-10-29: "are you saying that in reduced mode you cannot determine the
 *  accounts status?? this is bad. fix this." The singular form needs the server and is NOT covered. Any position of
 *  `--all` counts (same rule main.ts always applied). */
export function isAllAccountsStatus(argv: string[]): boolean {
  return argv[0] === "get_account_status" && argv.includes("--all")
}

/** Is the kill-switch of `dir` armed, and for THIS reason? (A missing/unreadable flag reads as no.)
 *  WHY `dir` (TRDD-RBBEX59R R1): setup and auto-repair converge ctx.dataDir, which can differ from the env default; the
 *  foreign check must read the flag of the dir being converged. One `Reason:` parser (recordedReason) for both readers. */
export function killSwitchArmedForForeign(dir: string = dataDir()): boolean {
  return recordedReason(dir) === FOREIGN_REASON
}

/** The foreign-telemetry stop: parks the skills ALWAYS and arms FOREIGN_REASON when no flag stands in dirs.dataDir, or when
 *  `opts.replaceReason` is set (see parkForForeign in surfaces.ts for the WHY of both). Only the operator's `enable`
 *  (runEnableCli) sets replaceReason: it records the operator's lift as FOREIGN_REASON, so the lift waits for the foreign
 *  setup to go. `armed` is "this call wrote the flag (it was absent, or the caller asked to replace it)"; false means a
 *  switch already stood and its reason was kept, NEVER "not foreign": no caller may read it as that (both callers keep
 *  parking, keep their refusal and message).
 *  WHY replaceReason is dropped when the flag already carries FOREIGN_REASON (TRDD-RBBEX59R d2): rewriting it records nothing
 *  new and bumps the flag's mtime, which step (e) reads as "armed at"; a refused `enable` repeated against the same foreign
 *  setup must leave the original arming time alone. */
export function disableForForeignTelemetry(dirs: SurfaceDirs = defaultSurfaceDirs(), opts: { replaceReason?: boolean } = {}): { moved: string[]; armed: boolean } {
  return parkForForeign(FOREIGN_REASON, dirs, { replaceReason: opts.replaceReason === true && !killSwitchArmedForForeign(dirs.dataDir) })
}

/** Re-enable ONLY a switch this module armed — the one in dirs.dataDir (TRDD-RBBEX59R R1). Returns whether anything
 *  was re-enabled. A caller that gets true must converge telemetry once more: the raw-body key was held absent while
 *  the switch stood, and only the next converge writes it (TRDD-RBBEX59R). */
export function enableIfForeign(dirs: SurfaceDirs = defaultSurfaceDirs()): boolean {
  return killSwitchArmedForForeign(dirs.dataDir) ? enableAgentlensSurfaces(dirs).disarmed : false
}

/** The `Reason:` line `armKillSwitch` recorded in `dir`'s flag, or null. */
function recordedReason(dir: string = dataDir()): string | null {
  try {
    const m = /^Reason: (.*)$/m.exec(fs.readFileSync(killSwitchPath(dir), "utf8"))
    return m ? m[1] : null
  } catch { return null }
}
