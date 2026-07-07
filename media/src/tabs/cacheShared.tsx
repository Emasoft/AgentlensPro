import type { SessionSummaryCard, SpawnDetection } from '../types'
import { buildSpawnRollup } from '../spawnRollup'
import { calcSessionCost } from '../sessionMetrics'

// ── Sub-agent spawn-kind badge (shared by the Traces sub-branch rows + the Cache-tab fleet tree) ─
// The spawn METHOD decides the cache economics (Anthropic sub-agents / prompt-caching docs):
//   fork      → inherits the parent's system prompt + tools + history → its first request READS the
//               parent cache → cache-WARM, cheap. ✓
//   fresh     → own conversation + own system prompt/tool set → NO cache hit on first call, warms
//               only across its own turns, forced to the 5-min TTL. cache-COLD. ⚠
//   worktree  → runs in its own cwd; the system prompt embeds cwd/OS/git → a DIFFERENT prefix that
//               shares NO cache with the parent. cache-COLD + directory-isolated. ⚠⚠
//   fleet     → a Workflow orchestrating many fresh cold children — sum the fleet cold-start. ⚠
// A model override is a separate model cache (and on Haiku tools load into the prefix) → flagged too.

export interface SpawnBadge {
  label: string
  icon: string
  warm: boolean            // true = reads the parent cache (fork); false = cold start
  color: string
  title: string
}

const SPAWN_COLD = 'var(--vscode-charts-orange,#e2a03f)'
const SPAWN_WARM = 'var(--vscode-charts-green,#81c784)'
const SPAWN_ISOLATED = 'var(--error,#f44747)'

export function spawnBadgeFor(child: SessionSummaryCard): SpawnBadge | null {
  const kind = child.spawnKind
  if (!kind) return null
  switch (kind) {
    case 'fork':
      return { label: 'fork', icon: '✓', warm: true, color: SPAWN_WARM,
        title: 'Fork — inherits the parent conversation + tools; its first request reads the parent cache (cache-warm).' }
    case 'worktree':
      return { label: 'worktree', icon: '⚠⚠', warm: false, color: SPAWN_ISOLATED,
        title: 'Worktree-isolated — own cwd → a different system-prompt prefix that shares no cache with the parent (cache-cold + isolated).' }
    case 'fleet':
      return { label: 'fleet', icon: '⚠', warm: false, color: SPAWN_COLD,
        title: 'Workflow fleet — many fresh cold-cache children; each pays its own cold start.' }
    case 'fresh':
    default:
      return { label: 'fresh', icon: '⚠', warm: false, color: SPAWN_COLD,
        title: 'Fresh sub-agent — own system prompt + tool set, no cache hit on first call (cache-cold, 5-min TTL).' }
  }
}

// Inline badge cluster: the spawn-kind pill + warm/cold + an optional model-override pill.
export function spawnKindBadge(child: SessionSummaryCard): preact.JSX.Element | null {
  const b = spawnBadgeFor(child)
  if (!b) return null
  return (
    <span style="display:inline-flex;gap:4px;align-items:center">
      <span title={b.title}
        style={`font-size:9px;padding:1px 6px;border-radius:8px;font-weight:600;border:1px solid ${b.color};color:${b.color};background:${b.color}1a;white-space:nowrap`}>
        {b.icon} {b.label}
      </span>
      <span title={b.warm ? 'reads the parent cache' : 'cold cache start'}
        style={`font-size:8px;color:${b.warm ? SPAWN_WARM : SPAWN_COLD}`}>{b.warm ? 'warm' : 'cold'}</span>
      {child.spawnModelOverride && (
        <span title={`Model override: ${child.spawnModelOverride} — a separate model cache (and on Haiku, tools load into the prefix).`}
          style="font-size:8px;padding:1px 5px;border-radius:8px;border:1px solid var(--vscode-charts-purple,#b392f0);color:var(--vscode-charts-purple,#b392f0);white-space:nowrap">
          ⇄ {child.spawnModelOverride}
        </span>
      )}
    </span>
  )
}

// Session cache-hit rate (0..1) and its display colour: green ≥ threshold, orange within 15pts,
// red far below. Used for the SLI badge + the Cache-tab worst-sessions list.
export function hitRateColor(rate: number, threshold: number): string {
  if (rate >= threshold) return SPAWN_WARM
  if (rate >= threshold - 0.15) return SPAWN_COLD
  return SPAWN_ISOLATED
}

export function formatPct(rate: number): string {
  return (rate * 100).toFixed(rate >= 0.995 || rate === 0 ? 0 : 1) + '%'
}

