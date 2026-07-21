import { useState, useEffect } from 'preact/hooks'

// Session-lifecycle timeline (TRDD-EYA3X5MQ). Renders the typed lifecycle events the server maps from
// the hook-event store (/api/lifecycle-events): /clear (the cost REMEDY that resets the transcript
// floor), /compact, resume, fork, startup, session-end, and turn-death (StopFailure). The per-turn
// STOP event is excluded by default (noise). This is a webview view-model — the LifecycleEvent shape
// is defined locally (it is NOT a src/shared export, so it does not trip check-mirrors).
type LifecycleKind =
  | 'STARTUP' | 'CLEAR' | 'COMPACT' | 'RESUME' | 'FORK' | 'SESSION_END'
  | 'STOP' | 'STOP_FAILURE' | 'PRE_COMPACT' | 'POST_COMPACT' | 'CONFIG_CHANGE'

interface LifecycleEvent { ts: number; session?: string; kind: LifecycleKind; detail?: string; ev: string }

// One colour + glyph per kind. /clear is GREEN (the remedy); turn-death RED; compaction ORANGE; the
// rest muted. Colours are mid-tones legible on both light and dark themes (no per-theme override).
const KIND_STYLE: Record<LifecycleKind, { color: string; glyph: string; label: string }> = {
  CLEAR:        { color: '#66bb6a', glyph: '↺', label: '/clear' },
  STARTUP:      { color: '#4fc3f7', glyph: '▶', label: 'startup' },
  RESUME:       { color: '#4dabf5', glyph: '⤾', label: 'resume' },
  FORK:         { color: '#7986cb', glyph: '⑂', label: 'fork' },
  COMPACT:      { color: '#ffa726', glyph: '⇲', label: '/compact (session)' },
  PRE_COMPACT:  { color: '#ffb74d', glyph: '⇲', label: 'pre-compact' },
  POST_COMPACT: { color: '#ffcc80', glyph: '⇲', label: 'post-compact' },
  STOP_FAILURE: { color: '#ef5350', glyph: '✕', label: 'turn death' },
  SESSION_END:  { color: '#90a4ae', glyph: '■', label: 'session end' },
  CONFIG_CHANGE:{ color: '#ba68c8', glyph: '⚙', label: 'config change' },
  STOP:         { color: 'var(--muted)', glyph: '·', label: 'turn stop' },
}

// The kinds offered as filter chips (STOP is opt-in — it fires every turn and is pure noise here).
const FILTERABLE: LifecycleKind[] = ['CLEAR', 'COMPACT', 'STARTUP', 'RESUME', 'FORK', 'STOP_FAILURE', 'SESSION_END', 'CONFIG_CHANGE']

// Cache-breaking slash commands (TRDD-EYA3X5MQ). A SEPARATE source from the hook store above: these
// are read straight out of the Claude Code transcripts, so they need no hook installed and cover the
// whole history. `mutation` is the honest part — a bare /plugin or /mcp only OPENS a picker, so it
// may have cost nothing; `reload-cost` on the CLI is what settles that against the actual turn.
//
// The vocabulary and its styling are IMPORTED from src/shared/, never re-declared here: the first
// version of this tab kept a private copy of the union and the style map, and adding EFFORT_CHANGED
// to the host left this copy silently stale (the chip fell through to a raw enum name). check-mirrors
// now fails the build if these symbols reappear as local declarations.
import { CACHE_RISK_STYLE as RISK_STYLE, type CacheRiskKind, type MutationCertainty } from '../../../src/shared/cacheRiskKinds'

interface RiskCommand { ts: number; session?: string; command: string; args?: string; kind: CacheRiskKind; mutation: MutationCertainty }

