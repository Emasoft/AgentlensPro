// Agent-launch burn gate — the PREVENTION half of the guard stack (TRDD-GOD0108C).
//
// evaluateAgentGate() is the pure decision core behind POST /api/agent-gate, called by
// `agentlenspro gate` from a PreToolUse hook matched on Agent|Task|Workflow|
// SendMessage ONLY (SendMessage routes to the narrower evaluateSendMessageGate below).
// It answers one question in-memory: "will THIS launch, right now, multiply a burn that is
// already forming?" — and denies only the four high-confidence disaster signatures measured
// in the 2026-07-10 incident. Everything ambiguous is a warning or a silent allow: a gate
// that cries wolf gets AGENTLENS_GATE=off'd and then prevents nothing.
//
// Deny reasons are written FOR THE MODEL (Claude Code feeds permissionDecisionReason back
// to the agent): each names the mechanism, the measured cost, and the concrete retry path.

import * as fs from 'fs'
import { type ThrashReport } from './bodiesActivity'
import {
  ASSUMED_TTL_REGIME, COLD_IDLE_SLACK_MS, DEFAULT_COLD_IDLE_MS,
  classifyTtlRegime, ttlPhrase, type TtlRegime,
} from './shared/cacheTtl'
import { isImageReadPath } from './shared/imageReads'

// The conversations a COLD_RESUME rule protects are the SUBAGENT ones (the fanned-out launches /
// the dead agent a SendMessage resumes) — per the doc matrix those ride the 5-min tier ALWAYS,
// independent of the machine's auth regime, so this resolves once at module load. The CALLER's
// regime is per-state (AgentGateState.ttl) because a fork reads the CALLER's cache entry.
const SUBAGENT_TTL = classifyTtlRegime('subagent', null)

export interface GateThresholds {
  /** Parent context (tokens) above which a fork inherits a "fat" prefix (default 200k). */
  forkFatTokens: number
  /** EXPLICIT cold-idle override (AGENTLENS_GATE_COLD_IDLE_MS). When the caller does NOT set it,
   *  the cutoff is TTL-aware instead: the calling session's regime TTL + COLD_IDLE_SLACK_MS
   *  (default = the 5-min tier + 30s slack = the historical 5.5min). */
  coldIdleMs: number
  /** SubagentStarts in 60s that mark a runaway fan-out (default 8). */
  runaway60s: number
  /** SubagentStarts in 2min that earn a heads-up warning (default 5). */
  fanoutWarn2min: number
  /** How long after a StopFailure the cold-resume rule stays armed (default 10min). */
  coldResumeWindowMs: number
  /** Session context (tokens) above which reading an image earns a resident-cost warning
   *  (default 50k). Below it the per-turn tax is noise. */
  imgWarnTokens: number
  /** Session context (tokens) at which an image read would be disaster-class (default 300k).
   *  Present, and deliberately NOT armed to deny — see evaluateImageReadGate. */
  imgDenyTokens: number
}

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  forkFatTokens: 200_000,
  // Derived, not hardcoded: the shared 5-min tier + slack (TRDD-VY1IUVUM) — the fallback when no
  // per-session TTL regime was resolvable. With a resolved regime the cutoff scales with it.
  coldIdleMs: DEFAULT_COLD_IDLE_MS,
  runaway60s: 8,
  fanoutWarn2min: 5,
  coldResumeWindowMs: 600_000,
  imgWarnTokens: 50_000,
  imgDenyTokens: 300_000,
}

export interface ParentContext {
  /** Real context size from the transcript's last message.usage — null when unreadable. */
  contextTokens: number | null
  /** ms since the transcript was last written — null when the file is unreadable. */
  idleMs: number | null
}

/** WHO is fanning out — one spawning session, from the SubagentStart hook events (exact). */
export interface LaunchSpawner {
  session: string
  cwd: string | null
  count: number
  /** agent_type values seen, e.g. ['workflow-subagent', 'fork'] — dedup'd, order = frequency. */
  agentTypes: string[]
}

/** Liveness of a SendMessage target: from SubagentStart/Stop hook events (exact when the target
 *  is an agent id; a NAME cannot be matched to hook payloads, so name targets stay 'unknown'). */
