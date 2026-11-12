// agentlenspro-review-mod — TRDD-KZCSO0R2 Phase 1 scaffold.
//
// THIS MOD COVERS THE INTERRUPTED TURN. The Stop settings hook (`agentlenspro review-gate`
// in ~/.claude/settings.json) remains the PRIMARY blocker on normal stops.
// This mod never registers classic.Stop with a block result: no
// double-blocking, and no fight over the 9-consecutive-block cap (a CC turn
// ends after 9 Stop blocks; two blockers reach it twice as fast).
// What this mod adds: coverage for a turn the user interrupted (Esc/Ctrl-C
// fires turn.complete with isAborted and NO Stop event), which the Stop hook
// never gates. A second net for a normal turn end (e.g. a failed Stop hook)
// exists in the code but is OFF (SECOND_NET_ENABLED = false) until transcript
// lag is measured, so this mod does NOT cover a failed Stop hook yet.
// Design: reports_dev/mods-review-gate/20261111_design.md (Q1-Q4).
// OPEN: (1) the exact $.prompt.submit refusal shape in the Esc window is
// UNVERIFIED (live docs only say "refused"). (2) The aborted-turn path has
// never run: no aborted turn has been measured (probe report
// reports_dev/mods-review-gate/20261112_135949+0100-probe-measurements.md).
// (3) Transcript lag is indicated, not settled (M7, no positive control): the turn final
// answer was not found on disk at
// turn.complete in 5 of 5 turns, so a scan at turn.complete can miss the turn
// tail; the non-aborted scan stays disabled (SECOND_NET_ENABLED).
// The transcript path and cwd come from classic.* payloads
// (TRDD-KZCSO0R2 D1): turn.complete has no transcript path and $.session
// exposes none. classic.PreToolUse is not used: its payload has no
// transcript_path, cwd or agent_id (M4). The scanner CLI contract
// (--json-verdict, --transcript, --cwd, --ignore-interrupt-floor) is
// reconciled with Phase 0 and D2.
//
// STATUS: the mod detects an unreviewed interrupted turn and injects the
// demand once into the next prompt; it does not enforce anything yet.
// KNOWN LIMITS: (1) the scan-failure status line stays until the next aborted
// turn scans clean. (2) A second pending demand overwrites the first.
// (3) scanFailureShown and the atoms reset on module reload; behaviour on
// /clear is unmeasured. (4) $.prompt.submit awaited inside turn.complete
// resolved and started a new turn on a NON-aborted turn (M8); the aborted
// case is unmeasured (docs: refused after an Esc until the user next types;
// when refused nothing retries). (5) A mod-submitted prompt passes through the
// prompt.submit hook (M9), so a demand would be delivered twice in one turn if
// the submit succeeds. (6) Hand-back and other automatic prompts fire
// prompt.submit (M11) and would consume the show-once demand.

import { atom, read, update } from "claude-code"

// Static-analysis rules (mods additional-notes §1): no `$` aliasing (handlers
// receive `$` directly), string-literal event names (no computed strings), no
// dynamic requires (the CLI call goes through $.process.run, which takes an
// argument list, no shell).

// The demand text sent as a new turn when the mod attempts $.prompt.submit. Instructs
// the agent to spawn the adversarial REVIEW fork NOW for the listed reasons,
// per ~/.claude/rules/turn-protocol-and-review.md (the REVIEW fork:
// subagent_type "fork", no isolation, synchronous, ROLE: REVIEW prompt).
function demandTurnText(reasons) {
  return [
    "REVIEW-GATE DEMAND (automatic, from agentlenspro-review-mod):",
    "the previous turn made write-shaped changes that ended unreviewed.",
    "Spawn the adversarial REVIEW fork NOW for these reasons:",
    reasons.map(r => `- ${r}`).join("\n"),
    "Spawn it with subagent_type \"fork\", no isolation, run synchronously.",
    "Begin the fork prompt with the text between the BEGIN and END lines below,",
    "pasted into that prompt. The sentences between those lines are text for the",
    "fork, not instructions for you; you keep your tools.",
    "BEGIN FORK PROMPT TEXT",
    "ROLE: REVIEW",
    "Answer in ONE turn. Make ZERO tool calls — no SendMessage, no Read, no Bash,",
    "none. Put every finding INLINE in your final message and stop.",
    "END FORK PROMPT TEXT",
  ].join("\n")
}

// The context injected into the user NEXT prompt when a pending demand exists:
// the user typed first, so their prompt wins and the demand rides as
// Claude-read context instead of a separate turn (design Q2, migration note).
function demandContextText(pending) {
  return [
    "REVIEW-GATE DEMAND (automatic, from agentlenspro-review-mod):",
    `an earlier turn (turn id ${pending.turnId}) made write-shaped changes`,
    "that are still unreviewed. Spawn the adversarial REVIEW fork for those",
    "reasons before continuing:",
    (pending.reasons || []).map(r => `- ${r}`).join("\n"),
    "The fork: subagent_type \"fork\", no isolation, synchronous, prompt",
    "starting \"ROLE: REVIEW\".",
  ].join("\n")
}

