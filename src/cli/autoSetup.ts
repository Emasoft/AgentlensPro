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
//   2a. FOREIGN  -> park the skills and arm the kill-switch with FOREIGN_REASON only when no switch stands (an operator
//       reason is kept), print the remedies, exit non-zero, write nothing;
//   2b. ABSENT or OURS -> put back skills a pre-d2 `disable` parked (P1, a move, never a repair), write the missing
//       telemetry keys FIRST, then restore skills/agents/hooks, then lift the kill-switch (launch: only one armed for the
//       foreign reason; enable: the caller does), then the verb runs. While any switch half stands the raw-body key is held
//       ABSENT (rawBodiesHeldAbsent, TRDD-RBBEX59R), so every lift is followed by one more telemetry converge, which writes it.
//
// THE SWITCH STOPS ONLY COLLECTION (owner rule 2026-11-03, TRDD-RBBEX59R): an operator `agentlenspro disable` or
// AGENTLENS_DISABLED=1 does not stop this repair — it runs under the switch, with the raw-body key held absent. It does
// not park or move anything either.
//
// FOREIGN TELEMETRY (owner orders 2026-10-02): another telemetry setup in place (company gateway,
// managed settings, shell export) makes agentlenspro non-functional and it will not touch it. Without
// `--force-install-telemetry` the launch exits EXIT.CONFIG, the user's verb does NOT run, nothing is
// written, the skills are parked and the kill-switch is armed for that reason when no switch stands (agents stay). With the
// flag the repair step overwrites the foreign telemetry. Removing the foreign setup by hand also works: the next
// launch repairs and re-enables — but only a switch armed for THIS reason; an operator's own
// `agentlenspro disable` is never lifted here (its reason is kept, and so is its collection-off effect).

import * as path from "path"
import { AGENT_NAMES, KeptSurface, SKILL_NAMES, agentSurfaceState, announceKeptSurfaces, hooksVerdict, keptHooksSurface, resolveOnPath, skillFiles, skillSurfaceState, skillTreeHash } from "./hookInstall"
import { packageVersion } from "../packageVersion"
import * as fs from "fs"
import { EXIT } from "./cliErrors"
import { HOOK_PATH_VERBS, READ_ONLY_VERBS, disableForForeignTelemetry, enableIfForeign, isAllAccountsStatus, killSwitchArmedForForeign } from "./foreignTelemetry"
import { agentlensDisabled, killSwitchHalf, overrideKillSwitchEnv } from "./killSwitch"
import { pushNotice } from "./launchNotices"
import { SurfaceDirs, formatSkippedSurfaces, restoreParkedSurfaces } from "./surfaces"
import { Ctx, REPAIR_STEPS, hooksConverged, otelDrift, readSettingsFresh, resolveCtx, runSetup } from "./setup"
import { TelemetryConflict, TelemetryVerdictRow, formatTelemetryConflicts, rawBodiesHeldAbsent } from "../telemetryConfig"
import { RAW_BODIES_KEY } from "../captureConfig"

// WHY excluded: hook-path verbs run inside Claude Code turns under a timeout (a repair would blow
// the deadline, and its verify step execs the registered hooks — recursion) and must never be blocked;
// server/daemon ARE the process a full setup would start (and the hooks revive it); setup is the
// explicit repair verb; disable is the emergency brake and telemetry manages telemetry itself — none
// of them may be blocked by the very state they exist to handle. `enable` runs ensureInstalled('enable')
// itself (see runEnableCli), so it refuses while a foreign telemetry setup is still in place.
export const AUTOSETUP_EXCLUDED_VERBS: ReadonlySet<string> = new Set([
  ...HOOK_PATH_VERBS, ...READ_ONLY_VERBS, "server", "daemon", "setup", "disable", "enable", "telemetry",
  // help of ANY shape: the owner doctrine is "HELP IS TOTAL — describe, never do" (main.ts). `help <known verb>`
  // returns before this check, but `help <unknown>` fell through to it, so a mistyped help request on a fresh
  // machine ran the first-run full setup — installing skills, agents, hooks and telemetry AND starting a collector.
  // `help <known tool>` fell through too and no longer self-heals either — right under "help is total": the next
  // ordinary tool call heals the install. (`help <known management verb>` already returned before the check.)
  "help",
])