export type TargetLiveness = 'live' | 'dead' | 'unknown'

export interface AgentGateState {
  now: number
  /** 'enforce' denies; 'warn' downgrades every deny to a warning (AGENTLENS_GATE_MODE). */
  mode: 'enforce' | 'warn'
  parent: ParentContext
  /** SubagentStart hook events in the last 60s / 2min (this launch has NOT fired yet). */
  startsLast60s: number
  startsLast2min: number
  /** Per-session launch attribution for the last 2min, heaviest spawner first. */
  spawners?: LaunchSpawner[]
  /** ts of the most recent StopFailure hook event, or null. */
  lastStopFailureMs: number | null
  /** Origin of that StopFailure (session/cwd from its payload) — names the stalled session. */
  stall?: { session: string | null; cwd: string | null } | null
  /** Evidence-based cold-resume disarm (2026-07-11 field fix): true when the STALLED session has
   *  already completed a post-stall request with warm cache (big cache_read, small cache_creation
   *  — BodiesActivityTracker.sessionWarmSince). The stall is over; the fixed 10-min window kept
   *  denying 6 minutes after recovery. The timer stays as the fallback when evidence is absent. */
  stallRecovered?: boolean
  thrash: ThrashReport | null
  /** Share (0..1) of the last-5min responses on premium models + the model seen. */
  premiumShare: number | null
  premiumModel: string | null
  /** SendMessage only: the tool_input `to` target and its resolved liveness. A resume re-runs the
   *  killing request only on a DEAD target — delivery to a LIVE agent rides its existing run. */
  messageTarget?: string | null
  targetLiveness?: TargetLiveness
  /** The CALLING session's TTL regime (TRDD-VY1IUVUM) — kind from lineage signals × machine auth,
   *  resolved by the server. Drives the fork cold checks (a fork reads the CALLER's cache entry:
   *  a 7-min idle on a subscription MAIN session is NOT cold — its entry rides the 1h tier).
   *  Absent → ASSUMED_TTL_REGIME (the 5-min floor, honestly labeled 'assumed'). */
  ttl?: TtlRegime
  /** WHO is asking, from the hook payload (session_id + cwd — both verified present on the gate's
   *  PreToolUse AND PostToolUse payloads, 2026-08-07). Everything this module puts in front of a
   *  MODEL must be about the caller's OWN project: another project's session id or directory is
   *  something this agent can neither act on nor is owed, so it is noise and a leak at once. An
   *  absent cwd means own-project cannot be PROVEN, and an unprovable match must never become a
   *  claim — those messages stay quiet instead. */
  caller?: { session: string | null; cwd: string | null }
  thresholds?: Partial<GateThresholds>
}

export interface AgentGateDecision {
  decision: 'allow' | 'warn' | 'deny'
  code:
    | 'THRASH_ACTIVE' | 'RUNAWAY_FANOUT' | 'COLD_RESUME_FANOUT' | 'FORK_STORM_FORMING'
    | 'FORK_FAT_PARENT' | 'COLD_FORK' | 'FANOUT_HEADSUP' | 'COLD_RESUME_MESSAGE'
    | 'IMG_RESIDENT'
    | null
  reason: string | null
}

const k = (n: number): string => `${Math.round(n / 1000)}k`
const shortSid = (s: string | null): string => (s ? `${s.slice(0, 8)}…` : '?')
const dirName = (cwd: string | null): string => (cwd ? `…/${cwd.split('/').filter(Boolean).pop() ?? cwd}` : '')

/** Same project as the caller? An unknown cwd on EITHER side answers NO — the point of this whole
 *  gate is that a message may only claim what it can prove, and "probably yours" is not proof.
 *  Exact match is deliberate: a subagent inherits its parent's cwd so same-project launches match
 *  by construction, while a worktree really is a different project (different prefix, different
 *  cache entry) and should not be folded in. */
function isOwnProject(caller: AgentGateState['caller'], cwd: string | null): boolean {
  return Boolean(caller?.cwd && cwd && cwd === caller.cwd)
}

