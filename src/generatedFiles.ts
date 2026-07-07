import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { GeneratedFileRef, SessionSummaryCard } from './summarizers/summarizerTypes'

// ── Output-file / scratch-subfolder tracking (TRDD-ZS1GDXVY) ──────────────────
// Claude Code writes per-session artifacts under an OS-temp "claude-<uid>" tree:
//   {tmp}/claude-<uid>/<project-slug>/<sessionUuid>/{scratchpad,tasks,tool-results,…}
// These files are the real content of many tool results / background-task outputs but were never
// surfaced. This module is the pure, side-effect-light core: a path matcher, a bytes→tokens
// estimator, an fs.stat resolver, and a BOUNDED scratch-tree indexer. logReader harvests referenced
// paths + runs the indexer; the DB persists the result; the dashboard renders each as a leaf.

// bytes/4 token estimate. Single chokepoint so the real tokenizer (TRDD-IQENK7JM) can replace it in
// exactly one place instead of scattered `/ 4` arithmetic across the codebase.
export function estimateTokensFromBytes(bytes: number): number {
  return bytes > 0 ? Math.ceil(bytes / 4) : 0
}

// Matches a path that lives under a temp "claude-<uid>" session tree. Requires the `claude-` prefix
// to sit directly under a recognised temp root (/tmp, /private/tmp, or a macOS /var/folders/.../T),
// so an unrelated project directory literally named "claude-foo" is NOT mistaken for scratch.
const SCRATCH_RE = /(?:^|\/)(?:private\/tmp|tmp|var\/folders\/[^/]+\/[^/]+\/[A-Za-z])\/claude-[^/]+\//

export function isClaudeScratchPath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && SCRATCH_RE.test(p)
}

// A GeneratedFileRef for a path whose file is absent (referenced in the transcript but never written,
// or already deleted). Kept so the tool-call leaf still shows "this call named an output file", with
// the dashboard rendering a "file gone" state on expand.
function missingRef(p: string, origin: GeneratedFileRef['origin']): GeneratedFileRef {
  return { path: p, sizeBytes: 0, mtimeMs: 0, tokenEstimate: 0, origin, missing: true }
}

// stat one path into a GeneratedFileRef. Returns a `missing:true` ref (never null) for a
// referenced path so the leaf is preserved; returns null only for a non-file (dir/symlink target).
export function resolveGeneratedFile(p: string, origin: GeneratedFileRef['origin']): GeneratedFileRef | null {
  let st: fs.Stats
  try { st = fs.statSync(p) } catch { return origin === 'referenced' ? missingRef(p, origin) : null }
  if (!st.isFile()) return null
  return { path: p, sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs), tokenEstimate: estimateTokensFromBytes(st.size), origin }
}

// The temp roots a Claude scratch tree can live under on this machine. os.tmpdir() covers the
// /var/folders form on macOS; the two literals cover the /private/tmp + /tmp forms Claude Code uses.
function defaultTmpRoots(): string[] {
  // realpath-dedupe so macOS's /tmp → /private/tmp symlink isn't walked twice (which would
  // double-count every scratch file). A root we can't realpath (absent) is dropped.
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of [os.tmpdir(), '/tmp', '/private/tmp']) {
    if (typeof r !== 'string' || r.length === 0) continue
    let real: string
    try { real = fs.realpathSync(r) } catch { continue }
    if (!seen.has(real)) { seen.add(real); out.push(real) }
  }
  return out
}

const SCRATCH_INDEX_MAX_FILES = 500

export interface ScratchIndexResult {
  files: GeneratedFileRef[]
  truncated: boolean   // true if the tree held MORE than maxFiles — the cap was hit (never silent)
}

// Locate the session's scratch directories: {root}/claude-*/<project-slug>/<sessionUuid>. Shallow,
// guarded readdir at each level — a slug/uid we can't read is skipped, not fatal (fail-open on
// discovery, fail-fast on genuinely bad input is not applicable here — a missing tree is normal).
function findSessionScratchDirs(sessionUuid: string, roots: string[]): string[] {
  const dirs: string[] = []
  for (const root of roots) {
    let uidDirs: string[]
    try { uidDirs = fs.readdirSync(root) } catch { continue }
    for (const uid of uidDirs) {
      if (!uid.startsWith('claude-')) continue
      const uidPath = path.join(root, uid)
      let slugs: string[]
      try { slugs = fs.readdirSync(uidPath) } catch { continue }
      for (const slug of slugs) {
        const candidate = path.join(uidPath, slug, sessionUuid)
        try { if (fs.statSync(candidate).isDirectory()) dirs.push(candidate) } catch { /* not here */ }
      }
    }
  }
  return dirs
}

// BOUNDED breadth-first walk of the session's scratch tree(s), collecting up to maxFiles regular
// files as GeneratedFileRefs (path/size/mtime only — content is NEVER read here). truncated=true is
// returned the moment the cap is hit so the caller can surface it (no silent truncation).
export function indexScratchTree(
  sessionUuid: string,
  opts?: { tmpRoots?: string[]; maxFiles?: number },
): ScratchIndexResult {
  if (!sessionUuid) return { files: [], truncated: false }
  const maxFiles = opts?.maxFiles ?? SCRATCH_INDEX_MAX_FILES
  const roots = opts?.tmpRoots ?? defaultTmpRoots()
  const queue = findSessionScratchDirs(sessionUuid, roots)
  const files: GeneratedFileRef[] = []
  let truncated = false
  while (queue.length > 0) {
    const dir = queue.shift() as string
    let names: string[]
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      const full = path.join(dir, name)
      let st: fs.Stats
      try { st = fs.statSync(full) } catch { continue }
      if (st.isDirectory()) { queue.push(full); continue }
      if (!st.isFile()) continue
      if (files.length >= maxFiles) { truncated = true; break }
      files.push({ path: full, sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs), tokenEstimate: estimateTokensFromBytes(st.size), origin: 'scratch' })
    }
    if (truncated) break
  }
  return { files, truncated }
}