export const LOCK_STALE_MS = 10 * 60 * 1000

// "server" = `server|daemon start|restart` (autoSetupOnServerStart): it repairs like a launch (under an operator or environment
// switch too: the switch stops only collection) but never arms or lifts the kill-switch, skips entirely under a switch armed for a
// foreign setup (D13), never runs the first-run full setup (that starts a server), and reports a held lock.
export type Trigger = "enable" | "launch" | "server"

export type Step = keyof typeof REPAIR_STEPS
export interface Drift { piece: string; step: Step | null; reason: string }
export interface Detection {
  drifts: Drift[]; conflicts: TelemetryConflict[]; nothingInstalled: boolean
  /** the full per-key telemetry verdict, user keys that will be converged, and Claude Code stale-snapshot rows */
  rows: TelemetryVerdictRow[]; converge: string[]; staleEnv: TelemetryVerdictRow[]
  /** installed skills and agents the shipped copy does not overwrite (item 4): not drift, announced once */
  kept: KeptSurface[]
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
  /** Set ONLY by runEnableCli: this ensureInstalled run IS the operator's own `agentlenspro enable`, so a foreign setup that
   *  refuses it re-arms the flag with FOREIGN_REASON (D10). Keyed on a flag, not on trigger "enable" (forceInstallTelemetry
   *  passes that trigger too) and not on the verb (`--force-install-telemetry enable` makes the verb "enable" there as well). That
   *  force-install leg is measured UNREACHABLE today (forceInstallTelemetry clears processEnv, so step 2a never runs for it); the flag
   *  is defence for future callers that reach step 2a with trigger "enable" without being the operator. */
  operatorEnable?: boolean
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
  const kept: KeptSurface[] = []

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
    // Item 5B: hook registrations stamped newer than this CLI are kept, not drift (the repair would never touch them, so counting them would re-run it on
    // every launch); they join the kept list that ensureInstalled announces once per (installed, running) pair.
    const hooksV = settings === "absent" ? null : hooksVerdict(settings, packageVersion())
    if (hooksV?.kind === "keep-newer") {
      kept.push(keptHooksSurface(ctx.settingsPath, hooksV.newest, packageVersion()))
    } else if (settings === "absent" || !hooksConverged(settings)) {
      drifts.push({ piece: "hooks", step: "hooks", reason: settings === "absent" ? "no settings.json" : "registration missing or stale (incl. the 120s timeout)" })
    }
  }

  const skillDrift: string[] = []
  let skillsPresent = 0
  for (const name of SKILL_NAMES) {
    const shippedDir = path.join(ctx.repoRoot, "skills", name)
    const shipped = skillTreeHash(shippedDir)
    if (shipped === null) continue // incomplete package: `agentlenspro setup` reports it, a repair cannot fix it
    // The installed copy is hashed over the SHIPPED file list only: installSkill leaves unshipped extras in
    // place, and hashing them made every launch re-run a repair that could never converge (see skillTreeHash).
    const installed = skillTreeHash(path.join(ctx.skillsDir, name), skillFiles(shippedDir))
    if (installed !== null) skillsPresent++
    if (installed === shipped) continue
    // Item 4: a skill the verdict keeps (newer stamp, or edited in a release) is not drift: installSkill would leave it alone,
    // so counting it would re-run the repair on every launch and never converge.
    const state = skillSurfaceState(ctx.repoRoot, ctx.skillsDir, name)
    if (state.verdict === "keep-newer" || state.verdict === "keep-edited") {
      kept.push({ kind: "skill", name, verdict: state.verdict, installedStamp: state.installedStamp, shippedStamp: state.shippedStamp, path: path.join(ctx.skillsDir, name) })
      continue
    }
    skillDrift.push(`${name} ${installed === null ? "missing" : "stale"}`)
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
    else if (!sameBytes(src, dst)) {
      // Same reason as for the skills: a kept agent is no drift.
      const state = agentSurfaceState(ctx.repoRoot, ctx.agentsDir, name)
      if (state.verdict === "keep-newer" || state.verdict === "keep-edited") {
        kept.push({ kind: "agent", name, verdict: state.verdict, installedStamp: state.installedStamp, shippedStamp: state.shippedStamp, path: dst })
      } else agentDrift.push(`${name} stale`)
    }
  }
  if (agentDrift.length > 0) drifts.push({ piece: "agents", step: "skill", reason: agentDrift.join(", ") })

  return { drifts, conflicts, rows, converge, staleEnv, kept, nothingInstalled: skillsPresent === 0 && agentsPresent === 0 && settings === "absent" }
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
  // `get_account_status --all` needs no server and only reads (files, plus the owner's long-lived-key probes): it must never write settings/skills/hooks (owner directive 2026-10-29).
  // Argv-aware on purpose — the singular form is NOT in READ_ONLY_VERBS and keeps its self-heal.
  if (isAllAccountsStatus(argv)) return null
  // The lines are HELD, not printed (launchNotices.ts, TRDD-YL3EWT6N item 7): printed before the verb they broke the
  // exit-2 contract — a refused tool call must leave exactly one JSON object on stderr. cliMain prints them, or a
  // refusal folds them into its JSON. An injected `stderr` (the tests) still receives them directly.
  return ensureInstalled("launch", verb, { ...deps, stderr: deps.stderr ?? pushNotice })
}