/** Launches in the window belonging to the CALLER'S OWN project. Returns 0 — never the
 *  machine-wide count — when the caller cannot be identified, so an unattributable wave stays
 *  silent rather than being blamed on whoever happened to ask next. */
function ownLaunches(state: AgentGateState): number {
  return (state.spawners ?? [])
    .filter(s => isOwnProject(state.caller, s.cwd))
    .reduce((n, s) => n + s.count, 0)
}

/** WHAT the caller's own project is spawning — agent kinds only, e.g. `workflow-subagent×5, fork×1`.
 *  Carries NO session id and NO directory by design: those identify other people's work, which the
 *  reader can neither act on nor is owed, while the agent KINDS are the part it can actually change. */
function fmtOwnAgentTypes(state: AgentGateState): string {
  return [...new Set(
    (state.spawners ?? []).filter(s => isOwnProject(state.caller, s.cwd)).flatMap(s => s.agentTypes),
  )].join(', ')
}

/** Where a rate-limit stall happened — named ONLY when it was the caller's own project. A stall in
 *  a foreign session is still real and still justifies the deny (the caller's fan-out prefixes are
 *  cold either way), but whose session it was is not this agent's business. */
function fmtStallOrigin(state: AgentGateState): string {
  const s = state.stall
  if (!s || !isOwnProject(state.caller, s.cwd)) return ''
  return ` (turn died in session ${shortSid(s.session)} in ${dirName(s.cwd)})`
}

/** "Likely source" clause for thrash messages. It names NOBODY: `FatRequestSender` carries no cwd,
 *  so a suspect can never be shown to be the caller's own project, and a session id the reader
 *  cannot place is noise. How much is being re-written is what it can act on; WHO is a question
 *  for the CLI, answered on request. */
function thrashSource(t: ThrashReport): string {
  return t.suspects.length > 0
    ? `${t.suspects.length} sender(s) implicated — investigate_burn --windowHours 1 names them.`
    : 'Source not attributable from the fat requests — investigate_burn --windowHours 1 to name it.'
}

/**
 * Read the parent session's REAL context size + cache warmth from its transcript:
 * the last assistant entry's message.usage (input + cache_read + cache_creation) IS the
 * prefix a fork will inherit — a bytes/4 guess over the append-only JSONL would count
 * every pre-compaction turn and overestimate wildly. One stat + one bounded tail read.
 */
export function readTranscriptContext(transcriptPath: string, now: number, tailBytes = 262_144): ParentContext {
  let st: fs.Stats
  try {
    st = fs.statSync(transcriptPath)
  } catch {
    return { contextTokens: null, idleMs: null }
  }
  const idleMs = Math.max(0, now - st.mtimeMs)
  let contextTokens: number | null = null
  let fd: number | null = null
  try {
    fd = fs.openSync(transcriptPath, 'r')
    const start = Math.max(0, st.size - tailBytes)
    const buf = Buffer.alloc(Math.min(tailBytes, st.size))
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf-8').split('\n')
    // Started mid-file → the first chunk line is a partial JSONL record; drop it.
    const first = start > 0 ? 1 : 0
    for (let i = lines.length - 1; i >= first; i--) {
      const l = lines[i]
      if (!l.includes('"usage"')) continue
      try {
        const e = JSON.parse(l) as { message?: { usage?: Record<string, unknown> } }
        const u = e.message?.usage
        if (!u) continue
        const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
        contextTokens = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
        break
      } catch {
        continue // corrupt/partial line — keep walking back
      }
    }
  } catch {
    /* unreadable tail — idleMs still stands */
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* already closed */ }
  }
  return { contextTokens, idleMs }
}

/** USER ORDER (2026-07-11, highest priority): a keep-warm pinger launch is NEVER denied. The
 *  pinger exists to PREVENT the cold cache every deny state guards against — denying it CAUSES
 *  the very waste the gate exists to stop, and under COLD_RESUME the pinger IS the warm-up the
 *  rule is waiting for. Signature: a fork (or type-less Task/Agent) whose prompt says keep-warm. */
export function isKeepWarmPinger(input: Record<string, unknown>): boolean {
  const st = input.subagent_type
  const forkOrUnspecified = st === undefined || st === null || st === '' || st === 'fork'
  return forkOrUnspecified && typeof input.prompt === 'string' && /keep.?warm|pinger/i.test(input.prompt)
}

