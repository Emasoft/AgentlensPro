// src/cli/foreignTelemetry.ts — what agentlenspro does when ANOTHER telemetry setup is in place, and what it
// tells whoever runs it while it is DISABLED (owner orders 2026-10-02, TRDD-AGZ0XZKW).
//
// Without its own telemetry and raw body dumps agentlenspro is non-functional, so it cannot carry on
// beside a company gateway: it DISABLES itself (disableAgentlensSurfaces — kill-switch + skills parked;
// agents stay). `--force-install-telemetry` or a manual removal of the foreign setup undoes it: the next
// launch repairs, and disarms the switch ONLY when it was armed for this reason — an operator-armed
// `agentlenspro disable` is never touched.

import * as fs from "fs"
import { detectTelemetryConflicts } from "../telemetryConfig"
import { EXIT } from "./cliErrors"
import { dataDir } from "./cliCore"
import { killSwitchHalf, killSwitchPath } from "./killSwitch"
import { SurfaceDirs, defaultSurfaceDirs, disableAgentlensSurfaces, enableAgentlensSurfaces } from "./surfaces"

export const FOREIGN_REASON = "foreign telemetry configuration present — run with --force-install-telemetry"

/** Verbs Claude Code runs inside a turn under a timeout. hook, gate and statusline stay SILENT no-ops while disabled (a message
 *  there would land inside the session). review-gate and review-supervisor ignore the switch (killSwitch.ts). None of them is auto-repaired (a repair would blow their deadline). */
export const HOOK_PATH_VERBS: ReadonlySet<string> = new Set([
  "hook", "gate", "review-gate", "review-supervisor", "delegate-gate", "statusline",
])

/** Verbs that must keep working while disabled — they are how one gets back (and the server verbs, see below). */
// server/daemon pass through ON PURPOSE: serverControl has its own terminal DISABLED handling (ensureServer and the
// supervisor throw BEFORE spawning anything), so a supervising launchd never sees the dispatcher's 69 as a crash to retry.
/** Read-only diagnostics other tools poll from their hooks and loops: they never write user config, and may query
 *  the running server read-only (cache-expired asks it over MCP when no harness-reported sample exists), so they
 *  skip BOTH the per-launch check and the DISABLED stop — a diagnostic call must never write settings.json or
 *  disable anything.
 *  WHY cache-expired is here (TRDD-CS2W7E77): 896be44a excluded this class because a read must never write
 *  settings.json, and cache-expired was missed. So on a fresh machine a polled `agentlenspro cache-expired` ran a
 *  full first-run setup that wrote settings, hooks and telemetry env and could start a server. Found by the CLI
 *  hot-path latency guard in gate run B2.
 *
 *  The disk monitor (TRDD-HTARKH87) is exempt as a whole, BY OWNER DECISIONS 2026-11-16 ("Exempt the sampler"; "Install, even when
 *  DISABLED (Recommended)"): disk-sample, disk, disk-watch and disk-monitor (install, uninstall, status). A filling disk is exactly
 *  when everything else is switched off. All of them also skip the launch self-heal: the sampler fires every 5 minutes and must never
 *  write settings.json. */
export const READ_ONLY_VERBS: ReadonlySet<string> = new Set(["cache-expired", "cache-state", "last-compact", "model-headroom", "statusline-history", "disk-sample", "disk", "disk-watch", "disk-monitor"])

// Verbs that pass the DISABLED gate on purpose; each has its own terminal handling (see above).
const DISABLED_PASSTHROUGH: ReadonlySet<string> = new Set(["enable", "disable", "setup", "server", "daemon"])

/** `get_account_status --all` — the PLURAL form, assembled from files (account-state timeline + per-account
 *  usage archive) plus one probe per owner-supplied long-lived key (src/longOAuthKeys.ts); it needs no server and writes no user config (main.ts case get_account_status). ONE rule shared by the dispatcher (no server proxy), the
 *  disabled gate and the launch self-heal. WHY: a read must never be blocked by the off-switch brake nor trigger
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

export function disableForForeignTelemetry(dirs: SurfaceDirs = defaultSurfaceDirs()): string[] {
  return disableAgentlensSurfaces(FOREIGN_REASON, dirs).moved
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

/** When agentlenspro is DISABLED and `argv` is a verb that must not run: the stderr text (written for an AI
 *  agent as much as a human — what happened, why, the exact command to reactivate) and the exit code. Null
 *  when the verb may run. Hook-path verbs return null: they are silent no-ops and handle the switch
 *  themselves. */
export function disabledNotice(argv: string[]): { text: string; code: number } | null {
  const verb = argv[0] ?? ""
  // Checked BEFORE the kill-switch stat: statusline runs on every Claude render and must cost nothing here.
  if (HOOK_PATH_VERBS.has(verb) || READ_ONLY_VERBS.has(verb) || DISABLED_PASSTHROUGH.has(verb)) return null
  // Needs no server and writes no user config (only its own data-dir files: key stamps, the account archive, and --out when asked): the brake must not block it
  // (owner directive 2026-10-29, see isAllAccountsStatus).
  if (isAllAccountsStatus(argv)) return null
  const half = killSwitchHalf()
  if (half === null) return null
  const reason = recordedReason()
  const lines = [`agentlenspro is DISABLED — ${verb || "start"} did not run.`]
  if (half === "env") {
    lines.push("Reason: AGENTLENS_DISABLED=1 is set in this environment.")
    lines.push("To reactivate: unset AGENTLENS_DISABLED (agentlenspro enable cannot clear an environment variable)."
      + (fs.existsSync(killSwitchPath()) ? " The flag file is armed too, so also run: agentlenspro enable" : ""))
  } else if (reason === FOREIGN_REASON) {
    const files = [...new Set(detectTelemetryConflicts().filter(c => c.scope !== "shell").map(c => c.source))]
    lines.push("Reason: another telemetry setup is already in place, and agentlenspro cannot work without its own telemetry and raw body dumps.")
    lines.push(`To reactivate: remove the existing telemetry setup from ${files.length ? files.join(", ") : "settings.json"}, or run: agentlenspro --force-install-telemetry <any command>`)
  } else {
    lines.push(`Reason: ${reason ?? "no reason recorded"} (armed with \`agentlenspro disable\`).`)
    lines.push("To reactivate: agentlenspro enable")
  }
  if (verb === "get_account_status") {
    // The singular form needs the live server; the plural answers from files, so point at it (owner directive 2026-10-29).
    lines.push("Every account's status is available WITHOUT enabling: agentlenspro get_account_status --all (the singular form needs the server).")
  } else {
    lines.push("Do not retry the original command; run the reactivation command above first.")
  }
  return { text: lines.join("\n"), code: EXIT.DISABLED }
}