/** Is Claude Code on this machine at all? Present when `~/.claude` exists OR `claude` resolves on PATH. A server
 *  started where neither holds (a Docker image, a CI box) has nobody to install skills, agents or hooks FOR, and
 *  writing them would create a `~/.claude` tree inside the container. */
export function claudeCodePresent(ctx: Pick<Ctx, "home" | "pathEnv">): boolean {
  return fs.existsSync(path.join(ctx.home, ".claude")) || resolveOnPath("claude", ctx.pathEnv) !== null
}

/** The server/daemon sub-verbs that START a collector — the only ones the server-start check runs for. `revive`
 *  is deliberately absent: it is the hook path's detached start, and hooks run on every tool call. */
const SERVER_START_SUBVERBS: ReadonlySet<string> = new Set(["start", "restart"])

/** The install heals itself when the SERVER is started too (owner 2026-10-14, TRDD-YL3EWT6N: "automatically install
 *  or reinstall them ... when the cli is executed or the server is started"). `server`/`daemon` stay excluded from
 *  the per-launch check (maybeAutoSetup) because they are also reached from hooks; this runs for
 *  `server|daemon start|restart` only, and main.ts runs it AFTER the verb resolves (once the server answers, or once
 *  the `--supervise` child is spawned), so it never delays the start. Same gates as a launch — AGENTLENS_NO_AUTOSETUP,
 *  a switch armed for a foreign setup (an operator switch no longer gates it: it stops only collection), and here also "Claude Code absent". Never throws and never blocks, delays or fails the start:
 *  it reports on stderr, in this order (the fourth and fifth items repeat for each repaired piece, in repair order, so the converged lines come immediately before their own otel-env step line, not before every other piece's line):
 *  - the stale-env warning, once, first: under Claude Code (CLAUDECODE=1) the shell value of a key whose settings.json value is ours differs from it (not gated on the trigger, so it fires for trigger "server"; it follows the D13 foreign-armed skip, so a server start under a foreign-armed flag never prints it);
 *  - one line per kept skill or agent (TRDD-YL3EWT6N item 4: the installed copy is newer than the shipped one, or an edited copy of the same version), only the first time for a given kind, name, installed stamp and shipped stamp (announceKeptSurfaces, hookInstall.ts);
 *  - the put-back line: ONE line for all parked skills it put back, carrying the switch clause (and the left-parked clause when only some are blocked); with nothing restored, ONE "left parked" line
 *    covering every skill a blocker holds back (a file or a non-directory symlink, dangling included);
 *  - for a repaired otel-env step, BEFORE its step line, one line per CHANGED key in `converged` (detectDrift().converge, read under the lock; the loop `for (const key of converged)` is not gated on the trigger):
 *    "converged <key>", or "removed <key> (off switch armed)" for the raw-body key under the switch; a key that was only missing adds no line;
 *  - one line per repaired piece ("restored <piece> (...)") or failed piece ("could not restore <piece> ... run `agentlenspro setup`");
 *  - one line for a skip or a thrown failure. */