export function evaluateAgentGate(
  toolInput: Record<string, unknown> | null | undefined,
  state: AgentGateState,
): AgentGateDecision {
  const th = { ...DEFAULT_GATE_THRESHOLDS, ...state.thresholds }
  const input = toolInput ?? {}
  const fork = input.subagent_type === 'fork'
  const keepWarm = isKeepWarmPinger(input)
  // TTL-aware cold cutoff (TRDD-VY1IUVUM): the entry a fork re-reads is the CALLER's, so "cold"
  // means idle past the CALLER's regime TTL (+ slack) — 65min on a subscription main session,
  // 5.5min on the assumed floor. An EXPLICIT AGENTLENS_GATE_COLD_IDLE_MS still wins: a user who
  // pinned the cutoff by hand did so deliberately, and silently out-scaling it would make the
  // env knob a no-op.
  const ttl = state.ttl ?? ASSUMED_TTL_REGIME
  const coldCutoffMs = state.thresholds?.coldIdleMs !== undefined ? th.coldIdleMs : ttl.ttlMs + COLD_IDLE_SLACK_MS
  const cold = state.parent.idleMs !== null && state.parent.idleMs > coldCutoffMs
  const idleMin = state.parent.idleMs !== null ? Math.round(state.parent.idleMs / 60_000) : null
  const fat = state.parent.contextTokens !== null && state.parent.contextTokens >= th.forkFatTokens
  const parentK = state.parent.contextTokens !== null ? k(state.parent.contextTokens) : 'an unknown amount of'
  const stallAgeMs = state.lastStopFailureMs !== null ? state.now - state.lastStopFailureMs : null
  // Evidence beats the timer: a warm post-stall response from the stalled session disarms the
  // cold-resume rule immediately (see AgentGateState.stallRecovered); the window is the fallback.
  const coldResume = stallAgeMs !== null && stallAgeMs >= 0 && stallAgeMs <= th.coldResumeWindowMs
    && state.stallRecovered !== true

  const deny = (code: AgentGateDecision['code'], reason: string): AgentGateDecision =>
    keepWarm
      // Keep-warm allowance: every deny downgrades to at most an advisory. The advisory still
      // names the signal so the transcript shows the gate SAW the state and let the pinger pass.
      ? {
          decision: 'warn', code,
          reason: `[agentlens] keep-warm pinger allowed through ${code}: the pinger is the cache ` +
            `warm-up this rule is protecting — denying it would cause the cold cache it prevents.`,
        }
      : state.mode === 'enforce'
        ? { decision: 'deny', code, reason }
        : { decision: 'warn', code, reason: `[deny downgraded to warning: AGENTLENS_GATE_MODE=warn] ${reason}` }

  // ── deny tier: the four measured disaster signatures, most specific first ────
  if (state.thrash?.active) {
    const thrashBase =
      `AgentLens burn-gate: cache-thrash in progress — ${state.thrash.count} calls in the last ` +
      `${Math.round(state.thrash.windowMs / 60_000)}min re-WROTE ~${k(state.thrash.rebilledTokens)} tokens of prefix ` +
      `instead of reading cache${state.thrash.model ? ` (model ${state.thrash.model})` : ''}, i.e. something mutates ` +
      `the context prefix on every call so the cache never hits. ${thrashSource(state.thrash)}`
    // A FORK re-enters the thrashing caller's prefix and re-pays it per launch — deny. A FRESH
    // agent boots its OWN prefix and multiplies nothing: the blanket deny blocked the very
    // advisor/diagnostic launches that could fix the source, while stopping none of the thrash
    // (TRDD-THRGX41P) — warn instead. The keep-warm pinger routes through deny() so its
    // USER-ordered advisory wording is preserved.
    if (fork || keepWarm) {
      return deny('THRASH_ACTIVE',
        `${thrashBase} A fork re-enters that prefix and multiplies the re-billing. Fix the source first. Override: AGENTLENS_GATE=off.`)
    }
    return {
      decision: 'warn', code: 'THRASH_ACTIVE',
      reason: `[agentlens] ${thrashBase} This fresh launch pays only its own boot prefix (forks stay denied) — ` +
        `diagnose the source before widening fan-outs.`,
    }
  }
  if (state.startsLast60s >= th.runaway60s) {
    // The COUNT stays machine-wide — this deny protects the machine's cache, and scoping its
    // trigger to one project would quietly weaken a safety gate. Only the IDENTITIES are dropped.
    const kinds = fmtOwnAgentTypes(state)
    return deny('RUNAWAY_FANOUT',
      `AgentLens burn-gate: ${state.startsLast60s} subagent launches in the last 60s — runaway fan-out` +
      `${kinds ? `. From this project: ${kinds}` : ''}. Let the in-flight wave settle, then relaunch this agent ` +
      `(retry in ~60s is usually enough). Override: AGENTLENS_GATE=off.`)
  }
  if (coldResume && state.startsLast2min >= 1) {
    const stallWho = fmtStallOrigin(state)
    // The TTL here is the SUBAGENT tier (module note above): the launches this rule holds back
    // are fresh agent conversations whose shared prefix entries ride the 5-min tier regardless
    // of the caller's regime — a 1h main-session entry does not warm a fan-out's agent prefixes.
    return deny('COLD_RESUME_FANOUT',
      `AgentLens burn-gate: a rate-limit stall ended ${Math.round((stallAgeMs as number) / 60_000)}min ago` +
      `${stallWho}, so the fan-out's agent prefix caches are past their ${ttlPhrase(SUBAGENT_TTL)}, and ` +
      `${state.startsLast2min} agent(s) already launched since — that first launch IS the cache warm-up. ` +
      `Every further agent launched before it lands re-pays the full prefix at the write rate. ` +
      `Retry this launch in ~60s. Override: AGENTLENS_GATE=off.`)
  }
  if (fork && fat && cold && state.startsLast2min >= 2) {
    const kinds = fmtOwnAgentTypes(state)
    return deny('FORK_STORM_FORMING',
      `AgentLens burn-gate: fork of a ~${parentK}-token parent into a COLD cache (idle ${idleMin}min > its ` +
      `${ttlPhrase(ttl)}) with ${state.startsLast2min} launches already in 2min${kinds ? ` (${kinds})` : ''} — a fork ` +
      `storm is forming; each fork re-pays the full parent prefix at the cache-WRITE rate. Warm the cache with ` +
      `ONE agent first, or compact the parent before fanning out. Retry in ~60s. Override: AGENTLENS_GATE=off.`)
  }

  // ── warn tier: real cost, but a single launch is a legitimate choice ─────────
  // The keep-warm pinger skips the warn tier entirely: COLD_FORK/"warm the cache first" advice is
  // vacuous for the warm-up itself, and a scheduled pinger would re-trigger it on every ping.
  if (keepWarm) {
    return { decision: 'allow', code: null, reason: null }
  }
  if (fork && fat && cold) {
    return {
      decision: 'warn', code: 'COLD_FORK',
      reason: `[agentlens] cache cold (idle ${idleMin}min > the parent's ${ttlPhrase(ttl)}): this fork re-pays ` +
        `~${parentK} tokens of parent prefix at the write rate once. Let it warm the cache before launching ` +
        `further forks.`,
    }
  }
  if (fork && fat) {
    return {
      decision: 'warn', code: 'FORK_FAT_PARENT',
      reason: `[agentlens] fork inherits ~${parentK} tokens of parent prefix (warm cache — read rate). ` +
        `Compact before large fan-outs to shrink what every fork re-reads.`,
    }
  }
  // THRASH_UNATTRIBUTED was retired from the model-facing channels (2026-08-07). By construction it
  // reported writes that could NOT be tied to any session, so it could never be shown to be the
  // caller's own work, and its only instruction was "go run investigate_burn" — a question for the
  // CLI, not an interruption. The DETECTION is untouched: it still reaches the dashboard, --risk
  // and investigate_burn, where it is answered on request.
  const ownStarts = ownLaunches(state)
  if (ownStarts >= th.fanoutWarn2min) {
    const premiumHint =
      state.premiumShare !== null && state.premiumShare > 0.5 && typeof input.model !== 'string'
        ? ` Recent traffic is on ${state.premiumModel ?? 'a premium model'} and this launch does not pin a model — ` +
          `fan-out agents inherit it; pin a cheaper one (model: 'sonnet' or 'haiku') for mechanical work.`
        : ''
    const kinds = fmtOwnAgentTypes(state)
    return {
      decision: 'warn', code: 'FANOUT_HEADSUP',
      reason: `[agentlens] ${ownStarts} agent launches from this project in the last 2min — fan-out in progress` +
        `${kinds ? ` (${kinds})` : ''}.${premiumHint}`,
    }
  }

  return { decision: 'allow', code: null, reason: null }
}