// Harvest record accumulated during transcript parsing: a scratch path referenced by a tool call,
// optionally correlated to the timeline entry (spanId) that produced/referenced it.
export interface HarvestedGeneratedFile {
  spanId?: string
}

// Resolve harvested (Phase A) referenced paths + the bounded scratch-tree index (Phase B) onto a
// card: correlated leaves attach to their tool-call timeline entry; uncorrelated leaves + scratch
// discoveries land in card.generatedFiles (the session-level "generated files" group). Referenced
// entries win over scratch on path collision (they carry the producing spanId). Idempotent — safe
// to re-run on every incremental scan.
export function attachGeneratedFiles(
  card: SessionSummaryCard,
  harvested: Map<string, HarvestedGeneratedFile>,
  opts?: { tmpRoots?: string[]; maxFiles?: number },
): void {
  const bySpan = new Map<string, GeneratedFileRef[]>()
  const cardLevel: GeneratedFileRef[] = []
  const seen = new Set<string>()
  for (const [p, h] of harvested) {
    const ref = resolveGeneratedFile(p, 'referenced') ?? missingRef(p, 'referenced')
    seen.add(p)
    if (h.spanId) {
      const arr = bySpan.get(h.spanId) ?? []
      arr.push(ref)
      bySpan.set(h.spanId, arr)
    } else {
      cardLevel.push(ref)
    }
  }
  for (const entry of card.timeline) {
    const refs = bySpan.get(entry.spanId)
    if (refs && refs.length > 0) entry.generatedFiles = refs
  }
  const { files, truncated } = indexScratchTree(card.sessionId, opts)
  for (const f of files) {
    if (seen.has(f.path)) continue
    seen.add(f.path)
    cardLevel.push(f)
  }
  card.generatedFiles = cardLevel.length > 0 ? cardLevel : undefined
  card.generatedFilesTruncated = truncated || undefined
}

export interface ScratchFileContent {
  exists: boolean
  sizeBytes?: number
  mtimeMs?: number
  truncated?: boolean
  content?: string
  error?: string
}

// Read one generated/output file's content for the on-demand "expand" leaf (TRDD-ZS1GDXVY). Refuses
// any path NOT under a Claude scratch tree so it can never become an arbitrary-file reader. Caps the
// returned content at maxBytes (default 200KB) with an explicit `truncated` flag; a deleted/absent
// file returns { exists:false } (never a silent null). Shared by the standalone /api/generated-file
// route and the VS Code dashboardPanel postMessage bridge so both enforce the same guard + cap.
export function readScratchFile(p: string, maxBytes = 200 * 1024): ScratchFileContent {
  if (!isClaudeScratchPath(p)) return { exists: false, error: 'path not under a Claude scratch tree' }
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return { exists: false, error: 'not a file' }
    const buf = fs.readFileSync(p)
    return {
      exists: true,
      sizeBytes: st.size,
      mtimeMs: Math.round(st.mtimeMs),
      truncated: buf.length > maxBytes,
      content: buf.subarray(0, maxBytes).toString('utf8'),
    }
  } catch {
    return { exists: false }
  }
}

// Extract scratch output-file paths referenced by a tool_use INPUT: known path-bearing keys plus any
// top-level string value that resolves to a scratch path (covers a Bash command's `> file`, a
// Workflow's output path, etc.). Bounded to top-level string values so a huge nested input can't
// explode the scan.
export function scratchPathsInToolInput(inp: Record<string, unknown> | undefined): string[] {
  if (!inp || typeof inp !== 'object') return []
  const out = new Set<string>()
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path', 'output_file', 'output-file', 'outputFile']) {
    const v = inp[key]
    if (isClaudeScratchPath(v)) out.add(v)
  }
  // Also accept a bare string VALUE that IS a scratch path — but only a whitespace-free one, so a
  // Bash command like `echo hi > /tmp/claude-…/x` (which merely mentions a path) is NOT harvested as
  // if the whole command were a filename.
  for (const v of Object.values(inp)) {
    if (typeof v === 'string' && !/\s/.test(v) && isClaudeScratchPath(v)) out.add(v)
  }
  return Array.from(out)
}

// Extract scratch output-file paths from a tool_result's sibling `toolUseResult` object (Task/Agent
// completions, background-task notifications). Checks the documented output-file keys only — the
// result body itself is not scanned (too broad / would false-positive on quoted paths in output).
export function scratchPathsInToolUseResult(tur: Record<string, unknown> | undefined): string[] {
  if (!tur || typeof tur !== 'object') return []
  const out = new Set<string>()
  for (const key of ['output-file', 'output_file', 'outputFile', 'filePath', 'file_path', 'path']) {
    const v = tur[key]
    if (isClaudeScratchPath(v)) out.add(v)
  }
  return Array.from(out)
}
