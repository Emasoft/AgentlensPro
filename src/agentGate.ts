// Agent-launch burn gate — the PREVENTION half of the guard stack (TRDD-GOD0108C).
//
// evaluateAgentGate() is the pure decision core behind POST /api/agent-gate, called by
// scripts/spy-agentlens-gate.sh from a PreToolUse hook matched on Agent|Task|Workflow ONLY.
// It answers one question in-memory: "will THIS launch, right now, multiply a burn that is
// already forming?" — and denies only the four high-confidence disaster signatures measured
// in the 2026-07-10 incident. Everything ambiguous is a warning or a silent allow: a gate
// that cries wolf gets AGENTLENS_GATE=off'd and then prevents nothing.
//
// Deny reasons are written FOR THE MODEL (Claude Code feeds permissionDecisionReason back
// to the agent): each names the mechanism, the measured cost, and the concrete retry path.

import * as fs from 'fs'
import { fmtFatSenders, type ThrashReport } from './bodiesActivity'

export interface GateThresholds {
  /** Parent context (tokens) above which a fork inherits a "fat" prefix (default 200k). */
  forkFatTokens: number
  /** Idle ms after which the prompt cache is past its 5-min TTL (default 5.5min). */
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
  coldIdleMs: 330_000,
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
  thrash: ThrashReport | null
  /** Share (0..1) of the last-5min responses on premium models + the model seen. */
  premiumShare: number | null
  premiumModel: string | null
  thresholds?: Partial<GateThresholds>
}

export interface AgentGateDecision {
  decision: 'allow' | 'warn' | 'deny'
  code:
    | 'THRASH_ACTIVE' | 'RUNAWAY_FANOUT' | 'COLD_RESUME_FANOUT' | 'FORK_STORM_FORMING'
    | 'FORK_FAT_PARENT' | 'COLD_FORK' | 'FANOUT_HEADSUP'
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

export function evaluateAgentGate(
  toolInput: Record<string, unknown> | null | undefined,
  state: AgentGateState,
): AgentGateDecision {
  const th = { ...DEFAULT_GATE_THRESHOLDS, ...state.thresholds }
  const input = toolInput ?? {}
  const fork = input.subagent_type === 'fork'
  const cold = state.parent.idleMs !== null && state.parent.idleMs > th.coldIdleMs
  const idleMin = state.parent.idleMs !== null ? Math.round(state.parent.idleMs / 60_000) : null
  const fat = state.parent.contextTokens !== null && state.parent.contextTokens >= th.forkFatTokens
  const parentK = state.parent.contextTokens !== null ? k(state.parent.contextTokens) : 'an unknown amount of'
  const stallAgeMs = state.lastStopFailureMs !== null ? state.now - state.lastStopFailureMs : null
  const coldResume = stallAgeMs !== null && stallAgeMs >= 0 && stallAgeMs <= th.coldResumeWindowMs

  const deny = (code: AgentGateDecision['code'], reason: string): AgentGateDecision =>
    state.mode === 'enforce'
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
    return deny('COLD_RESUME_FANOUT',
      `AgentLens burn-gate: a rate-limit stall ended ${Math.round((stallAgeMs as number) / 60_000)}min ago` +
      `${stallWho}, so the prompt cache is past its 5-min TTL, and ${state.startsLast2min} agent(s) already ` +
      `launched since — that first launch IS the cache warm-up. Wait for it to finish before launching more ` +
      `(measured incident: 14 forks resumed into a cold cache = 883k tokens in 33s). Retry this launch in ~60s. ` +
      `Override: AGENTLENS_GATE=off.`)
  }
  if (fork && fat && cold && state.startsLast2min >= 2) {
    const who = fmtSpawners(state.spawners)
    return deny('FORK_STORM_FORMING',
      `AgentLens burn-gate: fork of a ~${parentK}-token parent into a COLD cache (idle ${idleMin}min > 5-min TTL) ` +
      `with ${state.startsLast2min} launches already in 2min${who ? ` (${who})` : ''} — a fork storm is forming; ` +
      `each fork re-pays the full parent prefix at the cache-WRITE rate. Warm the cache with ONE agent first, or ` +
      `compact the parent before fanning out. Retry in ~60s. Override: AGENTLENS_GATE=off.`)
  }

  // ── warn tier: real cost, but a single launch is a legitimate choice ─────────
  if (fork && fat && cold) {
    return {
      decision: 'warn', code: 'COLD_FORK',
      reason: `[agentlens] cache cold (idle ${idleMin}min): this fork re-pays ~${parentK} tokens of parent prefix at ` +
        `the write rate once. Let it warm the cache before launching further forks.`,
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
      text: `⚠ AgentLens: ${state.startsLast2min} agent launches in the last 2min${who ? ` (${who})` : ''}.${premium} ` +
        `Check headroom before widening the fan-out: agentlens-cli --risk.`,
    }
  }
  return null
}