/**
 * Resolve a SendMessage target's liveness from the SubagentStart/Stop hook-event ring. The
 * resume-risk the message gate blocks exists ONLY for a DEAD target (its resume re-runs the
 * request that killed it); a LIVE target consumes the message inside its already-running turn.
 * `to` matches hook payloads only when it is an agent id (bare or `agent-`-prefixed) — a NAME
 * has no hook-event counterpart, so name targets honestly resolve 'unknown' (→ warn, not deny).
 * 'main' is the caller's own live conversation by definition.
 */
export function resolveMessageTargetLiveness(
  target: unknown,
  events: Array<{ ts: number; ev: string; payload?: Record<string, unknown> | null }>,
): TargetLiveness {
  if (typeof target !== 'string' || target.length === 0) return 'unknown'
  if (target === 'main') return 'live'
  const id = target.startsWith('agent-') ? target.slice('agent-'.length) : target
  let verdict: TargetLiveness = 'unknown'
  let lastTs = -1
  for (const e of events) {
    if (e.ev !== 'SubagentStart' && e.ev !== 'SubagentStop') continue
    if (e.payload?.agent_id !== id) continue
    if (e.ts >= lastTs) {
      lastTs = e.ts
      verdict = e.ev === 'SubagentStart' ? 'live' : 'dead'
    }
  }
  return verdict
}

