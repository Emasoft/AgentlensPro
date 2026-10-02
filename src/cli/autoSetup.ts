// src/cli/autoSetup.ts — the install heals itself at every CLI launch (TRDD-AGZ0XZKW; owner orders
// 2026-10-02: "automatically run the setup at first launch of the agentlenspro cli" and "skills,
// agents, hooks, anything missing must be restored automatically at each launch of the cli").
//
// No marker file gates this: each launch runs cheap presence+drift checks against the REAL state
// (skill tree hashes, agent bytes, hook registrations incl. the 120 s timeout, per-key telemetry
// env) and repairs ONLY what failed, through the same steps `setup --yes` runs. Silent when
// everything is current. A full runSetup (server start, self-test) happens only when NOTHING is
// installed, and never for a bare launch (that one IS the foreground server).
//
// Every settings.json mutation happens inside those steps, i.e. through safeConfigEdit (the
// verified transaction: refuse-unparseable, verify-diff, atomic backup+rename, cross-process
// lock). This file never writes settings.json itself — a test scans the source to keep it so.
//
// ORDER (owner order 2026-10-02: "when enabled, it must always check the settings.json telemetry settings
// first ... only if the telemetry settings are gone or are those of agentlens then it must restore/install
// anything missing"). ONE function, ensureInstalled, runs it for `agentlenspro enable` and for every
// launch, so the order cannot diverge (`setup` reaches the same order through its step list — the
// otel-env step runs first):
//   1. the telemetry verdict (user settings.json + managed settings + shell env), BEFORE any action;
//   2a. FOREIGN  -> disable again (kill-switch re-armed, skills parked), print the remedies, exit
//       non-zero, write nothing;
//   2b. ABSENT or OURS -> write the missing telemetry keys FIRST, then restore skills/agents/hooks, then
//       lift the kill-switch (launch: only one armed for the foreign reason; enable: the caller does), then
//       the verb runs.
//
// FOREIGN TELEMETRY (owner orders 2026-10-02): another telemetry setup in place (company gateway,
// managed settings, shell export) makes agentlenspro non-functional and it will not touch it. Without
// `--force-install-telemetry` the launch exits EXIT.CONFIG, the user's verb does NOT run, nothing is
// written, and agentlenspro DISABLES itself (kill-switch + skills parked; agents stay). With the flag the
// repair step overwrites the foreign telemetry. Removing the foreign setup by hand also works: the next
// launch repairs and re-enables — but only a switch armed for THIS reason; an operator's own
// `agentlenspro disable` is never undone here and is never auto-repaired around.

import * as path from "path"
import { AGENT_NAMES, SKILL_NAMES, skillTreeHash } from "./hookInstall"
import * as fs from "fs"
import { EXIT } from "./cliErrors"
import { HOOK_PATH_VERBS, READ_ONLY_VERBS, disableForForeignTelemetry, enableIfForeign, killSwitchArmedForForeign } from "./foreignTelemetry"
import { agentlensDisabled, overrideKillSwitchEnv } from "./killSwitch"
import { SurfaceDirs, enableAgentlensSurfaces } from "./surfaces"
import { Ctx, REPAIR_STEPS, hooksConverged, otelDrift, readSettingsFresh, resolveCtx, runSetup } from "./setup"
import { TelemetryConflict, TelemetryVerdictRow, formatTelemetryConflicts } from "../telemetryConfig"

// WHY excluded: hook-path verbs run inside Claude Code turns under a timeout (a repair would blow
// the deadline, and its verify step execs the registered hooks — recursion) and must never be blocked;
// server/daemon ARE the process a full setup would start (and the hooks revive it); setup is the
// explicit repair verb; disable is the emergency brake and telemetry manages telemetry itself — none
// of them may be blocked by the very state they exist to handle. `enable` runs ensureInstalled('enable')
// itself (see runEnableCli), so it refuses while a foreign telemetry setup is still in place.
export const AUTOSETUP_EXCLUDED_VERBS: ReadonlySet<string> = new Set([
  ...HOOK_PATH_VERBS, ...READ_ONLY_VERBS, "server", "daemon", "setup", "disable", "enable", "telemetry",
])

export const LOCK_STALE_MS = 10 * 60 * 1000

export type Step = keyof typeof REPAIR_STEPS
export type Trigger = "enable" | "launch"
export interface Drift { piece: string; step: Step | null; reason: string }
export interface Detection {
  drifts: Drift[]; conflicts: TelemetryConflict[]; nothingInstalled: boolean
  /** the full per-key telemetry verdict, user keys that will be converged, and Claude Code stale-snapshot rows */
  rows: TelemetryVerdictRow[]; converge: string[]; staleEnv: TelemetryVerdictRow[]
}
export interface RepairOutcome { ok: boolean; detail: string }

