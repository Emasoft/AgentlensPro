import { useState } from 'preact/hooks'
import { rangedSessions, COLORS } from '../state'
import { getAgentColor, getAgentSourceLabel, formatCompact } from '../utils'
import type { SessionSummaryCard, FileOpSummary } from '../types'

// ── Shared donut chart (used by Tools tab and Sessions detail) ─────────────────

export function ToolsChart({ sessions, fileOps }: { sessions: SessionSummaryCard[]; fileOps?: FileOpSummary[] }) {
  const [sortKey, setSortKey] = useState<'calls' | 'name'>('calls')
  const counts: Record<string, number> = {}
  const toolAgents: Record<string, Record<string, boolean>> = {}

  sessions.forEach(sess => {
    Object.entries(sess.toolCounts ?? {}).forEach(([tool, count]) => {
      counts[tool] = (counts[tool] ?? 0) + count
      if (!toolAgents[tool]) toolAgents[tool] = {}
      toolAgents[tool][sess.source] = true
    })
  })

  // Donut slices stay count-ordered (largest arc first reads best); the table follows sortKey.
  const slicesOrder = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const entries = sortKey === 'name'
    ? Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]))
    : slicesOrder

  if (entries.length === 0) {
    return <div class="empty-state">No tool calls recorded for this session</div>
  }

  const total = entries.reduce((sum, e) => sum + e[1], 0)

  const r = 70, cx = 85, cy = 85, sw = 26
  const angleOffset = -Math.PI / 2
  let currentAngle = angleOffset

  function arcPath(startAngle: number, endAngle: number): string {
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle)
    const x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle)
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0
    return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`
  }

  const slices = slicesOrder.map((e, i) => {
    const pct = e[1] / total
    const sliceAngle = pct * 2 * Math.PI
    const color = COLORS[i % COLORS.length]
    const startA = currentAngle
    currentAngle += sliceAngle
    return { name: e[0], count: e[1], pct, color, startA, endA: currentAngle }
  })

  return (
    <div>
      <div class="donut-container">
        <svg width="170" height="170" viewBox="0 0 170 170">
          {slices.map(sl =>
            sl.pct >= 1
              ? <circle key={sl.name} cx={cx} cy={cy} r={r} fill="none" stroke={sl.color} stroke-width={sw} />
              : <path key={sl.name} d={arcPath(sl.startA, sl.endA)} fill="none" stroke={sl.color} stroke-width={sw} stroke-linecap="butt" />
          )}
          <text x={cx} y={cy} text-anchor="middle" dy="4" font-size="16" font-weight="bold" fill="var(--fg)">{total}</text>
          <text x={cx} y={cy + 14} text-anchor="middle" font-size="9" fill="var(--muted)" opacity="0.7">total</text>
        </svg>
        <div class="donut-legend">
          {slices.map(sl => (
            <div key={sl.name} class="donut-legend-item">
              <div class="donut-legend-color" style={'background:' + sl.color} />
              <span>{sl.name} ({sl.count}, {(sl.pct * 100).toFixed(1)}%)</span>
            </div>
          ))}
        </div>
      </div>

      {(() => {
        // Honest per-tool token attribution: per-CALL token usage is never recorded by agents
        // (they log usage per LLM turn). The file tools are the exception — their result byte
        // volumes ARE captured (fileOps), and file reads are the dominant context cost. Show those
        // as ~tokens (bytes/4, same estimate as the Files view) so the Tools view answers "tokens
        // per tool" with real data, and state plainly where the rest of the tokens are counted.
        if (!fileOps || fileOps.length === 0) return null
        const io = fileOps.reduce((s, o) => ({ r: s.r + o.readBytes, w: s.w + o.writeBytes, e: s.e + o.editBytes }), { r: 0, w: 0, e: 0 })
        const tok = (b: number) => Math.round(b / 4)
        const totalTok = tok(io.r + io.w + io.e)
        if (totalTok <= 0) return null
        return (
          <div style="margin-top:16px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--vscode-editorWidget-background,rgba(127,127,127,0.06))">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px">File-tool token weight</div>
            <div style="font-size:11px;display:flex;flex-wrap:wrap;gap:14px;align-items:baseline">
              <span title="Bytes the Read tool pulled into context across this session (≈ tokens)"><span style="color:var(--vscode-charts-blue,#4fc3f7)">●</span> Read ~{formatCompact(tok(io.r))} tok</span>
              {io.w > 0 && <span title="Bytes produced by the Write tool"><span style="color:var(--vscode-charts-green,#81c784)">●</span> Write ~{formatCompact(tok(io.w))} tok</span>}
              {io.e > 0 && <span title="Bytes changed by Edit-family tools"><span style="color:var(--vscode-charts-orange,#e2a03f)">●</span> Edit ~{formatCompact(tok(io.e))} tok</span>}
              <span style="color:var(--muted)">total ~{formatCompact(totalTok)} tok</span>
            </div>
            <div style="font-size:9px;color:var(--muted);margin-top:5px;opacity:.85">Agents log token usage per LLM turn, not per tool call. These are the file tools' real byte volumes (≈ bytes / 4); other tools' results are billed into the next LLM call's input.</div>
          </div>
        )
      })()}

      <div style="display:flex;gap:6px;align-items:center;margin-top:16px">
        <span style="font-size:10px;color:var(--muted)">Sort:</span>
        {(['calls', 'name'] as const).map(k => (
          <button
            key={k}
            onClick={() => setSortKey(k)}
            style={[
              'padding:2px 8px;font-size:10px;cursor:pointer;border-radius:3px;border:1px solid var(--border);',
              sortKey === k ? 'background:var(--accent);color:var(--vscode-button-foreground,#fff);font-weight:600' : 'background:transparent;color:var(--muted)',
            ].join('')}
          >{k === 'calls' ? 'Calls' : 'Name'}</button>
        ))}
      </div>
      <table class="tool-insights-table" style="margin-top:8px">
        <thead>
          <tr><th>Tool</th><th>Calls</th><th>%</th><th>Agents</th></tr>
        </thead>
        <tbody>
          {entries.map(([name, callCount]) => {
            const agents = toolAgents[name] ? Object.keys(toolAgents[name]) : []
            return (
              <tr key={name}>
                <td>{name}</td>
                <td class="right">{callCount}</td>
                <td class="right">{(callCount / total * 100).toFixed(1)}%</td>
                <td>
                  {agents.map(a => (
                    <span key={a} style={'display:inline-block;width:8px;height:8px;border-radius:50%;background:' + getAgentColor(a) + ';vertical-align:middle;margin-right:4px'} title={getAgentSourceLabel(a)} />
                  ))}
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr>
            <td><strong>Total</strong></td>
            <td class="right"><strong>{total}</strong></td>
            <td /><td />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── Full Tools tab (aggregates all ranged sessions) ───────────────────────────

export function Tools() {
  const sessions = rangedSessions.value

  if (sessions.length === 0) {
    return <div id="tools-content"><div class="empty-state">No agent sessions recorded — start a Copilot, Claude, or Codex session</div></div>
  }

  return (
    <div id="tools-content">
      <h3 style="margin:0 0 16px;font-size:13px;color:var(--muted)">TOOL CALL DISTRIBUTION</h3>
      <ToolsChart sessions={sessions} />
    </div>
  )
}