// ── Spawn-cost rollup + advisor panel (TRDD-62E8UU41) ─────────────────────────
// Renders the fan-out aggregate for a set of sub-agent children (all of a session, or the children
// spawned by one turn) + any antipattern detections (FLEET-COLD / WORKTREE-SCATTER / MODEL-MIX). The
// cost callback is the webview's calcSessionCost token mode, so the panel's $ matches the trace header
// childCost. Shared by the Traces session-level panel and the per-turn spawn panel.

function fmtSpawnTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'k'
  return String(n)
}

// One spawn-kind mix pill (e.g. "3 fresh", "1 fork") — orange for cold kinds, green for warm forks,
// red for worktree isolation, and a distinct tone for the FAIL-FAST `unknown` bucket so it is visible.
function MixPill({ label, count, tone }: { label: string; count: number; tone: 'warm' | 'cold' | 'isolated' | 'override' | 'unknown' }) {
  if (count <= 0) return null
  const color = tone === 'warm' ? SPAWN_WARM
    : tone === 'isolated' ? SPAWN_ISOLATED
    : tone === 'override' ? 'var(--vscode-charts-purple,#b392f0)'
    : tone === 'unknown' ? 'var(--muted)'
    : SPAWN_COLD
  return (
    <span style={`font-size:9px;padding:1px 6px;border-radius:8px;border:1px solid ${color};color:${color};background:${color}1a;white-space:nowrap`}>
      {count} {label}
    </span>
  )
}

function DetectionRow({ d }: { d: SpawnDetection }) {
  // HIGH = red (the fleet-of-cold-forks burn); MEDIUM = orange (scatter / model-mix).
  const color = d.severity === 'HIGH' ? SPAWN_ISOLATED : SPAWN_COLD
  return (
    <div style={`font-size:11px;padding:6px 9px;border-radius:4px;border-left:3px solid ${color};background:var(--panel-bg);margin-top:6px;line-height:1.45`}>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
        <span style={`font-size:9px;font-weight:700;letter-spacing:.3px;padding:1px 6px;border-radius:3px;background:${color};color:#000`}>{d.code}</span>
        <span style="color:var(--muted);font-size:9px">
          {d.childCount} child{d.childCount !== 1 ? 'ren' : ''} · Σ {fmtSpawnTokens(d.wastedTokens)} cache-create{d.wastedCostUsd > 0 ? ` · $${d.wastedCostUsd.toFixed(2)}` : ''}
        </span>
      </div>
      <div>{d.message}</div>
      <div style="color:var(--muted);margin-top:2px">→ {d.remediation}</div>
    </div>
  )
}

export function SpawnCostPanel({ children, parentModel, heading }: {
  children: SessionSummaryCard[]; parentModel: string; heading?: string
}): preact.JSX.Element | null {
  if (!children.length) return null
  const rollup = buildSpawnRollup(children, { parentModel, costOf: c => calcSessionCost(c, 'token').totalUsd })
  const mix = rollup.kindMix
  const hasDetections = rollup.detections.length > 0
  // Red border when an antipattern fired (the burn is present), else the neutral orange spawn tint.
  const borderColor = hasDetections ? SPAWN_ISOLATED : 'var(--vscode-charts-orange,#e2a03f)'
  return (
    <div style={`border:1px solid ${borderColor};border-radius:5px;padding:8px 10px;margin:4px 0 8px`}>
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:4px">
        <strong style="font-size:11px">{heading ?? 'Spawn cost'}</strong>
        <span style="font-size:10px;color:var(--muted)">
          {rollup.childCount} child{rollup.childCount !== 1 ? 'ren' : ''} · Σ {fmtSpawnTokens(rollup.totalCacheCreateTokens)} cache-create · {fmtSpawnTokens(rollup.totalCacheReadTokens)} cache-read · {fmtSpawnTokens(rollup.totalOutputTokens)} out
          {rollup.totalCostUsd > 0 ? ` · $${rollup.totalCostUsd.toFixed(2)}` : ''}
        </span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">
        <MixPill label="fork" count={mix.fork} tone="warm" />
        <MixPill label="fresh" count={mix.fresh} tone="cold" />
        <MixPill label="fleet" count={mix.fleet} tone="cold" />
        <MixPill label="worktree" count={mix.worktree} tone="isolated" />
        <MixPill label="model-override" count={mix.modelOverride} tone="override" />
        <MixPill label="unknown" count={mix.unknown} tone="unknown" />
      </div>
      {hasDetections && rollup.detections.map(d => <DetectionRow key={d.code} d={d} />)}
    </div>
  )
}
