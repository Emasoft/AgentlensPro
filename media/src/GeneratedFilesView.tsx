import { useState } from 'preact/hooks'
import { generatedFileCache, loadGeneratedFile } from './state'
import { formatBytes, formatCompact } from './utils'
import type { GeneratedFileRef } from './types'

// ── Output-file / subfolder tracking (TRDD-ZS1GDXVY) ──────────────────────────
// Renders a session's generated/output files as expandable leaves: filename + size + mtime + token
// estimate on the row; on expand, the real content is lazy-fetched (loadGeneratedFile → cached by
// path) and shown inline. Content is capped server-side (200KB) with an explicit truncation notice.
// overflow:visible everywhere — the page owns the only scrollbars (no-nested-scrollbars rule).

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

function GeneratedFileLeaf({ gf }: { gf: GeneratedFileRef }) {
  const [open, setOpen] = useState(false)
  const cached = generatedFileCache.value[gf.path]
  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) loadGeneratedFile(gf.path)
  }
  const meta = gf.missing
    ? 'file gone'
    : `${formatBytes(gf.sizeBytes)} · ~${formatCompact(gf.tokenEstimate)} tok`
  return (
    <div style="margin:2px 0">
      <button
        onClick={toggle}
        title={gf.path}
        style="display:flex;gap:8px;align-items:center;width:100%;text-align:left;background:none;border:none;cursor:pointer;padding:2px 0;color:var(--vscode-foreground,#ccc);font:inherit"
      >
        <span style="color:var(--muted);width:10px">{open ? '▾' : '▸'}</span>
        <code style="word-break:break-all">{baseName(gf.path)}</code>
        <span style="color:var(--muted);font-size:10px;white-space:nowrap">{meta}</span>
        {gf.origin === 'scratch' && <span style="color:var(--muted);font-size:9px;opacity:.7">scratch</span>}
      </button>
      {open && (
        <div style="margin:2px 0 6px 18px">
          <div style="color:var(--muted);font-size:10px;word-break:break-all;margin-bottom:2px">{gf.path}</div>
          {cached === undefined
            ? <div style="color:var(--muted);font-size:11px">Loading…</div>
            : !cached.exists
              ? <div style="color:var(--error,#f44747);font-size:11px">{cached.error ?? 'File is gone (deleted since it was indexed).'}</div>
              : (
                <>
                  {cached.truncated && (
                    <div style="color:var(--vscode-charts-orange,#e2a03f);font-size:10px;margin-bottom:2px">
                      Showing first 200 KB of {formatBytes(cached.sizeBytes ?? gf.sizeBytes)} — content truncated.
                    </div>
                  )}
                  <pre style="margin:0;white-space:pre-wrap;word-break:break-word;overflow:visible;font-size:11px;background:var(--vscode-textCodeBlock-background,rgba(127,127,127,.1));padding:6px;border-radius:3px">{cached.content ?? ''}</pre>
                </>
              )}
        </div>
      )}
    </div>
  )
}

// A list of generated-file leaves (used both on a tool step and as the session-level group).
export function GeneratedFilesList({ files, truncated, heading }: { files: GeneratedFileRef[]; truncated?: boolean; heading?: string }) {
  if (files.length === 0) return null
  return (
    <div class="sw-detail-section">
      {heading && (
        <div class="sw-detail-heading">
          {heading} <span style="color:var(--muted);font-weight:normal">({files.length})</span>
        </div>
      )}
      {files.map(gf => <GeneratedFileLeaf key={gf.path} gf={gf} />)}
      {truncated && (
        <div style="color:var(--vscode-charts-orange,#e2a03f);font-size:10px;margin-top:2px">
          File list capped at 500 — some scratch files are not shown.
        </div>
      )}
    </div>
  )
}
