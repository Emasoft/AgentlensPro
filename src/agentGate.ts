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
import { fmtFatSenders, type ThrashReport } from './bodiesActivity'
import {
  ASSUMED_TTL_REGIME, COLD_IDLE_SLACK_MS, DEFAULT_COLD_IDLE_MS,
  classifyTtlRegime, ttlPhrase, type TtlRegime,
} from './shared/cacheTtl'

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
}

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  forkFatTokens: 200_000,
  // Derived, not hardcoded: the shared 5-min tier + slack (TRDD-VY1IUVUM) — the fallback when no
  // per-session TTL regime was resolvable. With a resolved regime the cutoff scales with it.
  coldIdleMs: DEFAULT_COLD_IDLE_MS,
  runaway60s: 8,
  fanoutWarn2min: 5,
  coldResumeWindowMs: 600_000,
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
  thresholds?: Partial<GateThresholds>
}

export interface AgentGateDecision {
  decision: 'allow' | 'warn' | 'deny'
  code:
    | 'THRASH_ACTIVE' | 'RUNAWAY_FANOUT' | 'COLD_RESUME_FANOUT' | 'FORK_STORM_FORMING'
    | 'FORK_FAT_PARENT' | 'COLD_FORK' | 'FANOUT_HEADSUP' | 'COLD_RESUME_MESSAGE'
    | null
  reason: string | null
}

const k = (n: number): string => `${Math.round(n / 1000)}k`
const shortSid = (s: string | null): string => (s ? `${s.slice(0, 8)}…` : '?')
const dirName = (cwd: string | null): string => (cwd ? `…/${cwd.split('/').filter(Boolean).pop() ?? cwd}` : '')

/** Concise WHO-is-fanning-out string: top-2 spawners + "+N more".
 *  e.g. `session 777b8f52… in …/agentlens (6: workflow-subagent×5, fork×1)` */
function fmtSpawners(spawners: LaunchSpawner[] | undefined, cap = 2): string {
  if (!spawners || spawners.length === 0) return ''
  const parts = spawners.slice(0, cap).map(s => {
    const where = s.cwd ? ` in ${dirName(s.cwd)}` : ''
    const types = s.agentTypes.length > 0 ? `: ${s.agentTypes.join(', ')}` : ''
    return `session ${shortSid(s.session)}${where} (${s.count}${types})`
  })
  const more = spawners.length > cap ? `; +${spawners.length - cap} more` : ''
  return parts.join('; ') + more
}

/** "Likely source" clause for thrash messages — honest when attribution failed. */
function thrashSource(t: ThrashReport): string {
  return t.suspects.length > 0
    ? `Likely source: ${fmtFatSenders(t.suspects)}.`
    : 'Source not attributable from the fat requests — run investigate_burn --windowHours 1 to name it.'
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
    return deny('THRASH_ACTIVE',
      `AgentLens burn-gate: cache-thrash in progress — ${state.thrash.count} calls in the last ` +
      `${Math.round(state.thrash.windowMs / 60_000)}min re-WROTE ~${k(state.thrash.rebilledTokens)} tokens of prefix ` +
      `instead of reading cache${state.thrash.model ? ` (model ${state.thrash.model})` : ''}, i.e. something mutates ` +
      `the context prefix on every call so the cache never hits. ${thrashSource(state.thrash)} Launching more agents ` +
      `multiplies the re-billing. Fix the source first. Override: AGENTLENS_GATE=off.`)
  }
  if (state.startsLast60s >= th.runaway60s) {
    const who = fmtSpawners(state.spawners)
    return deny('RUNAWAY_FANOUT',
      `AgentLens burn-gate: ${state.startsLast60s} subagent launches in the last 60s — runaway fan-out` +
      `${who ? `. Spawners: ${who}` : ''}. Let the in-flight wave settle, then relaunch this agent ` +
      `(retry in ~60s is usually enough). Override: AGENTLENS_GATE=off.`)
  }
  if (coldResume && state.startsLast2min >= 1) {
    const stallWho = state.stall
      ? ` (turn died in session ${shortSid(state.stall.session)}${state.stall.cwd ? ` in ${dirName(state.stall.cwd)}` : ''})`
      : ''
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
    const who = fmtSpawners(state.spawners)
    return deny('FORK_STORM_FORMING',
      `AgentLens burn-gate: fork of a ~${parentK}-token parent into a COLD cache (idle ${idleMin}min > its ` +
      `${ttlPhrase(ttl)}) with ${state.startsLast2min} launches already in 2min${who ? ` (${who})` : ''} — a fork ` +
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
  if (state.startsLast2min >= th.fanoutWarn2min) {
    const premiumHint =
      state.premiumShare !== null && state.premiumShare > 0.5 && typeof input.model !== 'string'
        ? ` Recent traffic is on ${state.premiumModel ?? 'a premium model'} and this launch does not pin a model — ` +
          `fan-out agents inherit it; pin a cheaper one (model: 'sonnet' or 'haiku') for mechanical work.`
        : ''
    const who = fmtSpawners(state.spawners)
    return {
      decision: 'warn', code: 'FANOUT_HEADSUP',
      reason: `[agentlens] ${state.startsLast2min} agent launches in the last 2min — fan-out in progress` +
        `${who ? ` (${who})` : ''}.${premiumHint}`,
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
    const stallWho = state.stall
      ? ` (turn died in session ${shortSid(state.stall.session)}${state.stall.cwd ? ` in ${dirName(state.stall.cwd)}` : ''})`
      : ''
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
  if (state.startsLast2min >= th.fanoutWarn2min) {
    const premium =
      state.premiumShare !== null && state.premiumShare > 0.5
        ? ` Most of that traffic is on ${state.premiumModel ?? 'a premium model'} — pin cheaper models on fan-out agents.`
        : ''
    const who = fmtSpawners(state.spawners)
    return {
      code: 'FANOUT_HEADSUP',
      text: `⚠ AgentlensPro: ${state.startsLast2min} agent launches in the last 2min${who ? ` (${who})` : ''}.${premium} ` +
        `Check headroom before widening the fan-out: agentlenspro-cli --risk.`,
    }
  }
  // FAN_OUT_COLD_START (2026-07-11 field fix): N distinct sessions' one-time cold-start prefix
  // writes are the EXPECTED cost of a fan-out, not thrash — say so explicitly so nobody (human
  // or model) mistakes the burst for a cache-thrash and starts killing healthy agents. Advisory
  // only, and only when real money moved (≥2 fresh sessions, big writes).
  if (!state.thrash?.active && (state.thrash?.coldStartSessions ?? 0) >= 2) {
    const t = state.thrash as ThrashReport
    return {
      code: 'FAN_OUT_COLD_START',
      text: `AgentlensPro: ${t.coldStartSessions} freshly-spawned agent session(s) paid their one-time ` +
        `cold-start prefix writes (~${k(t.coldStartRebilledTokens)} tokens total) in the last ` +
        `${Math.round(t.windowMs / 60_000)}min — expected fan-out cost, NOT cache-thrash (no session ` +
        `re-wrote its prefix repeatedly). No action needed unless the same sessions keep re-writing.`,
    }
  }
  return null
}