/**
 * SendMessage burn gate (P6) — the narrower sibling of evaluateAgentGate. A SendMessage to a
 * DEAD agent resumes it from its transcript, i.e. it RE-RUNS the request that killed it: when
 * the target died in a rate-limit stall the prompt cache is past its TTL, so the resume re-pays
 * the agent's full prefix at the cache-WRITE rate — the same mechanism the launch gate blocks.
 *
 * ONLY the two high-confidence conditions below may deny (both reused from evaluateAgentGate's
 * state), and ONLY against a target whose liveness resolves DEAD (2026-07-11 field fix: the gate
 * was denying messages to LIVE running agents under THRASH_ACTIVE — delivery to a live agent
 * rides its existing run, no resume happens). Liveness 'unknown' downgrades the deny to a
 * warning: a hard deny needs positive dead evidence. Routine messaging must NEVER be denied —
 * no fan-out/fork signature applies to a message, and a chatty gate on the team-coordination
 * channel would get AGENTLENS_GATE=off'd immediately. No warn tier for quiet states either:
 * a message is cheap when the two disaster states are absent.
 */
export function evaluateSendMessageGate(state: AgentGateState): AgentGateDecision {
  const th = { ...DEFAULT_GATE_THRESHOLDS, ...state.thresholds }
  const stallAgeMs = state.lastStopFailureMs !== null ? state.now - state.lastStopFailureMs : null
  // Same evidence-based disarm as the launch gate: a warm post-stall response from the stalled
  // session ends the cold-resume window early; the 10-min timer is only the no-evidence fallback.
  const coldResume = stallAgeMs !== null && stallAgeMs >= 0 && stallAgeMs <= th.coldResumeWindowMs
    && state.stallRecovered !== true
  const liveness = state.targetLiveness ?? 'unknown'
  const who = state.messageTarget ? ` '${state.messageTarget}'` : ''

  // A LIVE target rides its own already-running request stream — no resume, no re-run, nothing
  // for either disaster state to multiply. Never gate live messaging.
  if (liveness === 'live') return { decision: 'allow', code: null, reason: null }

  const deny = (code: AgentGateDecision['code'], reason: string): AgentGateDecision =>
    liveness === 'unknown'
      // No positive dead evidence → never hard-deny; surface the risk as a warning instead.
      ? { decision: 'warn', code, reason: `[target${who} liveness unknown — deny downgraded to warning] ${reason}` }
      : state.mode === 'enforce'
        ? { decision: 'deny', code, reason }
        : { decision: 'warn', code, reason: `[deny downgraded to warning: AGENTLENS_GATE_MODE=warn] ${reason}` }

  if (state.thrash?.active) {
    return deny('THRASH_ACTIVE',
      `AgentLens burn-gate: cache-thrash in progress — ${state.thrash.count} calls in the last ` +
      `${Math.round(state.thrash.windowMs / 60_000)}min re-WROTE ~${k(state.thrash.rebilledTokens)} tokens of prefix ` +
      `instead of reading cache${state.thrash.model ? ` (model ${state.thrash.model})` : ''}. ${thrashSource(state.thrash)} ` +
      `Resuming a dead agent${who} now re-runs its whole transcript into the thrashing prefix. Fix the source first. ` +
      `Override: AGENTLENS_GATE=off.`)
  }
  if (coldResume) {
    const stallWho = fmtStallOrigin(state)
    // A dead SendMessage target is a SUBAGENT conversation by construction ('main' resolves live
    // above), so the resume-cost premise uses the subagent tier — 5 min ALWAYS per the doc
    // matrix, whatever the caller's own regime is (TRDD-VY1IUVUM).
    return deny('COLD_RESUME_MESSAGE',
      `AgentLens burn-gate: a rate-limit stall ended ${Math.round((stallAgeMs as number) / 60_000)}min ago` +
      `${stallWho} — messaging a dead agent${who} resumes it by RE-RUNNING the request that killed it, and with ` +
      `the agent's prompt cache past its ${ttlPhrase(SUBAGENT_TTL)} that resume re-pays its full prefix at the ` +
      `write rate. Wait ~60s for the wall to clear, then retry this message. Override: AGENTLENS_GATE=off.`)
  }
  return { decision: 'allow', code: null, reason: null }
}

