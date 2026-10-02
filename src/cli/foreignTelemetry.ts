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
import { killSwitchHalf, killSwitchPath } from "./killSwitch"
import { SurfaceDirs, defaultSurfaceDirs, disableAgentlensSurfaces, enableAgentlensSurfaces } from "./surfaces"

export const FOREIGN_REASON = "foreign telemetry configuration present — run with --force-install-telemetry"

/** Verbs Claude Code runs inside a turn under a timeout. They stay SILENT no-ops while disabled (a message
 *  there would land inside the session) and are never auto-repaired (a repair would blow their deadline). */
export const HOOK_PATH_VERBS: ReadonlySet<string> = new Set([
  "hook", "gate", "review-gate", "review-supervisor", "delegate-gate", "statusline",
])

/** Verbs that must keep working while disabled — they are how one gets back. `server status` is checked
 *  separately (it needs argv[1]). */
const DISABLED_PASSTHROUGH: ReadonlySet<string> = new Set(["enable", "disable", "setup"])

/** Is the kill-switch armed, and for THIS reason? (A missing/unreadable flag reads as no.) */
export function killSwitchArmedForForeign(): boolean {
  try { return fs.readFileSync(killSwitchPath(), "utf8").includes(`Reason: ${FOREIGN_REASON}`) } catch { return false }
}

export function disableForForeignTelemetry(dirs: SurfaceDirs = defaultSurfaceDirs()): string[] {
  return disableAgentlensSurfaces(FOREIGN_REASON, dirs).moved
}

/** Re-enable ONLY a switch this module armed. Returns whether anything was re-enabled. */
export function enableIfForeign(dirs: SurfaceDirs = defaultSurfaceDirs()): boolean {
  return killSwitchArmedForForeign() ? enableAgentlensSurfaces(dirs).disarmed : false
}

/** The `Reason:` line `armKillSwitch` recorded, or null. */
function recordedReason(): string | null {
  try {
    const m = /^Reason: (.*)$/m.exec(fs.readFileSync(killSwitchPath(), "utf8"))
    return m ? m[1] : null
  } catch { return null }
}

/** When agentlenspro is DISABLED and `argv` is a verb that must not run: the stderr text (written for an AI
 *  agent as much as a human — what happened, why, the exact command to reactivate) and the exit code. Null
 *  when the verb may run. Hook-path verbs return null: they are silent no-ops and handle the switch
 *  themselves. */
export function disabledNotice(argv: string[]): { text: string; code: number } | null {
  const half = killSwitchHalf()
  if (half === null) return null
  const verb = argv[0] ?? ""
  if (HOOK_PATH_VERBS.has(verb) || DISABLED_PASSTHROUGH.has(verb) || (verb === "server" && argv[1] === "status")) return null
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
  lines.push("Do not retry the original command; run the reactivation command above first.")
  return { text: lines.join("\n"), code: EXIT.DISABLED }
}
