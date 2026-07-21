import * as fs from 'fs'
import * as path from 'path'
import { claudeProjectsDirs } from './logReader'
import { classifySlashCommand, type CacheRiskKind, type MutationCertainty } from './shared/cacheRiskKinds'

// Re-exported (never re-declared) so host callers have one import site and check-mirrors keeps the
// dashboard honest — the vocabulary itself lives in src/shared/cacheRiskKinds.ts.
export { classifySlashCommand, CACHE_RISK_STYLE } from './shared/cacheRiskKinds'
export type { CacheRiskKind, MutationCertainty } from './shared/cacheRiskKinds'

// Cache-risk slash commands, read straight out of the Claude Code transcript (TRDD-EYA3X5MQ).
//
// WHY a transcript scan and not a hook: there is no plugin-reload hook event, built-in slash
// commands do not fire UserPromptSubmit, and `ConfigChange` was measured and REFUTED as a reload
// signal (an explicit /reload-plugins emitted ZERO hook events; 40,858 stored records hold
// ConfigChange 0 times). But Claude Code DOES persist every built-in command it runs as a normal
// `type: "user"` transcript entry whose content is a `<command-name>…</command-name>` block — so
// the exact command, its args, its timestamp and its session are already on disk, retroactively,
// for the whole history. That is ground truth; the catalog co-churn heuristic is a fallback for
// turns with no transcript (it over-counted this project 102 vs 69 actual).
//
// WHY `mutation` exists: invoking a command is not the same as changing anything. `/reload-plugins`
// and `/reload-skills` are actions — they always re-register catalogs. Bare `/plugin` and `/mcp`
// open an interactive menu the user may simply close, and `/model` may be re-selected to the same
// model. Those are 'ambiguous': the caller must corroborate them against real cost/catalog churn
// before charging a cache break to them, or it repeats the over-count the inference already made.

// NO catalog sizes here, deliberately. `/reload-plugins` prints
// `Reloaded: 34 plugins · 117 skills · 75 agents · 27 hooks · …` into the live conversation, which
// makes it tempting to parse for "how big was this reload". It is NOT on disk: a machine-wide scan
// found only 14 records containing that line inside a `<local-command-stdout>` tag, and ZERO of
// them are command entries — every one is a QUOTE (an assistant message, a tool_result, a
// compaction summary). Claude Code persists the command block and drops the stdout. Do not add a
// catalogs field back without first proving a real command entry carries one.
export interface CacheRiskCommand {
  /** Epoch ms of the command entry. */
  ts: number
  /** Session id the command was typed in (transcript `sessionId`). */
  session?: string
  /** The literal command, e.g. `/reload-plugins`. */
  command: string
  /** Raw `<command-args>` text, when non-empty. */
  args?: string
  kind: CacheRiskKind
  mutation: MutationCertainty
}

const RE_NAME = /^(?:\s*<local-command-caveat>[\s\S]*?<\/local-command-caveat>)?\s*<command-name>([^<]*)<\/command-name>/
const RE_ARGS = /<command-args>([^<]*)<\/command-args>/

/** Split a transcript entry's text into its command parts. Undefined when it is not a command. */
export function parseCommandBlock(text: string): { name: string; args?: string } | undefined {
  const name = RE_NAME.exec(text)?.[1]?.trim()
  if (!name) return undefined
  const args = RE_ARGS.exec(text)?.[1]?.trim()
  return { name, args: args || undefined }
}

/** A parsed transcript line, narrowed to the fields this module needs. */
interface TranscriptEntry {
  type?: unknown
  timestamp?: unknown
  sessionId?: unknown
  message?: { content?: unknown }
}

/**
 * Turn one transcript entry into a cache-risk command, or undefined. Only `type: "user"` entries
 * whose content is a STRING carry a command block — a tool_result is an array, and treating one as
 * a command would let any transcript that merely QUOTES `<command-name>` (an assistant explaining
 * this very feature, for instance) inflate the count.
 */
export function extractCacheRiskCommand(entry: TranscriptEntry): CacheRiskCommand | undefined {
  if (entry.type !== 'user') return undefined
  const content = entry.message?.content
  if (typeof content !== 'string') return undefined
  const block = parseCommandBlock(content)
  if (!block) return undefined
  const cls = classifySlashCommand(block.name, block.args)
  if (!cls) return undefined
  const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  if (!Number.isFinite(ts)) return undefined
  const cmd: CacheRiskCommand = {
    ts,
    session: typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
    command: block.name.trim(),
    kind: cls.kind,
    mutation: cls.mutation,
  }
  if (block.args) cmd.args = block.args
  return cmd
}

export interface ScanOptions {
  /** Only consider commands at or after this epoch ms (also skips whole files by mtime). */
  sinceMs?: number
  /** Restrict to these kinds. */
  kinds?: ReadonlyArray<CacheRiskKind>
  /** Newest-first cap on the returned list. */
  limit?: number
  /** Transcript roots; defaults to Claude Code's own project dirs. */
  dirs?: ReadonlyArray<string>
}

/** Every `*.jsonl` under the given roots, one level deep (Claude Code's layout: <root>/<slug>/*.jsonl). */
function transcriptFiles(dirs: ReadonlyArray<string>): string[] {
  const out: string[] = []
  for (const root of dirs) {
    let slugs: string[]
    try { slugs = fs.readdirSync(root) } catch { continue }
    for (const slug of slugs) {
      const dir = path.join(root, slug)
      let names: string[]
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const n of names) if (n.endsWith('.jsonl')) out.push(path.join(dir, n))
    }
  }
  return out
}

/**
 * Scan transcripts for cache-risk commands, newest first.
 *
 * Two cheap filters keep a full-history scan (12k+ files) affordable: skip a file whose mtime
 * predates `sinceMs`, and skip a file whose text has no `<command-name>` at all — only then parse,
 * and only the lines that contain the marker.
 */
export function scanCacheRiskCommands(opts: ScanOptions = {}): CacheRiskCommand[] {
  const dirs = opts.dirs ?? claudeProjectsDirs()
  const kinds = opts.kinds ? new Set(opts.kinds) : undefined
  const found: CacheRiskCommand[] = []
  for (const file of transcriptFiles(dirs)) {
    if (opts.sinceMs !== undefined) {
      try { if (fs.statSync(file).mtimeMs < opts.sinceMs) continue } catch { continue }
    }
    let text: string
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    if (!text.includes('<command-name>')) continue
    for (const line of text.split('\n')) {
      if (!line.includes('<command-name>')) continue
      let entry: TranscriptEntry
      try { entry = JSON.parse(line) as TranscriptEntry } catch { continue }
      const cmd = extractCacheRiskCommand(entry)
      if (!cmd) continue
      if (opts.sinceMs !== undefined && cmd.ts < opts.sinceMs) continue
      if (kinds && !kinds.has(cmd.kind)) continue
      found.push(cmd)
    }
  }
  found.sort((a, b) => b.ts - a.ts)
  return opts.limit !== undefined ? found.slice(0, opts.limit) : found
}