/**
 * Cache-guard for image reads — the PRE-FLIGHT counterpart to the post-hoc resident-cost report
 * (src/shared/residentCost.ts). Absorbs the useful half of `0x0funky/claude-cache-guard`.
 *
 * PREMISE CORRECTION, deliberate and load-bearing. That project's central claim is that an image
 * ANYWHERE in a request invalidates the entire messages tier, so the next call rewrites the whole
 * conversation at the cache-WRITE rate (they report ~700x overhead). This repo cannot corroborate
 * that for Claude Code: `CacheBreakCause` enumerates the break causes measured here — tools
 * added/reordered, model/effort/fast-mode switches, MCP toggles, plugin+skill reloads, account
 * switch, tool deny, injected-block mutation, compaction — and an image read is NOT among them.
 * Shipping their framing would mean denying a hot-path tool on an uncorroborated mechanism, i.e.
 * manufacturing exactly the confident false culprit CLAUDE.md warns about.
 *
 * What IS measured here is the RESIDENT cost: `cost ≈ turns × per-turn-context`, so an image block
 * is re-billed on every turn from the one that added it until a compaction evicts it. That is real,
 * it is large in a fat session, and — conveniently — every remedy is the same (delegate the look to
 * a subagent, batch reads into one turn, write findings down instead of re-reading). So the advice
 * survives the correction intact; only the mechanism sentence and the price tag change.
 *
 * WARN ONLY, on purpose. This module's contract is "deny only high-confidence disaster
 * signatures ... a gate that cries wolf gets AGENTLENS_GATE=off'd and then prevents nothing", and
 * a per-turn resident tax is not the same class of event as a forming fork storm. Read is also a
 * hot path where a false deny is maximally annoying. `imgDenyTokens` exists and is honoured as the
 * "this is now dominating the session" phrasing trigger; arming it to actually deny is a one-line
 * change once the per-image token cost is MEASURED here (today's two available figures disagree by
 * ~40x, so no number is quoted at all rather than a wrong one).
 */
