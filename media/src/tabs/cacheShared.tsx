import type { SessionSummaryCard } from '../types'

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