function CacheRiskCommands() {
  const [cmds, setCmds] = useState<RiskCommand[]>([])
  const [total, setTotal] = useState(0)
  const [kindCounts, setKindCounts] = useState<Record<string, number>>({})
  const [days, setDays] = useState(7)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    fetch(`/api/cache-risk-commands?window=${days * 24}&limit=300`)
      .then(r => r.json())
      .then((d: { commands?: RiskCommand[]; total?: number; byKind?: Record<string, number> }) => {
        if (!live) return
        const list = Array.isArray(d.commands) ? d.commands : []
        setCmds(list)
        // The list is capped; show the TRUE total so a capped view never reads as the whole story.
        setTotal(typeof d.total === 'number' ? d.total : list.length)
        setKindCounts(d.byKind ?? {})
      })
      .catch(() => { if (live) { setCmds([]); setTotal(0); setKindCounts({}) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [days])

  const byKind = Object.entries(kindCounts).sort((a, b) => b[1] - a[1]) as Array<[CacheRiskKind, number]>

  return (
    <div style="margin-bottom:26px">
      <div style="font-size:14px;font-weight:600;margin-bottom:2px">Cache-breaking commands</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:10px">
        Slash commands that rewrite the cached prefix, read from the Claude Code transcripts (no hook needed).
        The cost lands on the NEXT model turn — run <code>agentlenspro reload-cost</code> for the tokens and $ per event.
      </div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:10px">
        {[1, 7, 30].map(d => (
          <button key={d} onClick={() => setDays(d)}
            style={`font-size:10px;padding:2px 8px;border-radius:10px;cursor:pointer;border:1px solid ${days === d ? '#4fc3f7' : 'var(--border,#3a3a3a)'};background:${days === d ? '#4fc3f722' : 'transparent'};color:${days === d ? '#4fc3f7' : 'var(--muted)'}`}>
            {d}d
          </button>
        ))}
        <span style="font-size:11px;color:var(--muted);margin-left:6px">
          {loading ? 'scanning…' : total > cmds.length
            ? `showing ${cmds.length} of ${total} commands`
            : `${total} command${total === 1 ? '' : 's'}`}
        </span>
      </div>

      {!loading && byKind.length > 0 && (
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
          {byKind.map(([k, n]) => (
            <span key={k} style={`font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid ${(RISK_STYLE[k]?.color ?? '#888')}55;color:${RISK_STYLE[k]?.color ?? 'var(--muted)'}`}>
              {RISK_STYLE[k]?.label ?? k} · {n}
            </span>
          ))}
        </div>
      )}

      <div style="display:flex;flex-direction:column;gap:1px">
        {cmds.map((c, i) => (
          <div key={i} style="display:flex;align-items:center;gap:10px;padding:4px 8px;font-size:11px">
            <span style={`color:${RISK_STYLE[c.kind]?.color ?? 'var(--muted)'};width:150px;font-weight:600`}>{c.command}{c.args ? ` ${c.args}` : ''}</span>
            <span style="color:var(--muted);width:170px">{new Date(c.ts).toLocaleString()}</span>
            <span style={`color:${RISK_STYLE[c.kind]?.color ?? 'var(--muted)'};width:130px`}>{RISK_STYLE[c.kind]?.label ?? c.kind}</span>
            <span style={`width:80px;color:${c.mutation === 'certain' ? 'var(--muted)' : '#ffca28'}`} title={c.mutation === 'certain' ? 'always rewrites the prefix' : 'may have opened a picker and changed nothing — reload-cost settles it against the actual turn'}>{c.mutation}</span>
            <span style="color:var(--muted);opacity:.7;font-family:var(--mono,monospace);font-size:10px">{(c.session ?? '').slice(0, 8)}</span>
          </div>
        ))}
        {!loading && cmds.length === 0 && <div style="font-size:12px;color:var(--muted);padding:8px 0">No cache-breaking commands in this window.</div>}
      </div>
    </div>
  )
}

export function Lifecycle() {
  const [events, setEvents] = useState<LifecycleEvent[]>([])
  const [dirExists, setDirExists] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<LifecycleKind>>(new Set())

  useEffect(() => {
    let live = true
    const qs = selected.size ? `?kinds=${[...selected].join(',')}&limit=300` : '?limit=300'
    setLoading(true)
    fetch('/api/lifecycle-events' + qs)
      .then(r => r.json())
      .then((d: { dirExists?: boolean; events?: LifecycleEvent[] }) => {
        if (!live) return
        setDirExists(d.dirExists !== false)
        setEvents(Array.isArray(d.events) ? d.events : [])
        setError(null)
      })
      .catch(e => { if (live) setError(String(e)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [selected])

  const toggle = (k: LifecycleKind) => {
    const next = new Set(selected)
    next.has(k) ? next.delete(k) : next.add(k)
    setSelected(next)
  }

  const clears = events.filter(e => e.kind === 'CLEAR').length

  return (
    <div style="padding:12px 16px;max-width:1100px">
      <CacheRiskCommands />
      <div style="font-size:14px;font-weight:600;margin-bottom:2px">Session lifecycle</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px">
        Harness events that bound and RESET a session — <span style="color:#66bb6a">/clear</span> (the cost
        remedy that resets the transcript floor), compaction, resume/fork, session-end, and turn-death.
        Fed by the lifecycle hook store; high-volume per-turn stops and per-session ends are hidden by default (opt in via the chips).
      </div>

      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        {FILTERABLE.map(k => {
          const on = selected.has(k)
          const s = KIND_STYLE[k]
          return (
            <button key={k} onClick={() => toggle(k)} title={`filter: ${s.label}`}
              style={`font-size:10px;padding:2px 8px;border-radius:10px;cursor:pointer;border:1px solid ${on ? s.color : 'var(--border,#3a3a3a)'};background:${on ? s.color + '22' : 'transparent'};color:${on ? s.color : 'var(--muted)'}`}>
              {s.glyph} {s.label}
            </button>
          )
        })}
        {selected.size > 0 && (
          <button onClick={() => setSelected(new Set())} style="font-size:10px;padding:2px 8px;border-radius:10px;cursor:pointer;border:1px solid var(--border,#3a3a3a);background:transparent;color:var(--muted)">clear filter</button>
        )}
      </div>

      {!dirExists && (
        <div style="font-size:12px;color:#ffb74d;padding:10px;border:1px solid #ffb74d55;border-radius:6px;margin-bottom:12px">
          No lifecycle hook store yet. Run <code>agentlenspro --install-hooks</code> then restart your Claude session to capture /clear and other lifecycle events.
        </div>
      )}
      {error && <div style="font-size:12px;color:#ef5350">Failed to load: {error}</div>}
      {loading && <div style="font-size:12px;color:var(--muted)">Loading…</div>}

      {!loading && !error && dirExists && (
        <>
          <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
            {events.length} event{events.length === 1 ? '' : 's'}{clears > 0 ? ` · ${clears} /clear` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:1px">
            {events.map((e, i) => {
              const s = KIND_STYLE[e.kind] ?? KIND_STYLE.STOP
              return (
                <div key={i} style="display:flex;align-items:center;gap:10px;padding:4px 8px;font-size:11px;border-left:3px solid transparent"
                  onMouseEnter={ev => (ev.currentTarget as HTMLElement).style.background = 'var(--hover,#ffffff0a)'}
                  onMouseLeave={ev => (ev.currentTarget as HTMLElement).style.background = 'transparent'}>
                  <span style={`color:${s.color};font-weight:700;width:14px;text-align:center`}>{s.glyph}</span>
                  <span style={`color:${s.color};width:150px;font-weight:600`}>{s.label}</span>
                  <span style="color:var(--muted);width:170px">{new Date(e.ts).toLocaleString()}</span>
                  {e.detail && <span style="color:var(--muted);width:110px" title="source / reason / trigger / error_type">{e.detail}</span>}
                  <span style="color:var(--muted);opacity:.7;font-family:var(--mono,monospace);font-size:10px">{(e.session ?? '').slice(0, 8)}</span>
                </div>
              )
            })}
            {events.length === 0 && <div style="font-size:12px;color:var(--muted);padding:8px 0">No lifecycle events in the selected set.</div>}
          </div>
        </>
      )}
    </div>
  )
}