export function evaluateImageReadGate(
  toolInput: Record<string, unknown> | null | undefined,
  state: AgentGateState,
): AgentGateDecision {
  const th = { ...DEFAULT_GATE_THRESHOLDS, ...state.thresholds }
  const allow: AgentGateDecision = { decision: 'allow', code: null, reason: null }
  const input = toolInput ?? {}
  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  if (!isImageReadPath(filePath)) return allow

  // No readable transcript ⇒ no context size ⇒ no claim. A warning needs a real number behind it;
  // inventing one is how a gate earns its way onto the ignore list.
  const ctx = state.parent.contextTokens
  if (ctx === null || ctx < th.imgWarnTokens) return allow

  const name = filePath.split('/').filter(Boolean).pop() ?? filePath
  const dominating = ctx >= th.imgDenyTokens
    ? ' This session is already large enough that resident blocks dominate its per-turn cost.'
    : ''
  return {
    decision: 'warn', code: 'IMG_RESIDENT',
    reason: `[agentlens cache-guard] reading ${name} into a ~${k(ctx)}-token session. An image block is ` +
      `RESIDENT: it rides forward in the prefix and is re-billed on EVERY later turn until a compaction ` +
      `evicts it — the cost is not the one read, it is the read times every turn that follows.${dominating} ` +
      `Cheapest first: (1) delegate the look to a subagent — it reads the image in ITS small context and ` +
      `returns a text verdict, so nothing lands here; (2) if you look here, read every image you need in ` +
      `ONE message and draw the conclusions in that same turn — batching costs no more than one; ` +
      `(3) write the verdict down and never re-read the file. Silence: AGENTLENS_CACHE_GUARD=off.`,
  }
}

/**
 * PostToolUse advisory — the in-band "notify the MODEL" channel. Returns ONE short warning
 * when a burn pattern is active as an agent wave completes, or null. The caller (server)
 * dedupes per session+code so injections stay RARE: per-call injections that later get
 * stripped in place are themselves a cache-break cause (the lean-ctx lesson, issue #778).
 */
export function buildAdvisory(state: AgentGateState): { code: string; text: string } | null {
  const th = { ...DEFAULT_GATE_THRESHOLDS, ...state.thresholds }
  if (state.thrash?.active) {
    return {
      code: 'THRASH_ACTIVE',
      text: `⚠ AgentLens: cache-thrash detected while your agents ran — ${state.thrash.count} calls re-wrote ` +
        `~${k(state.thrash.rebilledTokens)} tokens of prefix each turn instead of reading cache` +
        `${state.thrash.model ? ` (model ${state.thrash.model})` : ''}. ${thrashSource(state.thrash)} ` +
        `Do NOT launch more agents until the source is fixed.`,
    }
  }
  // Only ONE other advisory survives, and only when it is the caller's OWN fan-out. Two were
  // retired here on 2026-08-07 because they failed the bar this channel is held to — a message put
  // in front of a model must be about its own project, actionable right now, and significant:
  //   • THRASH_UNATTRIBUTED — writes that could not be tied to ANY session, so never provably the
  //     reader's, and its only instruction was to go run a CLI command later.
  //   • FAN_OUT_COLD_START — its own closing words were "No action needed", which is the
  //     definition of a fact rather than an alert. It existed to stop a human mistaking a fan-out
  //     for thrash while debugging; explaining is not the same as interrupting.
  // Both DETECTIONS are untouched and still reach the dashboard, --risk and investigate_burn.
  const ownStarts = ownLaunches(state)
  if (ownStarts >= th.fanoutWarn2min) {
    const premium =
      state.premiumShare !== null && state.premiumShare > 0.5
        ? ` Most of that traffic is on ${state.premiumModel ?? 'a premium model'} — pin cheaper models on fan-out agents.`
        : ''
    const kinds = fmtOwnAgentTypes(state)
    return {
      code: 'FANOUT_HEADSUP',
      text: `⚠ AgentlensPro: ${ownStarts} agent launches from this project in the last 2min` +
        `${kinds ? ` (${kinds})` : ''}.${premium} Check headroom before widening the fan-out: agentlenspro-cli --risk.`,
    }
  }
  return null
}
