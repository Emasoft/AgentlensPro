import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { GeneratedFileRef, SessionSummaryCard } from './shared/summarizerTypes'
import { estimateTokensFromBytes } from './tokenEstimator'

// ── Output-file / scratch-subfolder tracking (TRDD-ZS1GDXVY) ──────────────────
// Claude Code writes per-session artifacts under an OS-temp "claude-<uid>" tree:
//   {tmp}/claude-<uid>/<project-slug>/<sessionUuid>/{scratchpad,tasks,tool-results,…}
// These files are the real content of many tool results / background-task outputs but were never
// surfaced. This module is the pure, side-effect-light core: a path matcher, a bytes→tokens
// estimator, an fs.stat resolver, and a BOUNDED scratch-tree indexer. logReader harvests referenced
// paths + runs the indexer; the DB persists the result; the dashboard renders each as a leaf.

// Generated/scratch-file leaves are byte-only (we stat the file, never read+tokenize its content), so
// they use the coarse bytes/4 estimator from the shared tokenEstimator module (TRDD-IQENK7JM). Re-
// exported here so existing callers/tests that import it from this module keep working — the ONE
// definition now lives in ./tokenEstimator (single source of truth).
export { estimateTokensFromBytes }

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

// ── Directory-listing cache (TRDD-X2E6OSWK) ───────────────────────────────────
// attachGeneratedFiles() runs on EVERY incremental parse of EVERY Claude session — i.e. on every
// JSONL append, several times a second across a busy machine. It was re-reading the OS temp roots
// (/tmp, /private/tmp, /var/folders/…/T — big, shared directories) plus every `claude-*` tree under
// them, from scratch, every single time. A CPU profile of the FIXED server under a 4-writer load
// caught it red-handed: 14.2s of `readdir` across 948 parses (~15ms each) — 9.4% of wall-clock CPU
// and, once the two loops in TRDD-X2E6OSWK's brief were fixed, the single largest non-idle cost left.
//
// The gate is the directory's OWN mtime, which POSIX updates whenever an entry is created, removed,
// or renamed inside it. So: a new `claude-*` tree bumps the root's mtime; a new project slug bumps
// the uid dir's mtime; a new session dir bumps the slug's mtime. Every one of those is therefore
// still discovered on the very next call — this caches the LISTING, it does not cache the ANSWER.
// (Writes to a file's CONTENT do not bump the parent's mtime — which is exactly why this is safe:
// the listing cannot go stale for anything the listing is used to find, and file sizes/mtimes are
// still statted fresh below.)
const listingCache = new Map<string, { mtimeMs: number; names: string[] }>()
const LISTING_CACHE_MAX = 5000   // a scratch tree per session adds up over a long uptime

// The cost meter this fix is judged on: `readdirs` must stay ~flat while a session is being appended
// to, instead of climbing on every parse. Read by the tests and by /api/debug/log-scan-stats.
let listingReaddirs = 0
let listingHits = 0

function listDirCached(dir: string): string[] {
  let mtimeMs: number
  try { mtimeMs = fs.statSync(dir).mtimeMs } catch { listingCache.delete(dir); return [] }
  const hit = listingCache.get(dir)
  if (hit && hit.mtimeMs === mtimeMs) { listingHits++; return hit.names }
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { listingCache.delete(dir); return [] }
  listingReaddirs++
  // Pure cache, never state: dropping it costs one re-listing, so a hard clear on overflow is a
  // correct (and bounded) eviction policy.
  if (listingCache.size >= LISTING_CACHE_MAX) listingCache.clear()
  listingCache.set(dir, { mtimeMs, names })
  return names
}

/** Real readdir calls vs listing-cache hits inside the scratch indexer. */
export function scratchListingStats(): { readdirs: number; hits: number; cached: number } {
  return { readdirs: listingReaddirs, hits: listingHits, cached: listingCache.size }
}

/** Drop the cached directory listings. Exposed for tests; not needed in production (the mtime gate
 *  keeps entries honest on its own). */
export function clearScratchListingCache(): void {
  listingCache.clear()
}

// Locate the session's scratch directories: {root}/claude-*/<project-slug>/<sessionUuid>. Shallow,
// guarded listing at each level — a slug/uid we can't read is skipped, not fatal (fail-open on
// discovery, fail-fast on genuinely bad input is not applicable here — a missing tree is normal).
// The per-session existence check stays a REAL statSync every call: it is one syscall, and it is the
// one thing that must never be served from a cache.
function findSessionScratchDirs(sessionUuid: string, roots: string[]): string[] {
  const dirs: string[] = []
  for (const root of roots) {
    for (const uid of listDirCached(root)) {
      if (!uid.startsWith('claude-')) continue
      const uidPath = path.join(root, uid)
      for (const slug of listDirCached(uidPath)) {
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
    // Same mtime-gated listing (TRDD-X2E6OSWK): a file ADDED to this scratch dir bumps the dir's
    // mtime and is listed on the next call, while the per-file size/mtime below is always statted
    // fresh — so a file that merely GREW is still reported at its current size.
    for (const name of listDirCached(dir)) {
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
//
// SECURITY (path-traversal containment): isClaudeScratchPath is a REGEX over the raw string — it only
// asserts the path CONTAINS a `/tmp/claude-<x>/` segment, so `/tmp/claude-501/../../../etc/passwd`
// matches yet resolves outside the scratch tree. Because the standalone UI server sets
// `Access-Control-Allow-Origin: *`, a raw-string check would let ANY website the user is browsing read
// arbitrary local files (ssh keys, .env, settings.json with OAuth tokens) via /api/generated-file.
// The fix is realpath containment: resolve symlinks + `..` to the CANONICAL path and re-check the
// regex on THAT — a canonical path has no `..`, so a match now genuinely means "inside a scratch
// tree". All stat/read then use the canonical path, never the caller-supplied string.
export function readScratchFile(p: string, maxBytes = 200 * 1024): ScratchFileContent {
  if (!isClaudeScratchPath(p)) return { exists: false, error: 'path not under a Claude scratch tree' }
  let real: string
  try { real = fs.realpathSync(p) } catch { return { exists: false } }
  if (!isClaudeScratchPath(real)) return { exists: false, error: 'path not under a Claude scratch tree' }
  try {
    const st = fs.statSync(real)
    if (!st.isFile()) return { exists: false, error: 'not a file' }
    const buf = fs.readFileSync(real)
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
