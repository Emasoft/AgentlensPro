// src/cli/surfaces.ts — disabling and re-enabling agentlenspro's user-scope SURFACES (owner order
// 2026-10-02, TRDD-AGZ0XZKW): "if agentlenspro is disabled, it must automatically disable both rules
// and skills. only the agents can be still left, since they are independent from the agentlenspro cli."
//
// Disabled = the global kill-switch armed (every hook except the review gate and the review supervisor is a no-op) AND the skills (and rules) agentlenspro
// installed moved out of ~/.claude into <dataDir>/disabled-surfaces/ (NOT `disabled/`: on a case-insensitive filesystem — macOS, Windows — that name is the
// `DISABLED` kill-switch flag file, and the mkdir fails ENOTDIR) — a MOVE, never a delete, so `enable` can put
// them back byte-identical. The agents stay: they do not depend on the CLI.
//
// Arm and park are two primitives (armKillSwitch, parkAgentlensSurfaces): `agentlenspro disable` does both through
// disableAgentlensSurfaces; the foreign-telemetry stop goes through parkForForeign, which always parks and arms only when no
// switch stands — except for `enable`, which replaces the reason (replaceReason, TRDD-RBBEX59R D10). Every disarm goes
// through enableAgentlensSurfaces, so the switch and the skills can never disagree.

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { dataDir } from "./cliCore"
import { SKILL_NAMES } from "./hookInstall"
import { armKillSwitch, disarmKillSwitch, killSwitchPath } from "./killSwitch"

/** File/dir names under ~/.claude/rules that this package installs. EMPTY today (package.json `files`
 *  ships no rule and no code writes into ~/.claude/rules) — a future shipped rule goes HERE and is then
 *  disabled/enabled with the skills automatically. */
export const RULE_NAMES: readonly string[] = []

export interface SurfaceDirs { dataDir: string; skillsDir: string; rulesDir: string }

export function defaultSurfaceDirs(): SurfaceDirs {
  const claude = path.join(os.homedir(), ".claude")
  return { dataDir: dataDir(), skillsDir: path.join(claude, "skills"), rulesDir: path.join(claude, "rules") }
}

const KINDS = (d: SurfaceDirs): Array<{ names: readonly string[]; live: string; parked: string }> => [
  { names: SKILL_NAMES, live: d.skillsDir, parked: path.join(d.dataDir, "disabled-surfaces", "skills") },
  { names: RULE_NAMES, live: d.rulesDir, parked: path.join(d.dataDir, "disabled-surfaces", "rules") },
]

function move(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    fs.renameSync(src, dest)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e
    fs.cpSync(src, dest, { recursive: true }) // another filesystem: the copy exists before the original goes
    fs.rmSync(src, { recursive: true })
  }
}

/** Arm the kill-switch (with `reason`) and park agentlenspro's skills/rules in <dataDir>/disabled-surfaces/.
 *  Idempotent. Returns the flag path and what moved. Arm + park are separate primitives (TRDD-RBBEX59R D11): a caller
 *  that must keep an existing switch's reason (disableForForeignTelemetry) arms conditionally and always parks. */
export function disableAgentlensSurfaces(reason?: string, dirs: SurfaceDirs = defaultSurfaceDirs()): { flag: string; moved: string[] } {
  // dirs.dataDir, not the env default (TRDD-RBBEX59R): the flag is armed in the dir the skills are parked under and the
  // foreign check reads, so the check and the later removal hit the same file.
  const flag = armKillSwitch(reason, dirs.dataDir)
  return { flag, moved: parkAgentlensSurfaces(dirs) }
}

/** Park agentlenspro's skills/rules in <dataDir>/disabled-surfaces/ WITHOUT touching the kill-switch. Idempotent (a
 *  name that is not live is skipped). Returns what moved.
 *  WHY a separate primitive (TRDD-RBBEX59R D10, D11): the foreign path must park whatever the reason of an already
 *  armed switch is, while arming is conditional on the flag being absent; one function doing both could not do that. */
export function parkAgentlensSurfaces(dirs: SurfaceDirs = defaultSurfaceDirs()): string[] {
  const moved: string[] = []
  for (const { names, live, parked } of KINDS(dirs)) {
    for (const name of names) {
      const src = path.join(live, name)
      if (!fs.existsSync(src)) continue
      let dest = path.join(parked, name)
      if (fs.existsSync(dest)) dest = `${dest}.${new Date().toISOString().replace(/[:.]/g, "-")}` // never overwrite an earlier parked copy
      move(src, dest)
      moved.push(dest)
    }
  }
  return moved
}

/** The foreign-telemetry stop's primitive: park the skills ALWAYS; arm `reason` when no flag file stands in dirs.dataDir,
 *  or when `opts.replaceReason` is set. Returns what moved and `armed`: this call wrote the flag (it was absent, or the
 *  caller asked to replace it). `armed` false means "a switch already stood and its reason was kept", NEVER "not foreign".
 *  WHY the arm is conditional (TRDD-RBBEX59R D10, hazard B): armKillSwitch overwrites the flag, so an unconditional arm
 *  turned an operator `agentlenspro disable` into a foreign-reason switch on any launch or `setup`, and the later auto-lift
 *  (enableIfForeign, which lifts only FOREIGN_REASON) then undid the operator's disable.
 *  WHY replaceReason exists: `enable` against a foreign setup records the operator's lift as FOREIGN_REASON, so the switch
 *  lifts by itself once the foreign setup goes; keeping the operator reason would silently lose the `enable`.
 *  WHY the park is unconditional: parking keys on the foreign verdict, never on who armed the switch.
 *  The arm lives here, not in foreignTelemetry.ts, so every kill-switch arm stays in surfaces.ts (source guard). */
export function parkForForeign(reason: string, dirs: SurfaceDirs = defaultSurfaceDirs(), opts: { replaceReason?: boolean } = {}): { moved: string[]; armed: boolean } {
  const armed = opts.replaceReason === true || !fs.existsSync(killSwitchPath(dirs.dataDir))
  if (armed) armKillSwitch(reason, dirs.dataDir)
  return { moved: parkAgentlensSurfaces(dirs), armed }
}
/** Disarm the kill-switch and put the parked skills/rules back. A name already live again (reinstalled
 *  meanwhile) is left alone and its parked copy stays. Returns whether a flag was removed and what
 *  came back. */
export function enableAgentlensSurfaces(dirs: SurfaceDirs = defaultSurfaceDirs()): { disarmed: boolean; restored: string[] } {
  // dirs.dataDir, not the env default (TRDD-RBBEX59R): a foreign lift for ctx must remove ctx's flag — on the default it
  // removed another dir's flag (possibly the operator's) while ctx's foreign flag stayed.
  const disarmed = disarmKillSwitch(dirs.dataDir)
  const restored: string[] = []
  for (const { names, live, parked } of KINDS(dirs)) {
    for (const name of names) {
      const from = path.join(parked, name)
      const to = path.join(live, name)
      if (!fs.existsSync(from) || fs.existsSync(to)) continue
      move(from, to)
      restored.push(to)
    }
  }
  return { disarmed, restored }
}