export interface AutoSetupDeps {
  ctx?: Ctx
  env?: NodeJS.ProcessEnv
  /** `--force-install-telemetry` for this invocation. */
  forceInstall?: boolean
  stderr?: (line: string) => void
  /** Repairs one step. Default: the real setup step, run against ctx. */
  repair?: (step: Step, ctx: Ctx) => Promise<RepairOutcome>
  /** Full `setup --yes`; true = exit 0. Default: the real runSetup. */
  fullSetup?: (ctx: Ctx) => Promise<boolean>
}

function sameBytes(a: string, b: string): boolean {
  if (fs.statSync(a).size !== fs.statSync(b).size) return false // size first: no read on the cheap miss
  return fs.readFileSync(a).equals(fs.readFileSync(b))
}

/** Read-only presence + drift checks. Never throws on a missing path; never writes. The drifts come out in
 *  REPAIR ORDER — telemetry first, then hooks, skills, agents — and `conflicts` is the telemetry verdict. */
export function detectDrift(ctx: Ctx): Detection {
  const drifts: Drift[] = []
  let conflicts: TelemetryConflict[] = []
  let rows: TelemetryVerdictRow[] = []
  let converge: string[] = []
  let staleEnv: TelemetryVerdictRow[] = []

  const settings = readSettingsFresh(ctx.settingsPath)
  if (settings === "unparseable") {
    // safeConfigEdit refuses an unparseable file by design — so do we: report, never repair.
    drifts.push({ piece: "settings.json", step: null, reason: `${ctx.settingsPath} is not parseable JSON — not repairing hooks/telemetry; fix it, then run \`agentlenspro setup\`` })
  } else {
    const otel = otelDrift(ctx)
    if (otel !== "unparseable") {
      conflicts = otel.conflicts
      rows = otel.rows
      converge = otel.converge
      staleEnv = otel.staleEnv
      if (!otel.converged) drifts.push({ piece: "telemetry env", step: "otel-env", reason: otel.found })
    }
    if (settings === "absent" || !hooksConverged(settings)) {
      drifts.push({ piece: "hooks", step: "hooks", reason: settings === "absent" ? "no settings.json" : "registration missing or stale (incl. the 120s timeout)" })
    }
  }

  const skillDrift: string[] = []
  let skillsPresent = 0
  for (const name of SKILL_NAMES) {
    const shipped = skillTreeHash(path.join(ctx.repoRoot, "skills", name))
    if (shipped === null) continue // incomplete package: `agentlenspro setup` reports it, a repair cannot fix it
    const installed = skillTreeHash(path.join(ctx.skillsDir, name))
    if (installed !== null) skillsPresent++
    if (installed !== shipped) skillDrift.push(`${name} ${installed === null ? "missing" : "stale"}`)
  }
  if (skillDrift.length > 0) drifts.push({ piece: "skills", step: "skill", reason: skillDrift.join(", ") })

  const agentDrift: string[] = []
  let agentsPresent = 0
  for (const name of AGENT_NAMES) {
    const src = path.join(ctx.repoRoot, "agents", `${name}.md`)
    const dst = path.join(ctx.agentsDir, `${name}.md`)
    if (!fs.existsSync(src)) continue
    if (fs.existsSync(dst)) agentsPresent++
    if (!fs.existsSync(dst)) agentDrift.push(`${name} missing`)
    else if (!sameBytes(src, dst)) agentDrift.push(`${name} stale`)
  }
  if (agentDrift.length > 0) drifts.push({ piece: "agents", step: "skill", reason: agentDrift.join(", ") })

  return { drifts, conflicts, rows, converge, staleEnv, nothingInstalled: skillsPresent === 0 && agentsPresent === 0 && settings === "absent" }
}

/** Exclusive-create lock; the loser skips (the winner repairs). Stale after LOCK_STALE_MS by mtime. */
function takeLock(dataDir: string): (() => void) | null {
  fs.mkdirSync(dataDir, { recursive: true })
  const lock = path.join(dataDir, ".autosetup.lock")
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, "wx")
      fs.closeSync(fd)
      return () => { try { fs.unlinkSync(lock) } catch { /* already gone */ } }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
      let age = 0
      try { age = Date.now() - fs.statSync(lock).mtimeMs } catch { continue } // vanished: retry the create
      if (age <= LOCK_STALE_MS) return null
      try { fs.unlinkSync(lock) } catch { /* a racer reclaimed it first */ }
    }
  }
  return null
}

async function defaultRepair(step: Step, ctx: Ctx): Promise<RepairOutcome> {
  const { result } = await REPAIR_STEPS[step].run(ctx)
  return { ok: result.verify === "PASS", detail: result.detail ?? result.found }
}