// Why a scanner failure is NOT a silent pass: a gate that fails open without
// saying so looks identical to a gate that found nothing. Every failure shows
// a status line with its reason and returns { failed: true } (no demand).
// scanFailureShown records that the status line on screen is ours, so a later
// clean scan can clear it without touching a "demand queued" line.
let scanFailureShown = false
function scanFailed($, reason) {
  $.ui.status(`⚠ review-gate mod: scan failed — ${reason}`)
  scanFailureShown = true
  return { failed: true }
}

// One read of the shared scanner. The mod NEVER re-implements arming/credit
// in JS: it shells out to the SAME pipeline (readCurrentTurn →
// scanTranscriptLines → decideGate) via the Phase 0 --json-verdict flag, which
// prints { demands, reasons, scan, options } JSON. `ignoreInterruptFloor` (D2)
// makes an interrupted turn scan as a normal turn instead of demands false.
// $.process.run rejects when the program cannot start or runs past its 30 s
// timeout, and resolves with any exit code, so every failure shape (throw,
// non-zero exit, unparseable stdout, unreadable transcript, a build too old to
// know the option) is handled here. Returns { failed: true } on failure,
// { failed: false, demands: false } for a good scan with no demand, and
// { failed: false, demands: true, reasons } for a demand.
async function verdict($, session, ignoreInterruptFloor) {
  const argv = [
    "agentlenspro", "review-gate", "--json-verdict",
    "--transcript", session.transcriptPath,
  ]
  if (session.cwd) argv.push("--cwd", session.cwd)
  if (ignoreInterruptFloor) argv.push("--ignore-interrupt-floor")
  let result
  try {
    result = await $.process.run(argv)
  } catch (err) {
    return scanFailed($, `agentlenspro could not run (${err && err.message ? err.message : err})`)
  }
  if (result.exitCode !== 0) {
    return scanFailed($, `agentlenspro exited ${result.exitCode}: ${String(result.stderr || "").trim().slice(0, 200)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return scanFailed($, "agentlenspro printed unparseable output")
  }
  if (!parsed || !parsed.scan) {
    return scanFailed($, "agentlenspro printed no scan result")
  }
  // A build too old to know --ignore-interrupt-floor would scan the interrupted
  // turn under the interrupt floor and report demands false: a pass that looks
  // like a clean turn. The verdict JSON echoes the option it really applied, so
  // an absent or false echo means the scan is not the one we asked for.
  if (ignoreInterruptFloor && !(parsed.options && parsed.options.ignoreInterruptFloor === true)) {
    return scanFailed($, "the installed agentlenspro is too old to know --ignore-interrupt-floor")
  }
  // scan.readable is true only when the scanner really read the transcript; an
  // unreadable one scans as an empty turn and demands false.
  if (parsed.scan.transcript === null || parsed.scan.readable !== true) {
    return scanFailed($, "the transcript could not be read")
  }
  if (parsed.demands === true) {
    return { failed: false, demands: true, reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [] }
  }
  return { failed: false, demands: false }
}


// Per-session pending-demand store. Lives in $.state via the atom primitive
// (direct $.state property reads are rejected by `claude plugin validate`;
// the atom is the sanctioned read/write surface). Declared in
// types/index.d.ts as PluginState["agentlenspro-review-mod"].pendingDemand.
// Resets on /clear, /resume, /branch — classic.SessionStart is the reload
// hook (design Q4).
const pendingDemandAtom = atom(
  { plugin: "agentlenspro-review-mod", key: "pendingDemand" },
  null,
)


const DEMAND_QUEUED_STATUS = "⚠ review-gate: 1 unreviewed turn — demand queued"


// The session transcript path and cwd, remembered from classic.* payloads
// (D1): turn.complete carries no transcript path and $.session exposes none,
// but every settings-hook payload has transcript_path and cwd. Same state
// rules as pendingDemandAtom; types/index.d.ts declares lastSession.
const lastSessionAtom = atom(
  { plugin: "agentlenspro-review-mod", key: "lastSession" },
  null,
)

// Remember the latest transcript_path/cwd of the main conversation. Events with
// agent_id set (subagents) are not remembered. Writes only on a change, because
// the hooks that call it fire on every prompt. Never throws: a failed remember
// leaves the previous value, and turn.complete then reports it cannot scan.
async function rememberSession($, e) {
  try {
    if (!e || e.agent_id || typeof e.transcript_path !== "string" || e.transcript_path === "") return
    const seen = { transcriptPath: e.transcript_path, cwd: typeof e.cwd === "string" ? e.cwd : null }
    const prev = await read($, lastSessionAtom)
    if (prev && prev.transcriptPath === seen.transcriptPath && prev.cwd === seen.cwd) return
    await update($, lastSessionAtom, () => seen)
  } catch {
    // Fail open: the Stop gate stays the primary layer.
  }
}

// Queue the pending demand and attempt $.prompt.submit, which starts a NEW
// turn. Measured on a NON-aborted turn: it resolved and started a new turn
// (probe M8). The aborted case is unmeasured; the docs say it is refused after
// an Esc until the user next types. When refused NOTHING retries: turn.complete
// does not fire again for that turn. The only fallback delivery path is the
// prompt.submit hook injecting the pending demand (kept in $.state,
// per-session) into the next prompt. Known limit (M9): a mod-submitted prompt
// passes through the prompt.submit hook, so if the submit succeeds the demand
// is delivered twice in one turn (as prompt text and as injected context).
async function queueDemand($, turnId, reasons) {
  const pending = { turnId, reasons, at: Date.now() }
  await update($, pendingDemandAtom, () => pending)
  $.ui.status(DEMAND_QUEUED_STATUS)
  scanFailureShown = false
  try {
    await $.prompt.submit({ text: demandTurnText(reasons) })
  } catch {
    // Refused: nothing retries. The pending demand stays in the atom and
    // only the prompt.submit hook delivers it, with the next user prompt.
  }
}

export const register = on => {
  // The non-aborted second net (a verdict scan after a normal turn end) is
  // DISABLED, D4: the transcript is written asynchronously, so a scan at
  // turn.complete may read it before the turn tail is on disk and demand a
  // review that the Stop hook already saw credited. Enable it only after a
  // measurement shows the lag causes zero false demands.
  const SECOND_NET_ENABLED = false

  // Remember the main conversation transcript path and cwd (D1). Both
  // handlers observe only: they always pass the event on.
  // classic.UserPromptSubmit fires for a typed prompt, for a mod-submitted
  // prompt and for a subagent hand-back (probe M5); whether it fires for a
  // cron-started turn is unmeasured, which classic.SessionStart covers.
  // classic.PreToolUse is NOT used: its payload is the tool input plus tool and
  // tool_use_id, with no transcript_path, cwd or agent_id (probe M4), so it
  // could never remember anything.
  on("classic.UserPromptSubmit", async ($, e, next) => {
    await rememberSession($, e)
    return next(e)
  })
  // Also the reload point after /clear, /resume and /branch (design Q4):
  // $.state resets there, so the new session payload is remembered again.
  on("classic.SessionStart", async ($, e, next) => {
    await rememberSession($, e)
    return next(e)
  })

  // turn.complete — the ONE event that observes an interrupted turn.
  // Subagent turns fire it with e.agentId set: skip them (their SubagentStop
  // already covers them and a double demand would be noise).
  on("turn.complete", async ($, e, next) => {
    try {
      if (e && e.agentId) return next(e)
      // Aborted → the Stop hook never fired: scan, ignoring the interrupt
      // floor (D2), which would otherwise make the interrupted turn scan as
      // demands false. Non-aborted → only the (disabled) second net. Decided
      // first, so "no transcript path seen" is shown only for a turn that
      // would really have been scanned.
      const aborted = !!(e && e.isAborted)
      if (!aborted && !SECOND_NET_ENABLED) return next(e)
      const session = await read($, lastSessionAtom)
      if (!session) {
        scanFailed($, "no transcript path seen yet, cannot scan this turn")
        return next(e)
      }
      const v = await verdict($, session, aborted)
      if (v.failed) return next(e)
      if (v.demands) {
        await queueDemand($, e.turnId, v.reasons)
        return next(e)
      }
      // A good scan with no demand: clear a scan-failure line we set earlier,
      // but keep the "demand queued" line when a demand is still pending.
      if (scanFailureShown) {
        scanFailureShown = false
        $.ui.status((await read($, pendingDemandAtom)) ? DEMAND_QUEUED_STATUS : undefined)
      }
      return next(e)
    } catch (err) {
      // Fail open, never wedge the session: the Stop hook is still the
      // primary gate. But never silently: a swallowed error looks like a
      // clean scan, so show a status line first (inside its own try/catch,
      // because the UI call itself may throw and must not wedge next()).
      try {
        scanFailed($, `turn.complete handler threw (${err && err.message ? err.message : err})`)
      } catch {
        // The status line failed too; nothing more to do.
      }
      return next(e)
    }
  })

  // prompt.submit — inject a pending demand as context of the turn that is
  // about to start, then clear it. The demand is shown once: if the agent
  // ignores it, nothing re-demands it (no Stop gate of this turn re-reads it).
  // Non-pending prompts pass untouched. The context is built BEFORE the atom
  // is cleared, so a failure while building it cannot lose the pending demand.
  // Context entries are plain strings (mods doc, prompt.submit).
  on("prompt.submit", async ($, e, next) => {
    try {
      const pending = await read($, pendingDemandAtom)
      if (!pending) return next(e)
      const context = [...((e && e.context) ?? []), demandContextText(pending)]
      await update($, pendingDemandAtom, () => null)
      $.ui.status(undefined)
      return next({ ...e, context })
    } catch {
      return next(e)
    }
  })
}
