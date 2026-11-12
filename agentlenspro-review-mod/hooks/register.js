// agentlenspro-review-mod — TRDD-KZCSO0R2 Phase 1 scaffold.
//
// THIS MOD IS THE SECOND NET. The Stop settings hook (`agentlenspro review-gate`
// in ~/.claude/settings.json) remains the PRIMARY blocker on normal stops.
// This mod never registers classic.Stop with a block result: no
// double-blocking, and no fight over the 9-consecutive-block cap (a CC turn
// ends after 9 Stop blocks; two blockers reach it twice as fast).
// What this mod adds: coverage for turns the Stop hook never gates — a turn
// the user interrupted (Esc/Ctrl-C fires turn.complete with isAborted and NO
// Stop event) and a turn whose Stop hook failed open (timeout/crash).
// Design: reports_dev/mods-review-gate/20261111_design.md (Q1-Q4).
// OPEN: the exact --json-verdict CLI args must be reconciled with the Phase 0
// implementation (built in parallel); the exact $.prompt.submit refusal shape
// in the Esc window is UNVERIFIED (live docs only say "refused").

import { atom, read, update } from "claude-code"

// Static-analysis rules (mods additional-notes §1): no `$` aliasing (handlers
// receive `$` directly), string-literal event names (no computed strings), no
// dynamic requires (the CLI call goes through $.process.run, which takes an
// argument list, no shell).

// The demand text sent as a new turn when the mod itself retries. Instructs
// the agent to spawn the adversarial REVIEW fork NOW for the listed reasons,
// per ~/.claude/rules/turn-protocol-and-review.md (the REVIEW fork:
// subagent_type "fork", no isolation, synchronous, ROLE: REVIEW prompt).
function demandTurnText(reasons) {
  return [
    "REVIEW-GATE DEMAND (automatic, from agentlenspro-review-mod):",
    "the previous turn made write-shaped changes that ended unreviewed.",
    "Spawn the adversarial REVIEW fork NOW for these reasons:",
    reasons.map(r => `- ${r}`).join("\n"),
    "The fork must be spawned with subagent_type \"fork\", no isolation, run",
    "synchronously, with a prompt starting \"ROLE: REVIEW\". Answer in ONE turn.",
    "Make ZERO tool calls — no SendMessage, no Read, no Bash, none. Put every",
    "finding INLINE in your final message and stop.",
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
    "starting \"ROLE: REVIEW\". The Stop gate of THIS turn will re-demand if",
    "it is ignored.",
  ].join("\n")
}

// One read of the shared scanner. The mod NEVER re-implements arming/credit
// in JS: it shells out to the SAME pipeline (readCurrentTurn →
// scanTranscriptLines → decideGate) via the Phase 0 --json-verdict flag, which
// prints { demands, reasons, scan } JSON and exits 0 always. A failure here
// returns no demand (fails open) — the Stop gate is still the primary layer.
async function verdict($, transcriptPath, turnId) {
  // OPEN (Phase 0 reconciliation): flag/argument names assumed as below.
  const result = await $.process.run([
    "agentlenspro", "review-gate", "--json-verdict",
    "--transcript", transcriptPath,
    "--turn-id", turnId,
  ])
  if (result.exitCode !== 0) return null
  try {
    const parsed = JSON.parse(result.stdout)
    if (parsed && parsed.demands === true) {
      return { reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [] }
    }
    return null
  } catch {
    return null
  }
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

// Queue the pending demand and attempt the immediate retry. $.prompt.submit
// starts a NEW turn; in the Esc window it is refused (v2.1.304+ semantics) —
// then we do nothing else: the demand stays in $.state (survives module
// reloads, per-session) and the retry comes from the next turn.complete or
// prompt.submit fire. $.ui.status keeps the queue visible to the user.
async function queueDemand($, turnId, reasons) {
  const pending = { turnId, reasons, at: Date.now() }
  await update($, pendingDemandAtom, () => pending)
  $.ui.status("⚠ review-gate: 1 unreviewed turn — demand queued")
  try {
    await $.prompt.submit({ text: demandTurnText(reasons) })
  } catch {
    // Refused (Esc window) or otherwise unavailable: the pending demand in
    // the atom is the retry source — nothing else to do here.
  }
}

export const register = on => {
  // turn.complete — the ONE event that observes an interrupted turn.
  // Subagent turns fire it with e.agentId set: skip them (their SubagentStop
  // already covers them and a double demand would be noise).
  on("turn.complete", async ($, e, next) => {
    try {
      if (e && e.agentId) return next(e)
      const aborted = !!(e && e.isAborted)
      // Aborted → the Stop hook never fired: scan always.
      // Non-aborted → second-net check: a verdict that still demands a
      // review means the Stop hook failed to demand it (timeout/crash =
      // fail-open). Either way, run the verdict scan.
      const transcriptPath = e && e.transcriptPath
      if (!transcriptPath) return next(e)
      const v = await verdict($, transcriptPath, e.turnId)
      if (v) {
        await queueDemand($, e.turnId, v.reasons)
      }
      // No demand → pass through (the Stop hook already handled it, or
      // there was nothing to demand).
      return next(e)
    } catch {
      // Fail open, never wedge the session: the Stop hook is still the
      // primary gate.
      return next(e)
    }
  })

  // prompt.submit — inject a pending demand as context of the turn that is
  // about to start, then clear it (the demand is in-flight in this turn; the
  // Stop gate of this turn enforces it). Non-pending prompts pass untouched.
  on("prompt.submit", async ($, e, next) => {
    try {
      const pending = await read($, pendingDemandAtom)
      if (!pending) return next(e)
      await update($, pendingDemandAtom, () => null)
      $.ui.status(undefined)
      return next({
        ...e,
        context: [...((e && e.context) ?? []), { type: "text", text: demandContextText(pending) }],
      })
    } catch {
      return next(e)
    }
  })

  // Session reload after /clear, /resume or /branch: $.state resets to
  // defaults without session.start firing again, so the pending demand is
  // gone with it. This no-op reload hook just re-reads $.state (there is
  // nothing durable to restore from — the demand is per-session by design,
  // and the Stop gate still guards the corpus). Kept per design Q4 so the
  // reload path is explicit and probeable.
  on("classic.SessionStart", { source: ["clear", "resume", "fork"] }, async ($, e, next) => {
    try {
      // No-op reload: $.state resets on /clear, /resume, /branch, taking the
      // pending demand with it. There is nothing durable to restore (the
      // demand is per-session by design, and the Stop gate still guards the
      // corpus). This hook exists so the reload path is explicit and
      // probeable (design Q4).
      void (await read($, pendingDemandAtom))
    } catch {
      // Fail open.
    }
    return next(e)
  })
}