async function defaultFullSetup(ctx: Ctx): Promise<boolean> {
  const outcome = await runSetup({
    yes: true, forceInstall: ctx.forceInstall, home: ctx.home, dataDir: ctx.dataDir, settingsPath: ctx.settingsPath,
    skillsDir: ctx.skillsDir, agentsDir: ctx.agentsDir, repoRoot: ctx.repoRoot, log: () => { /* quiet: one summary line only */ },
  })
  return outcome.exitCode === 0
}

/** Called by the CLI dispatcher before any verb. Returns null to let the verb run, or an exit code when
 *  it must NOT (another telemetry setup is in place). Never throws: a failure prints one stderr line
 *  naming `agentlenspro setup` and the user's verb carries on. */
export async function maybeAutoSetup(argv: string[], deps: AutoSetupDeps = {}): Promise<number | null> {
  const verb = argv[0] ?? ""
  // AGENTLENS_NO_AUTOSETUP=1 turns the check off ENTIRELY: nothing but this env check runs — no settings read,
  // no write, no kill-switch armed. (The read-only verdict per key is `agentlenspro setup --dry-run`.)
  if (AUTOSETUP_EXCLUDED_VERBS.has(verb) || (deps.env ?? process.env).AGENTLENS_NO_AUTOSETUP === "1") return null
  return ensureInstalled("launch", verb, deps)
}

/** THE install/repair order, shared by `enable` and every launch (see the header). Returns null when the
 *  caller may proceed, or the exit code it must return. Never throws. */
export async function ensureInstalled(trigger: Trigger, verb: string, deps: AutoSetupDeps = {}): Promise<number | null> {
  const say = deps.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  try {
    const base = deps.ctx ?? resolveCtx({ log: () => { /* quiet */ } })
    const ctx: Ctx = { ...base, forceInstall: deps.forceInstall ?? base.forceInstall }
    const dirs: SurfaceDirs = { dataDir: ctx.dataDir, skillsDir: ctx.skillsDir, rulesDir: path.join(ctx.home, ".claude", "rules") }
    // A kill-switch an operator armed (or AGENTLENS_DISABLED) is theirs: a launch never repairs around it.
    // `enable` IS the operator's explicit lift, so it goes on to the verdict.
    if (trigger === "launch" && agentlensDisabled() && !killSwitchArmedForForeign()) return null

    // STEP 1 — the telemetry verdict, before any other action.
    const first = detectDrift(ctx)
    // Under Claude Code the shell env is a snapshot of settings.json from session start: a routing value that
    // differs from the CURRENT file is stale, not foreign — warn once per launch and carry on (never disable).
    if (first.staleEnv.length > 0) {
      say(`agentlenspro: stale session env (restart Claude Code to pick up the new settings): ${first.staleEnv.map(r => r.key).join(", ")}`)
    }
    if (first.conflicts.length > 0) {
      const shell = first.conflicts.some(c => c.scope === "shell")
      if (!ctx.forceInstall || shell) {
        // STEP 2a — FOREIGN and no (usable) --force-install-telemetry: disable AGAIN (even if `enable` was just
        // run), write nothing, print the remedies, stop.
        const wasArmed = killSwitchArmedForForeign()
        const moved = wasArmed ? [] : disableForForeignTelemetry(dirs)
        say(`${formatTelemetryConflicts(first.conflicts, verb)}\nEvery agentlenspro hook is now a no-op`
          + `${moved.length ? ` and ${moved.length} skill(s) were moved to ${path.join(ctx.dataDir, "disabled-surfaces")}` : ""}; its agents stay installed.`)
        return EXIT.CONFIG
      }
    } else if (first.drifts.length === 0 && !killSwitchArmedForForeign()) {
      return null // the fast path
    }

    const release = takeLock(ctx.dataDir)
    if (!release) return null // another launch is repairing right now
    try {
      // Re-detect under the lock: the previous holder may have just fixed everything.
      const { drifts, conflicts, nothingInstalled, converge: converged } = detectDrift(ctx)
      // Content-logging flags the user EXPLICITLY set to 0/false are about to be forced on: remember the old
      // values now (the repair rewrites them) so the override gets a loud warning, once — after the write the
      // value is 1, so later launches find nothing to warn about.
      const oldEnv = (() => { const s = readSettingsFresh(ctx.settingsPath); return s !== "absent" && s !== "unparseable" && s.env && typeof s.env === "object" ? s.env as Record<string, unknown> : {} })()
      const overridden = converged.filter(k => /^OTEL_LOG_/.test(k) && ["0", "false"].includes(String(oldEnv[k]).toLowerCase()))
      if (nothingInstalled && trigger === "launch" && verb !== "") {
        const ok = await (deps.fullSetup ?? defaultFullSetup)(ctx)
        say(ok
          ? "agentlenspro: first run — nothing was installed; ran setup (skills, agents, hooks 120s, telemetry env, server)"
          : "agentlenspro: first-run setup failed — run `agentlenspro setup` to see why")
        return ok || conflicts.length === 0 ? null : EXIT.CONFIG
      }
      const repair = deps.repair ?? defaultRepair
      // STEP 2b — the drifts are in repair order: telemetry first. skills and agents are one setup step: run
      // it once, report each piece against its outcome.
      const outcomes = new Map<Step, RepairOutcome>()
      let allOk = true
      for (const d of drifts) {
        if (d.step === null) { say(`agentlenspro: ${d.reason}`); allOk = false; continue }
        let r = outcomes.get(d.step)
        if (!r) { r = await repair(d.step, ctx); outcomes.set(d.step, r) }
        allOk &&= r.ok
        if (r.ok && d.step === "otel-env") {
          for (const key of converged) say(`agentlenspro: converged ${key}`)
          for (const key of overridden) {
            say(`agentlenspro: WARNING — ${key} was explicitly set to ${String(oldEnv[key])} in settings.json; it has been changed to 1.\n`
              + "  agentlenspro requires full content capture (prompts, tool details/content, assistant responses, raw API bodies).\n"
              + "  To opt out of that capture, disable agentlenspro: run `agentlenspro disable`.")
          }
        }
        say(r.ok ? `agentlenspro: restored ${d.piece} (${d.reason})${d.step === "otel-env" ? ` — ${r.detail}` : ""}` : `agentlenspro: could not restore ${d.piece} (${r.detail}) — run \`agentlenspro setup\``)
        // A forced telemetry overwrite that cannot complete (managed file needs an administrator): stop.
        if (!r.ok && d.step === "otel-env" && conflicts.length > 0) return EXIT.CONFIG
      }
      // Whatever foreign setup disabled us is gone (removed by hand, or overwritten just now): switch back
      // on — only a switch armed for that reason, never an operator's. (`enable` lifts its own in the caller.)
      if (trigger === "launch" && allOk && enableIfForeign(dirs)) say("agentlenspro: the foreign telemetry setup is gone — hooks and skills re-enabled")
    } finally { release() }
    return null
  } catch (e) {
    say(`agentlenspro: auto-repair failed (${(e as Error).message.slice(0, 160)}) — run \`agentlenspro setup\``)
    return null
  }
}

