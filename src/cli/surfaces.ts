// src/cli/surfaces.ts — parking and restoring agentlenspro's user-scope SURFACES (owner order 2026-10-02,
// TRDD-AGZ0XZKW: "if agentlenspro is disabled, it must automatically disable both rules and skills. only the agents can
// be still left, since they are independent from the agentlenspro cli.").
//
// Since TRDD-RBBEX59R d2 the operator switch (`agentlenspro disable`, AGENTLENS_DISABLED) parks NOTHING: it stops only
// collection (owner rule 2026-11-03). The skills (and rules) are parked ONLY while a foreign telemetry setup is present
// (D4), moved — never deleted — into <dataDir>/disabled-surfaces/ (NOT `disabled/`: on a case-insensitive filesystem —
// macOS, Windows — that name is the `DISABLED` kill-switch flag file, and the mkdir fails ENOTDIR), so they come back
// byte-identical. The agents stay: they do not depend on the CLI.
//
// Four primitives (D11): arm = armKillSwitch, park = parkAgentlensSurfaces, disarm = disarmKillSwitch, restore =
// restoreParkedSurfaces. `agentlenspro disable` only arms (disableCli.ts); the foreign-telemetry stop goes through
// parkForForeign, which always parks and arms only when no switch stands — except for the operator's `enable`, which
// replaces the reason (replaceReason, D10). Every lift that must also restore goes through enableAgentlensSurfaces
// (disarm + restore), so a lifted switch never leaves its skills parked; restoreParkedSurfaces alone puts back the skills
// a pre-d2 `disable` parked while the switch stays armed (D7).

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { dataDir } from "./cliCore"
import { SKILL_NAMES } from "./hookInstall"
import { armKillSwitch, disarmKillSwitch, killSwitchPath } from "./killSwitch"

/** File/dir names under ~/.claude/rules that this package installs. EMPTY today (package.json `files`
 *  ships no rule and no code writes into ~/.claude/rules) — a future shipped rule goes HERE and is then
 *  disabled/enabled with the skills automatically.
 *  BEFORE any rule name ships: restoreParkedSurfaces (via `occupant`) assumes the SKILL shape, where a live DIRECTORY is a live skill and only a file or a
 *  non-directory symlink blocks. A live RULE is a FILE, so applied to rules as written every reinstalled rule would be reported as occupied on every
 *  launch. The occupant rule must become per-kind (see KINDS) first. */
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
 *  turned an operator `agentlenspro disable` into a foreign-reason switch whenever a foreign setup was found (the `setup`
 *  verb always reached this; a launch reaches it too since d2 lets launches run under an operator switch), and the later
 *  auto-lift (enableIfForeign, which lifts only FOREIGN_REASON) then undid the operator's disable.
 *  WHY replaceReason exists: only the operator's `agentlenspro enable` (runEnableCli) sets it. Against a foreign setup that
 *  enable records the operator's lift as FOREIGN_REASON, so the switch lifts by itself once the foreign setup goes; keeping
 *  the operator reason would silently lose the `enable`. No other caller (a launch, `setup`, --force-install-telemetry) may set it.
 *  WHY the park is unconditional: parking keys on the foreign verdict, never on who armed the switch.
 *  The arm lives here, not in foreignTelemetry.ts, so the foreign arm stays beside the park it belongs to. */
export function parkForForeign(reason: string, dirs: SurfaceDirs = defaultSurfaceDirs(), opts: { replaceReason?: boolean } = {}): { moved: string[]; armed: boolean } {
  const armed = opts.replaceReason === true || !fs.existsSync(killSwitchPath(dirs.dataDir))
  if (armed) armKillSwitch(reason, dirs.dataDir)
  return { moved: parkAgentlensSurfaces(dirs), armed }
}

/** Is `p` gone right now? lstat ENOENT only: any other stat error is not "gone". */
function sourceGone(p: string): boolean {
  try { fs.lstatSync(p); return false } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" }
}

/** What stands at `p` right now? lstat decides the kind (it does not follow links); a symlink is then followed with stat. Returns:
 *  "file" / "symlink": something that BLOCKS installSkill (a plain file, or a symlink that is dangling or does not resolve to a directory: installSkill mkdirs
 *  under the name and throws (observed: EEXIST for a file or a symlink to a file, ENOENT for a dangling symlink)), so the operator must clear it; "live": a directory, or a symlink resolving to one, which is a live skill ("already live
 *  again"); null: nothing there, or any lstat error, so the caller rethrows the rename error. */
function occupant(p: string): SkippedSurface["what"] | "live" | null {
  try {
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) {
      try { return fs.statSync(p).isDirectory() ? "live" : "symlink" } catch { return "symlink" }
    }
    return st.isDirectory() ? "live" : "file"
  } catch { return null }
}

/** The operator-facing clause for parked skills left parked because a file or a non-directory symlink blocks their live path: names each path, what stands there,
 *  and the way out. Used by ensureInstalled (P1) only: the setup verb needs no clause, because the same blocker makes installSkill throw there (observed: EEXIST for a file or a symlink to a file, ENOENT for a dangling symlink), and
 *  that failure is its loud report. */