export async function autoSetupOnServerStart(argv: string[], deps: AutoSetupDeps = {}): Promise<void> {
  const [cmd, sub] = argv
  if ((cmd !== "server" && cmd !== "daemon") || !SERVER_START_SUBVERBS.has(sub ?? "")) return
  if ((deps.env ?? process.env).AGENTLENS_NO_AUTOSETUP === "1") return
  const say = deps.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  try {
    const ctx = deps.ctx ?? resolveCtx({ log: () => { /* quiet */ } })
    if (!claudeCodePresent(ctx)) return
    await ensureInstalled("server", `${cmd} ${sub}`, { ...deps, ctx })
  } catch (e) {
    say(`agentlenspro: install check failed (${(e as Error).message.slice(0, 160)}) — the server start is not affected; run \`agentlenspro setup\``)
  }
}

/** THE install/repair order, shared by `enable`, every launch and a server start (see the header). Returns null
 *  when the caller may proceed, or the exit code it must return (the server-start caller ignores it: it reports,
 *  it never refuses the start). Never throws. */
export async function ensureInstalled(trigger: Trigger, verb: string, deps: AutoSetupDeps = {}): Promise<number | null> {
  const say = deps.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  try {
    const base = deps.ctx ?? resolveCtx({ log: () => { /* quiet */ } })
    const ctx: Ctx = { ...base, forceInstall: deps.forceInstall ?? base.forceInstall }
    const dirs: SurfaceDirs = { dataDir: ctx.dataDir, skillsDir: ctx.skillsDir, rulesDir: path.join(ctx.home, ".claude", "rules") }
    // The switch stops only COLLECTION (owner rule 2026-11-03, TRDD-RBBEX59R D13): an operator `disable` or AGENTLENS_DISABLED no longer
    // stops a launch, `enable` or a server start from repairing the install (skills, agents, hooks, telemetry env).
    // The one skip left is a server start under a switch armed for a FOREIGN setup: the foreign lift (enableIfForeign, below) runs only
    // for launches, so a server trigger that got on with the foreign setup gone would restore the parked skills (P1) and leave the flag
    // saying "foreign" while they are live. Lifting a switch is a launch's or `enable`'s decision, never a side effect of starting the collector.
    // WHY the skip still matters although a LAUNCH can leave the same mismatch (P1 also restores under a foreign-armed flag with the foreign
    // setup gone, so a launch whose repair then fails ends with the flag foreign over live skills): that launch state is transient. The next
    // successful launch lifts the flag, and before d2 the same launch installed fresh copies anyway, so it is accepted. A server start
    // never lifts, so a mismatch it created would persist until some launch or `enable` ran, however long the server stays up.
    // The read takes ctx.dataDir, the dir being converged, never the env default (TRDD-RBBEX59R R1).
    if (trigger === "server" && killSwitchArmedForForeign(ctx.dataDir)) return null

    // STEP 1 — the telemetry verdict, before any other action.
    const first = detectDrift(ctx)
    // Under Claude Code the shell env is a snapshot of settings.json from session start: a routing value that
    // differs from the CURRENT file is stale, not foreign — warn once per launch and carry on (never disable).
    if (first.staleEnv.length > 0) {
      say(`agentlenspro: stale session env (restart Claude Code to pick up the new settings): ${first.staleEnv.map(r => r.key).join(", ")}`)
    }
    // A kept surface (item 4) is no drift, so the fast path below would never mention it: the notice is announced here, once per kind,
    // name, installed stamp and shipped stamp, before any branch can return and after the stale-env line (the order autoSetupOnServerStart documents).
    announceKeptSurfaces(ctx.dataDir, first.kept, say)
    if (first.conflicts.length > 0) {
      // A server start never blocks, never disables and never writes over another telemetry setup: it is not the
      // place to arm the kill-switch (that would refuse the very start the operator asked for). One line, then the
      // server starts; the next ordinary launch or `agentlenspro setup` reports the conflict in full.
      if (trigger === "server") {
        say("agentlenspro: install check skipped: another telemetry setup is in place — run `agentlenspro setup` to see it")
        return null
      }
      const shell = first.conflicts.some(c => c.scope === "shell")
      if (!ctx.forceInstall || shell) {
        // STEP 2a — FOREIGN and no (usable) --force-install-telemetry: park the skills, arm the kill-switch only if none stands,
        // write nothing, print the remedies, stop.
        // No "already armed, skip" shortcut (TRDD-RBBEX59R D15): disableForForeignTelemetry is idempotent on the park (a no-op when
        // no skill is live) and keeps a standing flag's reason, so an operator reason survives a launch.
        // replaceReason ONLY for the operator's own `enable` (D10, deps.operatorEnable, set by runEnableCli): the operator asked to
        // lift their switch and the foreign setup refuses it, so the flag is re-armed with FOREIGN_REASON, which records that the
        // lift waits for the foreign setup to go (the switch then lifts by itself). Not keyed on trigger "enable": forceInstallTelemetry
        // passes that trigger too and is not an operator `enable`. Any other caller (a launch) keeps the reason that stands. The flag is
        // defence for FUTURE callers: forceInstallTelemetry cannot reach this block at all (it clears processEnv, so no shell row exists,
        // and forceInstall is set), which is measured, not assumed (test '--force-install-telemetry over a SHELL-scope OTEL_* export under an "ops" switch').
        // A second reader of "foreign flag means parked" would be wrong once an operator-armed switch can stand here.
        const { moved } = disableForForeignTelemetry(dirs, { replaceReason: deps.operatorEnable === true })
        say(`${formatTelemetryConflicts(first.conflicts, verb)}\nCollection is off while this foreign setup stands (nothing is stored)`
          + `${moved.length ? ` and ${moved.length} skill(s) were moved to ${path.join(ctx.dataDir, "disabled-surfaces")}` : ""}; its agents stay installed.`)
        return EXIT.CONFIG
      }
    } else if (first.drifts.length === 0 && !killSwitchArmedForForeign(ctx.dataDir)) {
      return null // the fast path
    }

    const release = takeLock(ctx.dataDir)
    if (!release) {
      // A launch skips silently (the winner repairs). A server start reports the skip: the operator ran a
      // deliberate start and should learn that the install check did not run this time (TRDD-YL3EWT6N).
      if (trigger === "server") say("agentlenspro: install check skipped: another agentlenspro is repairing")
      return null
    }
    try {
      // P1 (TRDD-RBBEX59R D7, D14): put back the skills a pre-d2 `disable` parked, whatever the reason of the switch — after d2 the only
      // legitimate reason for parked skills is a foreign setup. A MOVE, never a repair (a repair would install a second copy beside the
      // parked one). The guard runs HERE, inside the lock, never on the stale `first` (computed before takeLock: a launch that waited,
      // or a settings.json edited meanwhile, can have gained a foreign key). It uses otelDrift(ctx), the very call detectDrift takes
      // `conflicts` from, so it cannot disagree with `first.conflicts` over user, managed and shell rows. The one difference is an
      // unparseable settings.json: detectDrift leaves conflicts empty and this guard refuses to restore (the verdict is unknown), but that
      // refusal does not stop the restore for good: the missing skills are a drift, so the skill step runs in the same launch and its
      // P2 (stepSkill, setup.ts) puts them back, exactly as a fresh install did before d2: the launch still ends with live skills.
      // The restore moves files the operator did not ask about in this run, so it is announced in ONE stderr line: how many, where to,
      // and, except for `enable` (which prints its own switch line), what becomes of the switch (clause below).
      const verdict = otelDrift(ctx)
      if (verdict !== "unparseable" && verdict.conflicts.length === 0) {
        const { restored: back, skipped } = restoreParkedSurfaces(dirs)
        if (back.length > 0 || skipped.length > 0) {
          // The clause says what happens to the switch per caller. `enable` gets none: it prints its own switch line (runEnableCli after its
          // disarm, forceInstallTelemetry in its summary), so "stays armed" would be false for the operator enable. A launch over a
          // foreign-armed flag lifts it below once its repairs succeed (a server start never reaches here with that flag: the D13 skip
          // returned). Any other switch, operator or env, stays armed. Under the env half (AGENTLENS_DISABLED=1) lifting the flag does not turn
          // collection on, so the lift clause says so (TRDD-RTHA7EWK item 4).
          const switchClause = trigger === "enable" ? ""
            : !agentlensDisabled(ctx.dataDir) ? "; no kill-switch is armed"
            : trigger === "launch" && killSwitchArmedForForeign(ctx.dataDir) ? `; the switch armed for the foreign setup is lifted once this launch's repairs succeed${killSwitchHalf(ctx.dataDir) === "env" ? "; collection stays off while AGENTLENS_DISABLED=1 is set" : ""}`
            : "; the kill-switch stays armed (collection stays off)"
          // A file or a dangling/non-directory symlink at a live skill path is a LASTING state (the skill stays parked on every launch), so it is
          // announced, never skipped silently. With nothing restored the line must not claim "put back 0", and the switch clause (which
          // describes what happens after a restore) is dropped.
          const skippedClause = skipped.length > 0 ? formatSkippedSurfaces(skipped) : ""
          say(back.length > 0
            ? `agentlenspro: put back ${back.length} parked skill(s) into ${ctx.skillsDir}${switchClause}${skippedClause ? `; ${skippedClause}` : ""}`
            : `agentlenspro: ${skippedClause}`)
        }
      }
      // Re-detect under the lock: the previous holder may have just fixed everything.
      const { drifts, conflicts, nothingInstalled, converge: converged } = detectDrift(ctx)
      // Content-logging flags the user EXPLICITLY set to 0/false are about to be forced on: remember the old
      // values now (the repair rewrites them) so the override gets a loud warning, once — after the write the
      // value is 1, so later launches find nothing to warn about.
      const oldEnv = (() => { const s = readSettingsFresh(ctx.settingsPath); return s !== "absent" && s !== "unparseable" && s.env && typeof s.env === "object" ? s.env as Record<string, unknown> : {} })()
      const overridden = converged.filter(k => /^OTEL_LOG_/.test(k) && ["0", "false"].includes(String(oldEnv[k]).toLowerCase()))
      // Launch only: a first-run full setup also STARTS the server, so running it from the `server` trigger would
      // start a collector from inside a collector start. The server trigger falls through to the per-piece repairs
      // below, which install everything except the server (which the verb itself is starting).
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
          // R5 (TRDD-RBBEX59R): while the off switch stands the raw-body row was converged by REMOVING the key, so say so.
          const rawRemoved = rawBodiesHeldAbsent(ctx.dataDir)
          for (const key of converged) say(key === RAW_BODIES_KEY && rawRemoved ? `agentlenspro: removed ${key} (off switch armed)` : `agentlenspro: converged ${key}`)
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
      // on — only a switch armed for that reason, never an operator's.
      // WHY only a launch lifts (TRDD-RBBEX59R D13, D17): `enable` lifts its own switch in its caller (runEnableCli, after the
      // verdict); forceInstallTelemetry passes trigger "enable" and lifts through enableIfForeign itself, right after the overwrite;
      // a server start must not lift a switch as a side effect of starting the collector, and under a foreign-armed flag it
      // returned at the narrowed skip above, before any restore or repair.
      if (trigger === "launch" && allOk && enableIfForeign(dirs)) {
        say("agentlenspro: the foreign telemetry setup is gone — hooks and skills re-enabled")
        // WHY (TRDD-RBBEX59R): the repairs above held the raw-body key absent while the switch stood; every lift is
        // followed by one telemetry converge, so the key is written in this same run.
        const r = await repair("otel-env", ctx)
        if (!r.ok) say(`agentlenspro: could not restore telemetry env after the lift (${r.detail}) — run \`agentlenspro setup\``)
      }
    } finally { release() }
    return null
  } catch (e) {
    say(`agentlenspro: auto-repair failed (${(e as Error).message.slice(0, 160)}) — run \`agentlenspro setup\``)
    return null
  }
}