/** `--force-install-telemetry` (owner orders 2026-10-02): `enable` + overwrite + full restore in ONE invocation.
 *  The only path that ever overwrites a FOREIGN telemetry value (user settings.json, and the managed-settings
 *  file when this user can write it — backups reported). It then writes every missing key (raw body dumps
 *  included) and restores skills, agents and hooks, and lifts the kill-switch WHATEVER its recorded reason
 *  (an explicit command, like `enable`; the automatic repair never lifts an operator's).
 *
 *  It also overrides the ENVIRONMENT, for this invocation only: AGENTLENS_DISABLED is ignored (an in-process
 *  flag, killSwitch.ts — process.env is not mutated) and conflicting OTEL_* shell exports are left out of the
 *  verdict. One warning line names each overridden variable: a child process cannot change the parent shell, so
 *  the next run WITHOUT the flag sees them again and behaves as today (disabled, with the unset advice).
 *  Returns null when the caller may go on to run the verb. */
export async function forceInstallTelemetry(verb: string, deps: AutoSetupDeps = {}): Promise<number | null> {
  const say = deps.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  const env = deps.env ?? process.env
  const base = deps.ctx ?? resolveCtx({ log: () => { /* quiet */ } })
  const overridden: string[] = []
  if (env.AGENTLENS_DISABLED === "1") overridden.push("AGENTLENS_DISABLED")
  for (const c of detectDrift(base).conflicts) if (c.scope === "shell") overridden.push(c.key)
  overrideKillSwitchEnv()
  const ctx: Ctx = { ...base, telemetryProbe: { ...base.telemetryProbe, processEnv: {} } }
  const code = await ensureInstalled("enable", verb, { ...deps, ctx, forceInstall: true })
  if (code !== null) return code
  const { restored } = enableAgentlensSurfaces({ dataDir: ctx.dataDir, skillsDir: ctx.skillsDir, rulesDir: path.join(ctx.home, ".claude", "rules") })
  if (overridden.length > 0) {
    say(`agentlenspro: --force-install-telemetry overrode ${overridden.join(", ")} for THIS run only; without the flag the next run sees ${overridden.length > 1 ? "them" : "it"} again and agentlenspro will be disabled/refuse again (a child process cannot change your shell's environment).`)
  }
  say(`agentlenspro: --force-install-telemetry applied — telemetry, skills, agents and hooks are installed and current${restored.length ? `; ${restored.length} parked skill(s) restored` : ""}; the kill-switch is lifted.`)
  return null
}