export function formatSkippedSurfaces(skipped: readonly SkippedSurface[]): string {
  return `${skipped.length} parked skill(s) left parked: ` + skipped.map(s => `${s.to} is occupied (a ${s.what} stands there, left untouched — move it away, then run agentlenspro setup)`).join("; ")
}

/** A parked surface that restoreParkedSurfaces left parked because something BLOCKING stands at its live destination `to`: `what` is the kind (a plain file, or a
 *  symlink that is dangling or does not resolve to a directory). A directory is never listed: it is a live skill, not a blocker. */
export interface SkippedSurface { to: string; what: "file" | "symlink" }

/** Put the parked skills/rules back WITHOUT touching the kill-switch. Returns what came back (`restored`) and what stayed parked
 *  because a BLOCKER stands at its live destination (`skipped`). A name already live again (reinstalled meanwhile, or put live by a concurrent
 *  restore: a directory, or a symlink resolving to one) is left alone SILENTLY and its parked copy stays; a timestamp-suffixed parked copy is never restored.
 *  WHY `skipped` is returned (TRDD-RBBEX59R d2 leftover): a plain file, or a symlink that is dangling or does not resolve to a directory, at
 *  ~/.claude/skills/<name> is a LASTING state - installSkill mkdirs under that name and throws (observed: EEXIST for a file or a symlink to a file, ENOENT for a dangling symlink) - so that skill stays parked on every
 *  launch and only the user can clear it; a silent skip left nobody told. The launch (ensureInstalled P1) prints it; the setup verb fails loudly on the same
 *  blocker (installSkill throws, as above). A live DIRECTORY is not reported: it is a live
 *  skill (the repair loop replaces a stale one by content), and telling the user to move away the real skill on every launch would be false.
 *  The other skip (ENOENT with the source gone) is not lasting - the repair loop reinstalls a missing live skill (detectDrift lists a skill with no SKILL.md under its live name as "missing", and the skill step then runs installSkill for it) - so it is not reported either.
 *  WHY a separate primitive (TRDD-RBBEX59R D7, D11): after d2 the operator switch parks nothing, so skills parked by a
 *  pre-d2 `disable` must come back at the next launch while the switch stays armed; restoring and lifting are two decisions
 *  (only enableAgentlensSurfaces does both). It is a MOVE, never a repair: a repair would install a second copy beside the parked one.
 *  WHY ENOENT skips the name: two launches (or a launch and `setup`) can restore at once and the loser finds the source
 *  already moved; that is success, not an error. Any other failure still throws, and ENOENT with the source still present
 *  is a different fault, so it throws too. The mirror case is EEXIST/ENOTEMPTY/ENOTDIR with the destination occupied now (lstat): a concurrent run put
 *  a copy live after the check (a directory: "already live again" applied late, silent), or a file / dangling symlink stands there (reported); either way the name is skipped, not thrown. */
export function restoreParkedSurfaces(dirs: SurfaceDirs = defaultSurfaceDirs()): { restored: string[]; skipped: SkippedSurface[] } {
  const restored: string[] = []
  const skipped: SkippedSurface[] = []
  for (const { names, live, parked } of KINDS(dirs)) {
    for (const name of names) {
      const from = path.join(parked, name)
      const to = path.join(live, name)
      if (!fs.existsSync(from)) continue
      const standing = fs.existsSync(to) ? occupant(to) : null
      if (standing) { if (standing !== "live") skipped.push({ to, what: standing }); continue }
      try {
        move(from, to)
      } catch (e) {
        // lstat, not existsSync: the question is "is the source gone NOW", answered by the filesystem itself, and ENOENT from the
        // rename with the source still present is a different fault that must still throw.
        const code = (e as NodeJS.ErrnoException).code
        if (code === "ENOENT" && sourceGone(from)) continue
        // EEXIST/ENOTEMPTY/ENOTDIR with `to` occupied now: a concurrent launch or `setup` put a copy live between the check above and the rename
        // (a directory: silent, as above), or a dangling symlink / file stands there (reported).
        // lstat, not existsSync: a dangling symlink at `to` is not "absent" (existsSync follows it and says so) and renaming a directory over
        // it fails ENOTDIR, as it does over a plain file; both are an occupied name.
        const what = occupant(to)
        if ((code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR") && what) { if (what !== "live") skipped.push({ to, what }); continue }
        throw e
      }
      restored.push(to)
    }
  }
  return { restored, skipped }
}

/** Disarm the kill-switch and put the parked skills/rules back — the operator's explicit lift (`agentlenspro enable`) and
 *  the lift of a switch armed for a foreign setup. A name already live again is left alone (see restoreParkedSurfaces).
 *  Returns whether a flag was removed and what came back. */
export function enableAgentlensSurfaces(dirs: SurfaceDirs = defaultSurfaceDirs()): { disarmed: boolean; restored: string[] } {
  // dirs.dataDir, not the env default (TRDD-RBBEX59R): a foreign lift for ctx must remove ctx's flag — on the default it
  // removed another dir's flag (possibly the operator's) while ctx's foreign flag stayed.
  const disarmed = disarmKillSwitch(dirs.dataDir)
  return { disarmed, restored: restoreParkedSurfaces(dirs).restored }
}