/** `--force-install-telemetry` (owner orders 2026-10-02): `enable` + overwrite + full restore in ONE invocation.
 *  The only path that ever overwrites a FOREIGN telemetry value (user settings.json, and the managed-settings
 *  file when this user can write it — backups reported). It then writes every missing key, restores skills,
 *  agents and hooks, restores the parked skills and lifts the kill-switch ONLY when it was armed for the foreign setup
 *  this run just overwrote (D17: an operator's `agentlenspro disable` stays armed — only `agentlenspro enable` lifts it),
 *  and converges once more, which writes the raw-body key: it is held absent while any switch half stands (rawBodiesHeldAbsent,
 *  TRDD-RBBEX59R) — the env half included, even though this run overrides it for everything else.
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
  // Read BEFORE the overwrite: whether the switch was armed for the foreign setup this run is about to remove (the message below reports it).
  const wasForeignArmed = killSwitchArmedForForeign(base.dataDir)
  overrideKillSwitchEnv()
  const ctx: Ctx = { ...base, telemetryProbe: { ...base.telemetryProbe, processEnv: {} } }
  const code = await ensureInstalled("enable", verb, { ...deps, ctx, forceInstall: true })
  if (code !== null) return code
  // WHY restore + enableIfForeign and not enableAgentlensSurfaces (TRDD-RBBEX59R D17): enableAgentlensSurfaces disarms WHATEVER
  // the reason, so a force install lifted an operator `agentlenspro disable` and silently turned collection back on. This flag
  // is the override of a FOREIGN setup, not the undo of the operator's disable. The overwrite above has just removed the foreign
  // setup, so a switch armed for it is lifted here (ensureInstalled lifts only for a launch, never for trigger "enable").
  const dirs: SurfaceDirs = { dataDir: ctx.dataDir, skillsDir: ctx.skillsDir, rulesDir: path.join(ctx.home, ".claude", "rules") }
  restoreParkedSurfaces(dirs)
  enableIfForeign(dirs)
  // WHY (TRDD-RBBEX59R): the converge above held the raw-body key absent while the flag file stood; every lift is
  // followed by one telemetry converge, so the key is written in this same run (an env half or an operator switch keeps it absent).
  const again = await ensureInstalled("enable", verb, { ...deps, ctx, forceInstall: true })
  if (again !== null) return again
  if (overridden.length > 0) {
    say(`agentlenspro: --force-install-telemetry overrode ${overridden.join(", ")} for THIS run only; without the flag the next run sees ${overridden.length > 1 ? "them" : "it"} again and agentlenspro will be disabled/refuse again (a child process cannot change your shell's environment).`
      + (overridden.includes("AGENTLENS_DISABLED") ? ` ${RAW_BODIES_KEY} stays absent while AGENTLENS_DISABLED=1 is set: the switch stops raw-body collection.` : ""))
  }
  // `lifted` = the switch armed for the foreign setup is gone now, whoever removed it: the real otel-env step lifts it itself once it
  // has overwritten the foreign setup (setup.ts stepOtel), so enableIfForeign alone would report "not lifted" in the normal case.
  const lifted = wasForeignArmed && !agentlensDisabled(ctx.dataDir)
  const switchNote = lifted ? "; the kill-switch armed for the foreign setup was lifted"
    // The "foreign-armed flag still standing" case (neither lifted nor operator-armed) is defensive: stepOtel and enableIfForeign lift it before this line.
    : agentlensDisabled(ctx.dataDir) && !killSwitchArmedForForeign(ctx.dataDir) ? "; the kill-switch armed by `agentlenspro disable` stays armed (`agentlenspro enable` lifts it)" : ""
  say(`agentlenspro: --force-install-telemetry applied — telemetry, skills, agents and hooks are installed and current${switchNote}.`)
  return null
}
