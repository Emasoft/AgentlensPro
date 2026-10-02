// src/cli/surfaces.ts — disabling and re-enabling agentlenspro's user-scope SURFACES (owner order
// 2026-10-02, TRDD-AGZ0XZKW): "if agentlenspro is disabled, it must automatically disable both rules
// and skills. only the agents can be still left, since they are independent from the agentlenspro cli."
//
// Disabled = the global kill-switch armed (every hook is a no-op) AND the skills (and rules) agentlenspro
// installed moved out of ~/.claude into <dataDir>/disabled-surfaces/ (NOT `disabled/`: on a case-insensitive filesystem — macOS, Windows — that name is the
// `DISABLED` kill-switch flag file, and the mkdir fails ENOTDIR) — a MOVE, never a delete, so `enable` can put
// them back byte-identical. The agents stay: they do not depend on the CLI.
//
// EVERY place that arms the kill-switch must go through disableAgentlensSurfaces (today: `agentlenspro
// disable` and the foreign-telemetry stop), and every disarm through enableAgentlensSurfaces, so the
// switch and the skills can never disagree.

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { dataDir } from "./cliCore"
import { SKILL_NAMES } from "./hookInstall"
import { armKillSwitch, disarmKillSwitch } from "./killSwitch"

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
 *  Idempotent. Returns the flag path and what moved. */
export function disableAgentlensSurfaces(reason?: string, dirs: SurfaceDirs = defaultSurfaceDirs()): { flag: string; moved: string[] } {
  const flag = armKillSwitch(reason)
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
  return { flag, moved }
}

/** Disarm the kill-switch and put the parked skills/rules back. A name already live again (reinstalled
 *  meanwhile) is left alone and its parked copy stays. Returns whether a flag was removed and what
 *  came back. */
export function enableAgentlensSurfaces(dirs: SurfaceDirs = defaultSurfaceDirs()): { disarmed: boolean; restored: string[] } {
  const disarmed = disarmKillSwitch()
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
