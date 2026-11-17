// src/cli/searchCli.ts — `agentlenspro search`: grep a project's transcript .jsonl files with DuckDB
// (TRDD-P31SWA8I; project-wide scope, filters and output: TRDD-UIQS9RXZ).
//
// WHY DUCKDB AND NOT A JS LINE LOOP: a main transcript here is routinely 60MB+ with MB-sized
// tool_result lines; read_ndjson_objects streams it off disk (several threads for small files, one thread
// for big ones — see the stage-1 scan split) and never materializes the file in V8 — the exact
// single-core JS hot-loop shape the 2026-08-18 CPU incidents traced to (TRDD-7I5805QM/DMWOBWFH) must
// not be reintroduced here.
//
// TWO STAGES (project-wide scan), and why: a line number needs a window function over the scan, and
// a window is a BLOCKING operator — `row_number() OVER (PARTITION BY filename)` over this project's
// 3 GB of transcripts holds every row before the WHERE runs and dies with "Out of Memory Error
// (1.8 GiB/1.8 GiB used)" at the 2GB no-spill limit (measured 2026-11-17, reports_dev/UIQS9RXZ).
// So stage 1 scans the whole file list with NO window and keeps only small columns per match
// (excerpt + md5 of the line, never the json); stage 2 numbers lines for the SHOWN hits only, one
// single-file pass per distinct file, matching rows back by md5. A hit whose md5 is gone (the
// transcript grew or was rewritten between the stages) gets line null — never a wrong number.
// One transcript (the old single-file scope) keeps the one-statement window: one file always fits.
//
// stdout is the matches alone (one line each, or --json); everything describing WHAT was searched
// goes to stderr — the same pipe-safe split as cache-expired/last-compact.

import * as fs from 'fs'
import * as path from 'path'
import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'
import { claudeProjectsDirs } from '../logReader'
import { MAX_OBJECT_SIZE } from '../ndjsonDuck'
import { resolveProjectSlugs } from '../projectSlug'
import { EXIT, UsageError } from './cliErrors'
import { assertKnownFlags, flagValue } from './argHelpers'

export const SEARCH_USAGE = `agentlenspro search <pattern> [flags]

Search the Claude transcripts (.jsonl) of the current project — tool outputs, agent responses,
thinking, user prompts, hook injections, sub-agent transcripts — with DuckDB's streaming NDJSON
reader. Without --session it covers EVERY session of the project, main and sub-agent.

scope:
  --project DIR        the project (default: the current directory); a path or a Claude project slug
  --session ID[,ID]    only these sessions (exact id or a unique prefix >= 6 chars); their sub-agent
                       transcripts are included
  --agent ID[,ID]      only sub-agent transcripts whose agent id starts with ID
  --main-only          main transcripts only (not with --subagents-only)
  --subagents-only     sub-agent transcripts only
  --worktrees          also search the project's sibling worktree folders (<slug>--claude-worktrees-*)
filters:
  --since T / --until T  ISO date or datetime (no zone = local time) or a span: 30m 2h 3d 1w;
                       an entry with no timestamp is excluded when either is given
  --branch B           entries whose gitBranch is B
  --cwd TEXT           entries whose cwd contains TEXT
  --worktree NAME      entries whose cwd contains /worktrees/NAME
  --model M            entries whose message.model contains M
  --role R             only entries whose message.role is R (user|assistant|...)
  --type T             only entries whose type is T (e.g. user, assistant, attachment, summary)
  --include-requests   also search api-request, api-request-blob, api-request-shape entries
                       (excluded by default: they repeat the conversation)
  --include-attachments  also search every attachment type (by default only hook output, queued
                       commands, edited files, file, diagnostics and task_status attachments)
match:
  --regex              <pattern> is a regular expression matched against the RAW JSON line (a quote
                       is \\" and a newline is \\n there). Default: literal, case-insensitive
elements (any of --kind, --tool, --file or --commit searches ELEMENTS instead of raw JSON lines):
  --kind K[,K]         prompt response thinking tool-call tool-output diff subagent hook command compact error cron system
                       attachment model-change. A diff, subagent or error element is ALSO a tool-call / tool-output element;
                       it is counted once and printed under its most specific kind. Without --kind: every kind except
                       attachment (opt-in) and model-change
  --tool NAME[,NAME]   tool calls of that tool and the outputs that answer them (exact name, or a mask: mcp__*)
  --file TEXT          tool calls whose input holds TEXT, the outputs that answer them, and outputs naming a file that
                       holds TEXT (not --files, which lists transcripts)
  --commit SHA         tool calls and outputs that hold SHA (7 to 40 hex characters) and outputs whose git operation holds it
  --kind model-change  needs no pattern: one row per place where the model of an assistant entry differs from the previous
                       one of the same transcript, printed as: from -> to
  Element mode matches the UNESCAPED text of an element (a quote is a quote, a newline a newline), line mode the RAW JSON
  line (a quote is \\" there): the same pattern, and above all the same --regex, can give different hits with and without
  --kind. In element mode total, --count and --files count ELEMENTS, not lines (one line can hold several). The excerpt
  is readable text, not JSON. It is slower than line mode: every kept line is parsed into its blocks.
output:
  --limit N            max matches to print (default 20, max 500)
  --width N            excerpt length in characters (default 300, max 2000)
  --order new|old      newest first / oldest first; without it: file order when exactly one transcript is in scope, otherwise newest first
  --count              per transcript: <count> <session8>[:<agent8>], largest first
  --files              only the paths of the transcripts that match (not with --count)
  --json               machine output: {line, ts, type, role, excerpt, session, agent, file} per
                       match + total; element mode adds kind and tool to every match

text line: <session8>[:<agent8>] <TAB> #<line> <TAB> <ts> <TAB> [role|type] <TAB> <excerpt>
       in element mode the bracket is [<kind>] or [<kind> <tool>], e.g. [tool-output Bash]
stderr: transcripts and MB searched, matches, shown, total ms (scan = all-file scan, lines = line numbers of
       the shown hits). A line that is not valid JSON (e.g. the half-written last line of a live transcript) is not searched;
       the count of such lines is printed on stderr and is "skipped" in --json. A blank line is not counted by the reader,
       so each blank line lowers every later line number by one. A line larger than about 512 MiB makes the whole search fail
       with a maximum_object_size error; it is not skipped.

exit:
  0 = searched (even with 0 matches) · 2 = no transcript found / unreadable · 64 = bad usage

  agentlenspro search "ENOENT" --since 2d --type user
  agentlenspro search "hook" --subagents-only --count --worktrees`

const VALUED = new Set([
  '--project', '--session', '--agent', '--since', '--until', '--branch', '--cwd', '--worktree', '--model',
  '--role', '--type', '--limit', '--width', '--order', '--kind', '--tool', '--file', '--commit',
])
const KNOWN = new Set([
  ...VALUED, '--regex', '--json', '--count', '--files', '--main-only', '--subagents-only', '--worktrees',
  '--include-requests', '--include-attachments', '--help', '-h',
])

// Entries that repeat the conversation (a copy of it plus request metadata): a hit there duplicates
// a hit in the conversation, and they are 0.5 GB of this project's transcripts.
const REQUEST_TYPES = ['api-request-blob', 'api-request', 'api-request-shape']
// Attachments are 1.33 GB of 3.15 GB, mostly repeated reminders and prompt snapshots; these are the
// kinds that carry text a human or agent would look for.
const ATTACHMENT_TYPES = [
  'hook_success', 'hook_additional_context', 'hook_system_message', 'hook_blocking_error', 'hook_cancelled',
  'hook_non_blocking_error', 'async_hook_response', 'queued_command', 'edited_text_file', 'file', 'diagnostics',
  'task_status',
]

// Stage-1 scan split: a file under SMALL_FILE_BYTES cannot hold a line over SMALL_OBJECT_SIZE, so those files
// are scanned with a smaller per-thread JSON buffer and several threads; the rest keep the full
// MAX_OBJECT_SIZE buffer on ONE thread (the reader holds ~2 x maximum_object_size per thread).
const SMALL_FILE_BYTES = 32 * 1048576
const SMALL_OBJECT_SIZE = 64 * 1048576
const SMALL_SCAN_THREADS = 4
// Element mode copies the blocks of every kept line several times, so its scan groups run on one thread. Measured 2026-11-17 on this project
// (frozen set of 3,246 files, 2,972 MB, whole command, AGENTLENS_DUCKDB_MEMORY_LIMIT=1.5GB, 10 runs per case, 6 cases, reports_dev/OIMXULDJ/measure-B*.txt):
// with 2 threads --tool Bash "git" and --commit failed 10 of 10 runs with out-of-memory (peak RSS 1.43 and 1.52 GB) while the other four cases
// passed 10 of 10 (peaks 1.11 to 1.36 GB); with 1 thread all six passed 60 of 60 (peaks 0.89 to 1.22 GB). The root cause of the memory growth
// was not found (see TRDD-OIMXULDJ); the limit and the thread count are measured values, not derived ones.
const ELEMENT_SCAN_THREADS = 1

/** SQL single-quoted literal — the codebase queries by interpolation, so quoting is load-bearing. */
function sq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

// ── time arguments ───────────────────────────────────────────────────────────────────────────────

const RELATIVE_SPAN = /^(\d+)([mhdw])$/
const SPAN_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** `--since`/`--until` value to an ISO UTC string (the transcripts' own `timestamp` format, so SQL
 *  compares it as text). A span is relative to `nowMs`; anything unparseable is a UsageError. */
export function parseTimeArg(value: string, flag: string, nowMs: number = Date.now()): string {
  const span = RELATIVE_SPAN.exec(value)
  if (span) return new Date(nowMs - Number(span[1]) * SPAN_MS[span[2]]).toISOString()
  const ms = ISO_SHAPE.test(value) ? Date.parse(value) : NaN
  if (Number.isNaN(ms)) throw new UsageError(`${flag} expects an ISO date/datetime or a span like 30m, 2h, 3d, 1w — got "${value}"`)
  return new Date(ms).toISOString()
}

// ── file discovery (JS, fs) ──────────────────────────────────────────────────────────────────────

export interface TranscriptFile {
  path: string
  /** Session id: the file stem of a main transcript, the parent folder of a sub-agent transcript. */
  session: string
  /** Sub-agent id (file stem without `agent-`), null for a main transcript. */
  agent: string | null
  size: number
  mtimeMs: number
}

export interface ScopeOptions {
  sessions?: string[]
  agents?: string[]
  mainOnly?: boolean
  subagentsOnly?: boolean
  worktrees?: boolean
  /** A file last modified before this cannot hold an entry at or after it, so it is not opened. */
  sinceMs?: number
  /** Test override; defaults to claudeProjectsDirs() (which honours CLAUDE_CONFIG_DIR). */
  projectsDirs?: string[]
}

/** The scope names something that does not exist or is ambiguous — exit 2, not a usage error. */
export class SearchScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchScopeError'
  }
}

function readDirents(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }) } catch (e) {
    // A project with no folder yet is an empty scope, not a failure; anything else (EACCES, …) is.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

function resolveSessions(tokens: string[], known: Set<string>): Set<string> {
  const out = new Set<string>()
  for (const t of tokens) {
    if (known.has(t)) { out.add(t); continue }
    const candidates = t.length >= 6 ? [...known].filter(s => s.startsWith(t)).sort() : []
    if (candidates.length === 1) { out.add(candidates[0]); continue }
    if (candidates.length > 1) {
      throw new SearchScopeError(`session prefix "${t}" is ambiguous: ${candidates.slice(0, 5).join(', ')}${candidates.length > 5 ? ', …' : ''}`)
    }
    throw new SearchScopeError(`no transcript found for session "${t}" in this project (exact id or a unique >=6-char prefix; --project / --worktrees change the scope)`)
  }
  return out
}

/** Every transcript of the project (`<projects dir>/<slug>/*.jsonl` and `<slug>/<sid>/subagents/agent-*.jsonl`),
 *  narrowed by the scope flags. Sorted by path so the engine's file list is deterministic. */
export function discoverTranscripts(project: string, scope: ScopeOptions = {}): TranscriptFile[] {
  const roots = scope.projectsDirs ?? claudeProjectsDirs()
  const slugs = resolveProjectSlugs(project, roots)
  const folders = new Set<string>()
  for (const root of roots) {
    for (const slug of slugs) folders.add(path.join(root, slug))
    if (scope.worktrees) {
      for (const e of readDirents(root)) {
        if (e.isDirectory() && slugs.some(s => e.name.startsWith(`${s}--claude-worktrees-`))) folders.add(path.join(root, e.name))
      }
    }
  }

  const found: Array<{ path: string; session: string; agent: string | null }> = []
  for (const folder of folders) {
    for (const e of readDirents(folder)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        found.push({ path: path.join(folder, e.name), session: e.name.slice(0, -'.jsonl'.length), agent: null })
      } else if (e.isDirectory()) {
        const subDir = path.join(folder, e.name, 'subagents')
        for (const s of readDirents(subDir)) {
          if (s.isFile() && s.name.startsWith('agent-') && s.name.endsWith('.jsonl')) {
            found.push({ path: path.join(subDir, s.name), session: e.name, agent: s.name.slice('agent-'.length, -'.jsonl'.length) })
          }
        }
      }
    }
  }

  const wanted = scope.sessions ? resolveSessions(scope.sessions, new Set(found.map(f => f.session))) : null
  const out: TranscriptFile[] = []
  for (const f of found.sort((a, b) => a.path.localeCompare(b.path))) {
    if (wanted && !wanted.has(f.session)) continue
    if (scope.mainOnly && f.agent !== null) continue
    if (scope.subagentsOnly && f.agent === null) continue
    if (scope.agents && !(f.agent !== null && scope.agents.some(a => f.agent!.startsWith(a)))) continue
    let st: fs.Stats
    try { st = fs.statSync(f.path) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue // raced a deletion
      throw e
    }
    if (scope.sinceMs !== undefined && st.mtimeMs < scope.sinceMs) continue
    out.push({ ...f, size: st.size, mtimeMs: st.mtimeMs })
  }
  return out
}

// ── the engine ───────────────────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  regex?: boolean
  role?: string
  type?: string
  limit?: number
  width?: number
  /** ISO UTC strings (see parseTimeArg). */
  since?: string
  until?: string
  branch?: string
  cwd?: string
  worktree?: string
  model?: string
  includeRequests?: boolean
  includeAttachments?: boolean
  /** Default: file order for ONE transcript, newest first otherwise. */
  order?: 'new' | 'old'
  /** 'count' fills `counts` (per transcript) and no hits; it needs no line numbers. */
  mode?: 'hits' | 'count'
  /** Element mode (TRDD-OIMXULDJ): any of kinds, tools, file or commit switches the engine from raw lines to elements. */
  kinds?: string[]
  /** Tool names, exact or with a * mask. */
  tools?: string[]
  /** Keep tool calls whose input holds this text and the outputs that answer them or name a file holding it. */
  file?: string
  /** A commit SHA (7 to 40 hex characters). */
  commit?: string
}

export interface SearchHit {
  /** 1-based physical line; null when the transcript changed between the two stages. */
  line: number | null
  ts: string | null
  type: string | null
  role: string | null
  excerpt: string
  file: string
  session: string
  agent: string | null
  /** Element mode only: the element kind (a tool output is "tool-output", a model switch "model-change") and, for a tool call or its output, the tool name. */
  kind?: string
  tool?: string | null
}

export interface FileCount {
  file: string
  session: string
  agent: string | null
  count: number
}

export interface SearchResult {
  hits: SearchHit[]
  total: number
  counts: FileCount[]
  /** Wall time of stage 1 (the scan) and stage 2 (line numbers for the shown hits), in ms. */
  timing: { scanMs: number; linesMs: number }
  /** Lines that are not valid JSON (e.g. the half-written last line of a live transcript): not searched, counted here. */
  skipped: { lines: number; files: number }
}

/** Stage 2: line numbers and excerpts for the SHOWN hits only — one single-file pass per distinct file.
 *  The excerpt is computed here, not in stage 1: stage 1 with filters AND an excerpt expression
 *  exhausted the 2GB limit in 5 of 6 runs on this project, while either one alone never did.
 *  Only lines that satisfy the same match expression as stage 1 are hashed and excerpted: row_number()
 *  still numbers every physical line (line numbers stay true), but md5 and the excerpt of the other
 *  lines are never computed. */
async function assignLines(con: DuckDBConnection, shown: Array<{ hit: SearchHit; h: string }>, excerptExpr: string, matchExpr: string): Promise<void> {
  const byFile = new Map<string, Array<{ hit: SearchHit; h: string }>>()
  for (const s of shown) {
    const list = byFile.get(s.hit.file) ?? []
    list.push(s)
    byFile.set(s.hit.file, list)
  }
  for (const [file, items] of byFile) {
    const wanted = [...new Set(items.map(i => i.h))]
    const rows = (await con.runAndReadAll(
      `SELECT rn, h, excerpt FROM (
         SELECT rn, md5(raw) AS h, ${excerptExpr} AS excerpt FROM (
           SELECT row_number() OVER () AS rn, CAST(json AS VARCHAR) AS raw
           FROM read_ndjson_objects(${sq(file)}, maximum_object_size=${MAX_OBJECT_SIZE}, ignore_errors=true))
         WHERE ${matchExpr})
       WHERE h IN (${wanted.map(sq).join(",")}) ORDER BY rn`,
    )).getRowObjects()
    const lines = new Map<string, number[]>()
    const excerpts = new Map<string, string>()
    for (const r of rows) {
      const h = String(r.h)
      lines.set(h, [...(lines.get(h) ?? []), Number(r.rn)])
      excerpts.set(h, String(r.excerpt ?? "").replace(/\s+/g, " ").trim())
    }
    // Identical lines share an md5: hand their line numbers out ascending, one per shown hit.
    for (const { hit, h } of items) {
      hit.line = lines.get(h)?.shift() ?? null
      hit.excerpt = excerpts.get(h) ?? ""
    }
  }
}

/** One DuckDB instance for a search. Imported lazily, same reason as store/db.ts: --version/hook/gate must not pay for the binding. */
async function openDuck(): Promise<{ inst: DuckDBInstance; con: DuckDBConnection }> {
  const { DuckDBInstance } = await import("@duckdb/node-api")
  const inst = await DuckDBInstance.create(":memory:", {
    memory_limit: process.env["AGENTLENS_DUCKDB_MEMORY_LIMIT"]?.trim() || "2GB",
    // Starts at ONE thread; each stage-1 scan group sets its own count (SET threads). The JSON reader holds
    // ~2 x maximum_object_size of buffer per thread: on this project (3 GB), scanning ALL files at once with
    // the 256 MB cap hit the 2GB no-spill limit in 4 of 10 runs with 2 threads and in 0 of 10 with 1 (whole
    // command, measured 2026-11-17). Hence the split in scanGroups: files under 32 MB (cap 64 MB) on 4 threads,
    // the rest (cap 256 MB) on 1. Measured on the same project, 3,027 MB, literal pattern, limit 20: scan only
    // 6.0-7.3 s / whole command 6.4-7.8 s with 1 thread everywhere (3 runs); scan only 2.0-2.2 s / whole command
    // 2.4-2.5 s with the split, 0 of 10 runs failed, peak RSS ~0.9 GB. A smaller cap for the big files would
    // make a huge line fail the scan.
    threads: "1",
  })
  try {
    const con = await inst.connect()
    // No spill: an over-limit query must FAIL with a clear error, never write gigabytes to the SSD
    // or to a .tmp folder in the cwd (src/store/db.ts:3-21).
    await con.run(`SET temp_directory = ${sq("")}`)
    return { inst, con }
  } catch (e) {
    inst.closeSync()
    throw e
  }
}

/** The stage-1 scan groups: small files on several threads with a small JSON buffer, the rest on one thread with the full one. */
function scanGroups(files: TranscriptFile[]): Array<{ group: TranscriptFile[]; maxObjectSize: number; threads: number }> {
  const bySize = [...files].sort((a, b) => a.size - b.size)
  return [
    { group: bySize.filter(f => f.size < SMALL_FILE_BYTES), maxObjectSize: SMALL_OBJECT_SIZE, threads: SMALL_SCAN_THREADS },
    { group: bySize.filter(f => f.size >= SMALL_FILE_BYTES), maxObjectSize: MAX_OBJECT_SIZE, threads: 1 },
  ].filter(g => g.group.length > 0)
}

// ── element mode (TRDD-OIMXULDJ) ─────────────────────────────────────────────────────────────────
//
// Line mode matches the raw JSON line, so it cannot tell a thinking block from a tool call or a prompt from a
// tool output. With --kind, --tool, --file or --commit the engine runs in ELEMENT mode: every kept line is split
// into elements (one per content block, or one per system / attachment / queue entry) and the pattern is matched
// against the element own UNESCAPED text, so an excerpt is readable text, not JSON. Two stages again: stage 1
// inserts one small row per matching element (never its text), stage 2 re-derives line number, excerpt and tool
// name for the SHOWN hits only. The top-level toolUseResult of an entry is NOT an element: it repeats the output
// that the tool_result block carries, so it only supplies fields (patch, file path, git operation). It occurs only
// in entries with exactly ONE tool_result block (measured, reports_dev/OIMXULDJ/probe-tur.txt: every entry with
// 2 or more tool_result blocks has none), so a field never belongs to the wrong block.

/** The element kinds, as printed and as accepted by --kind. */
export const ELEMENT_KINDS = [
  "prompt", "response", "thinking", "tool-call", "tool-output", "diff", "subagent", "hook", "command",
  "compact", "error", "cron", "system", "attachment", "model-change",
]
// Without --kind: everything a conversation holds. attachment is opt-in (most attachments are repeated reminders);
// model-change is a different statement and is always asked for by name.
const DEFAULT_KINDS = ELEMENT_KINDS.filter(k => k !== "attachment" && k !== "model-change")
const SUBAGENT_TOOLS = ["Agent", "SendMessage", "SubagentHandback"]
const DIFF_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"]
const HOOK_ATTACHMENT_TYPES = [
  "hook_success", "hook_additional_context", "hook_system_message", "hook_blocking_error", "hook_cancelled",
  "hook_non_blocking_error", "async_hook_response",
]
const CALL_BLOCKS = ["tool_use", "server_tool_use"]
const OUTPUT_BLOCKS = ["tool_result", "advisor_tool_result"]
const JSON_LIST = `["JSON"]`
const SUBAGENT_FILE = "/subagents/agent-"
/** Marks the one pseudo element that a line which is not valid JSON becomes, so that stage 1 can count it. */
const BAD_KIND = "(bad)"

const inList = (xs: string[]): string => xs.map(sq).join(",")
const jstr = (e: string, p: string): string => `json_extract_string(${e}, ${sq(p)})`
const jraw = (e: string, p: string): string => `json_extract(${e}, ${sq(p)})`
const kindList = (...ks: string[]): string => `[${inList(ks)}]::VARCHAR[]`
const NO_KINDS = "[]::VARCHAR[]"

/** The unescaped text of the JSON value `e`: a string as itself, an array of strings or text blocks joined by newlines, anything else as its JSON text. */
function textOf(e: string): string {
  // Arrays are read with the wildcard path, never with a lambda over from_json: a lambda evaluates all the elements of a chunk at once,
  // and with MB-sized tool results that exhausted the 2GB limit (measured 2026-11-17, reports_dev/OIMXULDJ). A wildcard skips elements
  // without the key, so an image block adds nothing.
  return `(CASE json_type(${e}) WHEN ${sq("VARCHAR")} THEN ${jstr(e, "$")} ` +
    `WHEN ${sq("ARRAY")} THEN (CASE json_type(${e}, ${sq("$[0]")}) WHEN ${sq("VARCHAR")} THEN array_to_string(${jstr(e, "$[*]")}, chr(10)) ` +
    `ELSE array_to_string(${jstr(e, "$[*].text")}, chr(10)) END) ` +
    `WHEN ${sq("NULL")} THEN NULL ELSE CAST(${e} AS VARCHAR) END)`
}

/** The columns every element query derives from a line (`obj` is the parsed line, `raw` its text). */
const ENTRY_COLUMNS = [
  `${jstr("obj", "$.timestamp")} AS ts`,
  `${jstr("obj", "$.type")} AS type`,
  `${jstr("obj", "$.message.role")} AS role`,
  `${jstr("obj", "$.subtype")} AS sub`,
  `${jstr("obj", "$.attachment.type")} AS atype`,
  `coalesce(${jstr("obj", "$.isMeta")} = ${sq("true")}, false) AS ismeta`,
  `${jraw("obj", "$.message.content")} AS content`,
  `${jraw("obj", "$.toolUseResult")} AS tur`,
].join(", ")

interface ElementNeeds {
  plain: boolean; sys: boolean; att: boolean; attHook: boolean; attQueued: boolean; attOther: boolean
  text: boolean; thinking: boolean; call: boolean; output: boolean
}
interface ElementFields { file?: string; commit?: string; needs: ElementNeeds; keep?: string }

/** SQL for the elements of the lines of `input`: a table expression with the columns obj (the parsed line, NULL when invalid), raw (its text),
 *  the ENTRY_COLUMNS and the pass-through columns `pass`. Out columns: pass, h (md5 of the line), ts, type, role, kinds, tool, tuid, idx, txt, fdir, cdir.
 *  `kinds` lists the element kinds most specific first: a diff, subagent or error element is ALSO a tool-call / tool-output element, so
 *  --kind tool-output never silently misses the errors and diffs, and an element is still one row.
 *  `needs` limits the work to the element sources that the selected kinds can use: the text of an attachment or of a plain message is
 *  never built for a search of tool outputs (computing every text of every line exhausted the 2GB limit even on one thread, measured
 *  2026-11-17, reports_dev/OIMXULDJ).
 *  THREE LEVELS: level 1 computes what belongs to the whole line, level 2 UNNESTs the blocks to one ROW each, level 3 computes the block
 *  expressions in ordinary 2048-row vectors (a lambda over the blocks of a line evaluates its whole child vector at once). A line that holds
 *  no block (a string content, a system entry, ...) unnests a single NULL placeholder and carries its one element in ekinds / etxt. */
function elementRows(input: string, pass: string, f: ElementFields): string {
  const { needs } = f
  const bt = jstr("b", "$.type")
  const callBlock = `${bt} IN (${inList(CALL_BLOCKS)})`
  const outputBlock = `${bt} IN (${inList(OUTPUT_BLOCKS)})`
  const name = jstr("b", "$.name")
  const input_ = `coalesce(CAST(${jraw("b", "$.input")} AS VARCHAR), ${sq("")})`
  const nullText = "NULL::VARCHAR"
  // The tool-call text is the name, a NEWLINE, then the input JSON: a pattern that spans the joint contains a newline,
  // and a pattern with a control character never uses the raw-line prefilter (rawPrefilter), so no match is lost by it.
  const textBranches = [
    needs.text ? `WHEN ${bt} = ${sq("text")} THEN ${jstr("b", "$.text")}` : "",
    needs.thinking ? `WHEN ${bt} = ${sq("thinking")} THEN ${jstr("b", "$.thinking")}` : "",
    needs.call ? `WHEN ${callBlock} THEN ${name} || chr(10) || ${input_}` : "",
    needs.output ? `WHEN ${outputBlock} THEN ${textOf(jraw("b", "$.content"))}` : "",
  ].filter(Boolean)
  const blockText = textBranches.length > 0 ? `(CASE ${textBranches.join(" ")} END)` : nullText
  const fdir = f.file === undefined ? "false"
    : `(CASE WHEN ${callBlock} THEN strpos(${input_}, ${sq(f.file)}) > 0 WHEN ${outputBlock} THEN strpos(coalesce(tfile, ${sq("")}), ${sq(f.file)}) > 0 ELSE false END)`
  const sha = f.commit === undefined ? "" : sq(f.commit.toLowerCase())
  const cdir = f.commit === undefined ? "false"
    : `coalesce(CASE WHEN ${callBlock} OR ${outputBlock} THEN strpos(lower(${blockText}), ${sha}) > 0 OR strpos(lower(coalesce(tgit, ${sq("")})), ${sha}) > 0 ELSE false END, false)`
  const kindBranches = [
    needs.text ? `WHEN ${bt} = ${sq("text")} THEN (CASE WHEN type = ${sq("assistant")} THEN ${kindList("response")} ` +
      `WHEN type = ${sq("user")} AND NOT ismeta THEN (CASE WHEN starts_with(${jstr("b", "$.text")}, ${sq("<command-name>")}) THEN ${kindList("command")} ELSE ${kindList("prompt")} END) ` +
      `ELSE ${NO_KINDS} END)` : "",
    needs.thinking ? `WHEN ${bt} = ${sq("thinking")} THEN ${kindList("thinking")}` : "",
    needs.call ? `WHEN ${callBlock} THEN (CASE WHEN ${name} IN (${inList(SUBAGENT_TOOLS)}) THEN ${kindList("subagent", "tool-call")} ` +
      `WHEN ${name} IN (${inList(DIFF_TOOLS)}) THEN ${kindList("diff", "tool-call")} ELSE ${kindList("tool-call")} END)` : "",
    needs.output ? `WHEN ${outputBlock} THEN list_concat(list_concat(CASE WHEN ${jstr("b", "$.is_error")} = ${sq("true")} THEN ${kindList("error")} ELSE ${NO_KINDS} END, ` +
      `CASE WHEN patch THEN ${kindList("diff")} ELSE ${NO_KINDS} END), ${kindList("tool-output")})` : "",
  ].filter(Boolean)
  const blockKinds = kindBranches.length > 0 ? `(CASE ${kindBranches.join(" ")} ELSE ${NO_KINDS} END)` : NO_KINDS

  // Level 1, per line: the element of a line without blocks, and the toolUseResult fields.
  const plain = jstr("content", "$")
  const plainKinds = `(CASE WHEN type = ${sq("assistant")} THEN ${kindList("response")} ` +
    `WHEN type = ${sq("user")} AND NOT ismeta THEN (CASE WHEN starts_with(${plain}, ${sq("<command-name>")}) THEN ${kindList("command")} ELSE ${kindList("prompt")} END) ` +
    `ELSE ${NO_KINDS} END)`
  // ONE json_extract per attachment line whose text is built (it returns every part the attachment texts read), and attachment text is built only for
  // the branches (hook / queued_command / other) that a selected kind reads. MEASURED (TRDD-OIMXULDJ): memory grows with the number of JSON function
  // nodes evaluated on a row once the 400-700 KB instructions / prompt_snapshot attachment lines are present (4 such nodes already ran out of memory at
  // 1.5GB); the old text ran ~14-24 nodes per attachment row, and one extract alone (without the per-kind gating) still failed. The fix is the one extract
  // PLUS the gating. INFERRED, not shown: why (a parse retained per node per 2048-row vector).
  const ATT_PARTS = ["$.attachment", "$.attachment.content", "$.attachment.stdout", "$.attachment.stderr", "$.attachment.blockingError", "$.attachment.prompt"]
  const attPart = (k: number): string => `aparts[${k + 1}]`
  const attText = (k: number): string => textOf(attPart(k))
  const attJson = `CAST(${attPart(0)} AS VARCHAR)`
  const hook = `atype IN (${inList(HOOK_ATTACHMENT_TYPES)})`
  const queued = `atype = ${sq("queued_command")}`
  // The attachment lines that a selected kind reads the text of. A NULL atype is an "other" attachment (the ELSE of attKinds).
  const attWanted = [needs.attHook ? hook : "", needs.attQueued ? queued : "", needs.attOther ? `NOT coalesce(${hook} OR ${queued}, false)` : ""].filter(Boolean).join(" OR ")
  const keepExpr = f.keep !== undefined ? `coalesce(${f.keep}, false)` : "true"
  const attWrap = needs.att && attWanted !== ""
    ? `(SELECT *, CASE WHEN keep AND type = ${sq("attachment")} AND (${attWanted}) THEN json_extract(obj, [${inList(ATT_PARTS)}]) END AS aparts FROM (SELECT *, ${keepExpr} AS keep FROM ${input}))`
    : `(SELECT *, ${keepExpr} AS keep FROM ${input})`
  const sysKinds = `WHEN ${sq("system")} THEN (CASE sub WHEN ${sq("stop_hook_summary")} THEN ${kindList("hook")} ` +
    `WHEN ${sq("local_command")} THEN ${kindList("command")} WHEN ${sq("api_error")} THEN ${kindList("error")} ` +
    `WHEN ${sq("scheduled_task_fire")} THEN ${kindList("cron")} WHEN ${sq("compact_boundary")} THEN ${kindList("compact")} ELSE ${kindList("system")} END) ` +
    `WHEN ${sq("summary")} THEN ${kindList("compact")} WHEN ${sq("queue-operation")} THEN ${kindList("command")} `
  const attKinds = `WHEN ${sq("attachment")} THEN (CASE WHEN ${hook} THEN ${kindList("hook")} WHEN atype = ${sq("queued_command")} THEN ${kindList("command")} ELSE ${kindList("attachment")} END) `
  const entryKinds = `(CASE type ${needs.sys ? sysKinds : ""}${needs.att ? attKinds : ""}ELSE ${NO_KINDS} END)`
  const sysText = `WHEN ${sq("system")} THEN coalesce(${textOf(jraw("obj", "$.content"))}, raw) ` +
    `WHEN ${sq("summary")} THEN ${jstr("obj", "$.summary")} WHEN ${sq("queue-operation")} THEN ${textOf(jraw("obj", "$.content"))} `
  const attBranch = `WHEN ${sq("attachment")} THEN (CASE WHEN ${hook} THEN ${needs.attHook ? `coalesce(nullif(concat_ws(chr(10), ${attText(1)}, ${attText(2)}, ${attText(3)}, ${attText(4)}), ${sq("")}), ${attJson})` : nullText} ` +
    `WHEN atype = ${sq("queued_command")} THEN ${needs.attQueued ? `coalesce(${attText(5)}, ${attJson})` : nullText} ` +
    `ELSE ${needs.attOther ? `coalesce(${attText(1)}, ${attJson})` : nullText} END) `
  const entryText = `(CASE type ${needs.sys ? sysText : ""}${needs.att ? attBranch : ""}END)`
  // toolUseResult.file is an OBJECT holding the file content for a Read: only its filePath is compared, never the content.
  const tfile = `coalesce(${jstr("tur", "$.filePath")}, CASE json_type(tur, ${sq("$.file")}) WHEN ${sq("VARCHAR")} THEN ${jstr("tur", "$.file")} ` +
    `WHEN ${sq("OBJECT")} THEN ${jstr("tur", "$.file.filePath")} END)`
  // `keep` (the raw prefilter and the scope filters) EMPTIES the block list of a line that fails it, instead of being a WHERE in front of the
  // UNNEST: with a row filter there the pipeline exhausted the 2GB limit (measured 2026-11-17: every run with a prefilter failed, on one thread
  // too; the same query without it passed on one thread). Level 1 also computes nothing else for a line that is not kept.
  const hasBlocks = needs.text || needs.thinking || needs.call || needs.output
  const anySource = needs.plain || needs.sys || needs.att
  const ekinds = anySource
    ? `(CASE WHEN obj IS NULL THEN ${kindList(BAD_KIND)} WHEN NOT keep THEN ${NO_KINDS} WHEN json_type(content) = ${sq("ARRAY")} THEN ${NO_KINDS} ` +
      `${needs.plain ? `WHEN json_type(content) = ${sq("VARCHAR")} THEN ${plainKinds} ` : ""}${needs.sys || needs.att ? `ELSE ${entryKinds} ` : `ELSE ${NO_KINDS} `}END)`
    : `(CASE WHEN obj IS NULL THEN ${kindList(BAD_KIND)} ELSE ${NO_KINDS} END)`
  const etxt = anySource
    ? `(CASE WHEN obj IS NULL OR NOT keep OR json_type(content) = ${sq("ARRAY")} THEN NULL ` +
      `${needs.plain ? `WHEN json_type(content) = ${sq("VARCHAR")} THEN ${plain} ` : ""}${needs.sys || needs.att ? `ELSE ${entryText} ` : ""}END)`
    : nullText
  // A line gets the one placeholder row that carries its element only when one of the needed sources can be the source of that line.
  const sourceLine = [
    needs.plain ? `json_type(content) = ${sq("VARCHAR")}` : "",
    needs.sys ? `type IN (${["system", "summary", "queue-operation"].map(sq).join(",")})` : "",
    needs.att ? `type = ${sq("attachment")}` : "",
  ].filter(Boolean).join(" OR ")
  const placeholder = sourceLine === "" ? "[]::JSON[]" : `(CASE WHEN ${sourceLine} THEN [NULL::JSON] ELSE []::JSON[] END)`
  const blocks = `(CASE WHEN obj IS NULL THEN [NULL::JSON] WHEN NOT keep THEN []::JSON[] ` +
    `${hasBlocks ? `WHEN json_type(content) = ${sq("ARRAY")} THEN from_json(content, ${sq(JSON_LIST)}) ` : ""}ELSE ${placeholder} END)`
  const level1 = `SELECT ${pass}, CASE WHEN keep THEN md5(raw) END AS h, ts, type, role, ismeta, ${ekinds} AS ekinds, ${etxt} AS etxt,
      ${needs.output ? `coalesce(json_exists(tur, ${sq("$.structuredPatch")}) OR json_exists(tur, ${sq("$.bashEditDiff")}), false)` : "false"} AS patch,
      ${needs.output ? tfile : nullText} AS tfile, ${needs.output ? `CAST(${jraw("tur", "$.gitOperation")} AS VARCHAR)` : nullText} AS tgit,
      ${blocks} AS bl
    FROM ${attWrap}`
  const level2 = `SELECT ${pass}, h, ts, type, role, ismeta, ekinds, etxt, patch, tfile, tgit, UNNEST(bl) AS b, UNNEST(range(1, len(bl) + 1)) AS i FROM (${level1})`
  return `SELECT ${pass}, h, ts, type, role,
      (CASE WHEN b IS NULL THEN ekinds ELSE ${blockKinds} END) AS kinds,
      (CASE WHEN ${callBlock} THEN ${name} END) AS tool,
      (CASE WHEN ${callBlock} THEN ${jstr("b", "$.id")} WHEN ${outputBlock} THEN ${jstr("b", "$.tool_use_id")} END) AS tuid,
      (CASE WHEN b IS NULL THEN 0 ELSE i END)::BIGINT AS idx,
      (CASE WHEN b IS NULL THEN etxt ELSE ${blockText} END) AS txt,
      ${fdir} AS fdir, ${cdir} AS cdir
    FROM (${level2})`
}

/** Which element sources the selected kinds can use. A tool, file or commit filter only ever keeps tool calls and tool outputs. */
function elementNeeds(kinds: string[], toolScoped: boolean, subOnly: boolean): ElementNeeds {
  const any = (...ks: string[]): boolean => ks.some(k => kinds.includes(k))
  return {
    // The three sources of an element that is not a content block, split so that a search never builds the text of a source it cannot use
    // (the text of every kept attachment and system line was built for --kind prompt,response,thinking, which failed 10 of 10 runs at 1.5GB):
    // plain = a string message.content, sys = system / summary / queue-operation lines, att = attachment lines.
    plain: subOnly || (!toolScoped && any("prompt", "response", "command")),
    sys: subOnly || (!toolScoped && any("command", "hook", "compact", "error", "cron", "system")),
    // att = any attachment source; attHook / attQueued / attOther = the three attachment text branches (hook attachment types, queued_command, every
    // other type), so that a search for hooks never builds the text of the big attachments (prompt_snapshot, instructions) that only --kind attachment reads.
    att: subOnly || (!toolScoped && any("command", "hook", "attachment")),
    attHook: subOnly || (!toolScoped && any("hook")),
    attQueued: subOnly || (!toolScoped && any("command")),
    attOther: subOnly || (!toolScoped && any("attachment")),
    text: subOnly || (!toolScoped && any("prompt", "response", "command")),
    thinking: subOnly || (!toolScoped && any("thinking")),
    call: subOnly || toolScoped || any("tool-call", "diff", "subagent"),
    output: subOnly || toolScoped || any("tool-output", "diff", "subagent", "error"),
  }
}

/** A raw-line condition that every line holding a match must satisfy, or null when none is sound. Sound only for a literal
 *  pattern made of printable ASCII without a quote or a backslash: JSON then stores it verbatim, so an element text that
 *  holds it lies inside the raw line. A regex, a quote, a backslash, a control character or a non-ASCII character can be
 *  written differently in the raw line (or match across what the escaping hides): no prefilter, every line in scope is split. */
function rawPrefilter(pattern: string, regex: boolean): string | null {
  if (regex || pattern === "") return null
  for (const c of pattern) {
    const n = c.codePointAt(0) ?? 0
    if (n < 0x20 || n > 0x7e || c === "\"" || c === "\\") return null
  }
  return `strpos(lower(raw), lower(${sq(pattern)})) > 0`
}

const textMatch = (col: string, pattern: string, regex: boolean): string =>
  regex ? `regexp_matches(${col}, ${sq(pattern)})` : `strpos(lower(${col}), lower(${sq(pattern)})) > 0`
const textExcerpt = (col: string, pattern: string, regex: boolean, width: number): string =>
  regex ? `substr(regexp_extract(${col}, ${sq(pattern)}), 1, ${width})`
    : `substr(${col}, greatest(1, strpos(lower(${col}), lower(${sq(pattern)})) - 100), ${width})`
/** --tool names: exact, or a mask where * stands for any run of characters. */
const toolMatch = (col: string, tools: string[]): string =>
  `(${tools.map(m => `${col} LIKE ${sq(m.replace(/[\\%_]/g, "\\$&").replace(/\*/g, "%"))} ESCAPE ${sq("\\")}`).join(" OR ")})`

interface ElementQuery extends ElementFields {
  pattern: string
  regex: boolean
  kinds: string[]
  tools?: string[]
  filters: string[]
  prefilter: string | null
  /** One transcript in scope and file order wanted: stage 1 numbers the lines itself. */
  withLine: boolean
  /** Some filter needs to know which call an output answers: a first scan builds a small table of the calls. */
  needCalls: boolean
  /** --kind subagent alone: every element of a sub-agent transcript counts, not only the Agent calls and their outputs. */
  subOnly: boolean
}

const readNdjson = (group: TranscriptFile[], maxObjectSize: number): string =>
  `read_ndjson_objects([${group.map(f => sq(f.path)).join(",")}], filename=true, maximum_object_size=${maxObjectSize}, ignore_errors=true)`

/** First scan (only when needed): (filename, tool_use id, name, flags) of the calls that a filter or --kind subagent refers to. */
function callsStage(group: TranscriptFile[], maxObjectSize: number, create: boolean, q: ElementQuery): string {
  const name = jstr("b", "$.name")
  const input = `coalesce(CAST(${jraw("b", "$.input")} AS VARCHAR), ${sq("")})`
  const inTool = q.tools ? toolMatch(name, q.tools) : "false"
  const inFile = q.file !== undefined ? `strpos(${input}, ${sq(q.file)}) > 0` : "false"
  const isSub = `${name} IN (${inList(SUBAGENT_TOOLS)})`
  const wanted = [q.tools ? inTool : "", q.file !== undefined ? inFile : "", q.kinds.includes("subagent") ? isSub : ""].filter(Boolean).join(" OR ")
  return `
    ${create ? "CREATE TEMP TABLE calls AS" : "INSERT INTO calls"}
    -- DISTINCT: the same tool_use id can appear on several lines of one transcript (measured 2026-11-17: 873 of 3246 files). Without it the
    -- join on (filename, id) multiplies every call and output with that id: --tool Bash "git" counted 32569 elements where 22918 were right
    -- (calls 14614 + outputs 8304, both confirmed by an independent count, 2026-11-17, before the request-entry default).
    SELECT DISTINCT filename, ${jstr("b", "$.id")} AS id, ${name} AS name, ${inTool} AS in_tool, ${inFile} AS in_file, ${isSub} AS is_sub
    FROM (
      SELECT filename, UNNEST(from_json(${jraw("json", "$.message.content")}, ${sq(JSON_LIST)})) AS b
      FROM ${readNdjson(group, maxObjectSize)}
      WHERE ${jstr("json", "$.type")} = ${sq("assistant")} AND json_type(json, ${sq("$.message.content")}) = ${sq("ARRAY")})
    WHERE ${jstr("b", "$.type")} IN (${inList(CALL_BLOCKS)}) AND (${wanted})`
}

/** Stage 1 of element mode: the lines pass the raw prefilter and the scope filters, are split into elements, and one small row per
 *  matching element goes into ehits. A line that is not valid JSON becomes one row with bad = true (counted, then deleted). */
function elementStage1(group: TranscriptFile[], maxObjectSize: number, create: boolean, q: ElementQuery): string {
  const sel = inList(q.kinds)
  const subFile = `contains(x.filename, ${sq(SUBAGENT_FILE)})`
  const kindsAll = q.needCalls
    ? `list_concat(list_concat(CASE WHEN coalesce(c.is_sub, false) AND list_contains(x.kinds, ${sq("tool-output")}) THEN ${kindList("subagent")} ELSE ${NO_KINDS} END, ` +
      `CASE WHEN ${q.subOnly} AND ${subFile} THEN ${kindList("subagent")} ELSE ${NO_KINDS} END), x.kinds)`
    : "x.kinds"
  const conds = [`list_has_any(${kindsAll}, [${sel}])`]
  if (q.tools) conds.push(`((x.tool IS NOT NULL AND ${toolMatch("x.tool", q.tools)}) OR coalesce(c.in_tool, false))`)
  if (q.file !== undefined) conds.push("(x.fdir OR coalesce(c.in_file, false))")
  if (q.commit !== undefined) conds.push("x.cdir")
  conds.push(textMatch("x.txt", q.pattern, q.regex))
  const isBad = `list_contains(x.kinds, ${sq(BAD_KIND)})`
  const keepParts = [q.prefilter, ...q.filters].filter((p): p is string => p !== null)
  const keep = keepParts.length > 0 ? keepParts.join(" AND ") : undefined
  return `
    ${create ? "CREATE TEMP TABLE ehits AS" : "INSERT INTO ehits"}
    WITH src AS (
      SELECT filename, ${q.withLine ? "row_number() OVER ()" : "NULL::BIGINT"} AS line, json AS obj, CAST(json AS VARCHAR) AS raw
      FROM ${readNdjson(group, maxObjectSize)}
    ), b AS (
      SELECT filename, line, obj, raw, ${ENTRY_COLUMNS} FROM src
    ), x AS (${elementRows("b", "filename, line", { ...q, keep })})
    SELECT x.filename, x.line, x.ts, x.type, x.role,
           list_filter(${kindsAll}, k -> k IN (${sel}))[1] AS kind,
           ${q.needCalls ? "coalesce(x.tool, c.name)" : "x.tool"} AS tool,
           x.tuid AS tuid, x.idx AS idx, x.h AS h, ${isBad} AS bad, NULL::VARCHAR AS note
    FROM x ${q.needCalls ? "LEFT JOIN calls c ON c.filename = x.filename AND c.id = x.tuid" : ""}
    WHERE ${isBad} OR (${conds.join(" AND ")})`
}

/** --kind model-change, first step: one small row per assistant entry that names a model (and per invalid line). */
function changeStage1(group: TranscriptFile[], maxObjectSize: number, create: boolean): string {
  return `
    ${create ? "CREATE TEMP TABLE msrc AS" : "INSERT INTO msrc"}
    SELECT filename, md5(raw) AS h, ts, model, branch, cwd, (obj IS NULL) AS bad FROM (
      SELECT filename, obj, raw, ${jstr("obj", "$.timestamp")} AS ts, ${jstr("obj", "$.message.model")} AS model,
             ${jstr("obj", "$.gitBranch")} AS branch, ${jstr("obj", "$.cwd")} AS cwd, ${jstr("obj", "$.type")} AS type
      FROM (SELECT filename, json AS obj, CAST(json AS VARCHAR) AS raw FROM ${readNdjson(group, maxObjectSize)}))
    WHERE obj IS NULL OR (type = ${sq("assistant")} AND model IS NOT NULL AND model <> ${sq("<synthetic>")})`
}

/** --kind model-change, second step: the previous model comes from a window over the small rows only (ordered by timestamp
 *  inside each file), and each change is one row: `from -> to` in note. The scope filters apply AFTER the window, so that a
 *  filtered-out entry still counts as the previous model of the next one. */
function changeStage2(q: ElementQuery): string {
  const filters = [...q.filters]
  if (q.pattern !== "") filters.push(textMatch("note", q.pattern, q.regex))
  return `
    CREATE TEMP TABLE ehits AS
    SELECT filename, NULL::BIGINT AS line, ts, ${sq("assistant")} AS type, ${sq("assistant")} AS role, ${sq("model-change")} AS kind,
           NULL::VARCHAR AS tool, NULL::VARCHAR AS tuid, 0::BIGINT AS idx, h, false AS bad, prev || ${sq(" -> ")} || model AS note
    FROM (SELECT *, lag(model) OVER (PARTITION BY filename ORDER BY ts NULLS FIRST, h) AS prev FROM msrc WHERE NOT bad)
    WHERE prev IS NOT NULL AND prev <> model ${filters.length > 0 ? `AND ${filters.join(" AND ")}` : ""}
    UNION ALL
    SELECT filename, NULL::BIGINT, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR, NULL::BIGINT, h, true, NULL::VARCHAR
    FROM msrc WHERE bad`
}

interface ShownElement { hit: SearchHit; h: string; idx: number; tuid: string | null; note: string | null }

/** Stage 2 of element mode: for the SHOWN hits, one pass per distinct file gives the physical line, the excerpt and (for an
 *  output whose call was not in the first scan) the tool name. Hits are matched back by (md5 of the line, element index);
 *  identical lines get their numbers ascending, one per hit; a vanished line gives line null, never a wrong number. */
async function assignElementLines(con: DuckDBConnection, shown: ShownElement[], q: ElementQuery, width: number): Promise<void> {
  const byFile = new Map<string, ShownElement[]>()
  for (const s of shown) byFile.set(s.hit.file, [...(byFile.get(s.hit.file) ?? []), s])
  for (const [file, items] of byFile) {
    const source = `SELECT row_number() OVER () AS rn, json AS obj, CAST(json AS VARCHAR) AS raw FROM read_ndjson_objects(${sq(file)}, maximum_object_size=${MAX_OBJECT_SIZE}, ignore_errors=true)`
    const hashes = [...new Set(items.map(i => i.h))].map(sq).join(",")
    const lines = new Map<string, number[]>()
    const excerpts = new Map<string, { excerpt: string; tool: string | null }>()
    const changes = items.filter(i => i.note !== null)
    const elements = items.filter(i => i.note === null)
    if (changes.length > 0) {
      const rows = (await con.runAndReadAll(
        `SELECT rn, h FROM (SELECT rn, md5(raw) AS h FROM (${source}) WHERE ${jstr("obj", "$.type")} = ${sq("assistant")}) WHERE h IN (${hashes}) ORDER BY rn`,
      )).getRowObjects()
      for (const r of rows) lines.set(`${String(r.h)}#0`, [...(lines.get(`${String(r.h)}#0`) ?? []), Number(r.rn)])
    }
    if (elements.length > 0) {
      const idxs = [...new Set(elements.map(i => i.idx))].join(",")
      // Only the lines of the shown hits are split; the prefilter and the md5 test come first, so the split runs on a handful of lines.
      const wantedLines = `(SELECT rn, obj, raw, ${ENTRY_COLUMNS} FROM (SELECT rn, obj, raw FROM (${source}) WHERE ${q.prefilter ? `${q.prefilter} AND ` : ""}md5(raw) IN (${hashes})))`
      const rows = (await con.runAndReadAll(
        `SELECT rn, h, idx, tool, ${textExcerpt("txt", q.pattern, q.regex, width)} AS excerpt FROM (${elementRows(wantedLines, "rn", q)})
         WHERE idx IN (${idxs}) AND ${textMatch("txt", q.pattern, q.regex)} ORDER BY rn`,
      )).getRowObjects()
      for (const r of rows) {
        const key = `${String(r.h)}#${Number(r.idx)}`
        lines.set(key, [...(lines.get(key) ?? []), Number(r.rn)])
        if (!excerpts.has(key)) excerpts.set(key, { excerpt: String(r.excerpt ?? ""), tool: (r.tool as string | null) ?? null })
      }
    }
    // An output whose call was not in the first scan: its name is the one of the tool_use block with that id, in the same transcript.
    const unnamed = elements.filter(i => i.hit.tool === null && i.tuid !== null)
    const names = new Map<string, string>()
    if (unnamed.length > 0) {
      const ids = [...new Set(unnamed.map(i => i.tuid as string))].map(sq).join(",")
      const rows = (await con.runAndReadAll(
        `SELECT ${jstr("b", "$.id")} AS id, ${jstr("b", "$.name")} AS name FROM (
           SELECT UNNEST(from_json(${jraw("json", "$.message.content")}, ${sq(JSON_LIST)})) AS b
           FROM read_ndjson_objects(${sq(file)}, maximum_object_size=${MAX_OBJECT_SIZE}, ignore_errors=true)
           WHERE ${jstr("json", "$.type")} = ${sq("assistant")} AND json_type(json, ${sq("$.message.content")}) = ${sq("ARRAY")})
         WHERE ${jstr("b", "$.id")} IN (${ids})`,
      )).getRowObjects()
      for (const r of rows) names.set(String(r.id), String(r.name))
    }
    for (const { hit, h, idx, tuid, note } of items) {
      const key = `${h}#${note !== null ? 0 : idx}`
      hit.line = lines.get(key)?.shift() ?? null
      if (note !== null) continue
      const found = excerpts.get(key)
      hit.excerpt = (found?.excerpt ?? "").replace(/\s+/g, " ").trim()
      hit.tool = hit.tool ?? found?.tool ?? (tuid !== null ? names.get(tuid) ?? null : null)
    }
  }
}

/** Element mode entry point; see the section header. Same result shape as the line-mode engine. */
async function searchElements(files: TranscriptFile[], pattern: string, opts: SearchOptions): Promise<SearchResult> {
  checkElementOptions(pattern, opts)
  const kinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : DEFAULT_KINDS
  const changeMode = kinds.includes("model-change")
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 500)
  const width = Math.min(Math.max(1, opts.width ?? 300), 2000)
  const countMode = opts.mode === "count"
  const withLine = files.length === 1 && !countMode
  const byFile = withLine && !opts.order
  const regex = opts.regex === true
  const toolScoped = Boolean(opts.tools) || opts.file !== undefined || opts.commit !== undefined
  const subOnly = kinds.length === 1 && kinds[0] === "subagent" && !toolScoped
  const q: ElementQuery = {
    pattern, regex, kinds, tools: opts.tools, file: opts.file, commit: opts.commit,
    filters: scopeFilters(opts, changeMode ? "change" : "element"),
    prefilter: rawPrefilter(pattern, regex),
    withLine,
    needCalls: Boolean(opts.tools) || opts.file !== undefined || kinds.includes("subagent"),
    subOnly,
    needs: elementNeeds(kinds, toolScoped, subOnly),
  }
  const meta = new Map(files.map(f => [f.path, f]))

  const { inst, con } = await openDuck()
  try {
    // Same reasons as line mode: no row order for the scan, unless one transcript is numbered by row_number().
    if (!withLine) await con.run("SET preserve_insertion_order = false")
    const scanStart = Date.now()
    const groups = scanGroups(files).map(g => ({ ...g, threads: Math.min(g.threads, ELEMENT_SCAN_THREADS) }))
    if (changeMode) {
      for (const [i, g] of groups.entries()) {
        await con.run(`SET threads = ${g.threads}`)
        await con.run(changeStage1(g.group, g.maxObjectSize, i === 0))
      }
      await con.run(changeStage2(q))
    } else {
      if (q.needCalls) {
        for (const [i, g] of groups.entries()) {
          await con.run(`SET threads = ${g.threads}`)
          await con.run(callsStage(g.group, g.maxObjectSize, i === 0, q))
        }
      }
      for (const [i, g] of groups.entries()) {
        await con.run(`SET threads = ${g.threads}`)
        await con.run(elementStage1(g.group, g.maxObjectSize, i === 0, q))
      }
    }
    const bad = (await con.runAndReadAll("SELECT count(*) AS n, count(DISTINCT filename) AS f FROM ehits WHERE bad")).getRowObjects()[0]
    const skipped = { lines: Number(bad.n), files: Number(bad.f) }
    if (skipped.lines > 0) await con.run("DELETE FROM ehits WHERE bad")
    const scanMs = Date.now() - scanStart
    const fileMeta = (p: unknown): TranscriptFile => {
      const f = meta.get(String(p))
      if (!f) throw new Error(`search returned a transcript that was not in the scan list: ${String(p)}`)
      return f
    }

    if (countMode) {
      const rows = (await con.runAndReadAll("SELECT filename, count(*) AS c FROM ehits GROUP BY filename ORDER BY c DESC, filename")).getRowObjects()
      const counts = rows.map(r => {
        const f = fileMeta(r.filename)
        return { file: f.path, session: f.session, agent: f.agent, count: Number(r.c) }
      })
      return { hits: [], total: counts.reduce((n, c) => n + c.count, 0), counts, timing: { scanMs, linesMs: 0 }, skipped }
    }

    const total = Number((await con.runAndReadAll("SELECT count(*) AS n FROM ehits")).getRowObjects()[0].n)
    const orderBy = byFile ? "line, idx" : `(ts IS NULL), ts ${opts.order === "old" ? "ASC" : "DESC"}, filename, idx, h`
    const rows = (await con.runAndReadAll(`SELECT filename, line, ts, type, role, kind, tool, tuid, idx, h, note FROM ehits ORDER BY ${orderBy} LIMIT ${limit}`)).getRowObjects()
    const pending: ShownElement[] = []
    const hits = rows.map(r => {
      const f = fileMeta(r.filename)
      const note = (r.note as string | null) ?? null
      const hit: SearchHit = {
        line: r.line === null || r.line === undefined ? null : Number(r.line),
        ts: (r.ts as string | null) ?? null,
        type: (r.type as string | null) ?? null,
        role: (r.role as string | null) ?? null,
        excerpt: note !== null ? note.slice(0, width) : "",
        file: f.path,
        session: f.session,
        agent: f.agent,
        kind: String(r.kind),
        tool: (r.tool as string | null) ?? null,
      }
      pending.push({ hit, h: String(r.h), idx: Number(r.idx), tuid: (r.tuid as string | null) ?? null, note })
      return hit
    })
    let linesMs = 0
    if (pending.length > 0) {
      // Stage 2 numbers the scan order with row_number() OVER (), so the order must be preserved again, on one thread.
      await con.run("SET preserve_insertion_order = true")
      await con.run("SET threads = 1")
      const linesStart = Date.now()
      await assignElementLines(con, pending, q, width)
      linesMs = Date.now() - linesStart
    }
    return { hits, total, counts: [], timing: { scanMs, linesMs }, skipped }
  } finally {
    con.closeSync()
    inst.closeSync()
  }
}

/** The --role/--type/time/branch/cwd/worktree/model filters as SQL conditions over the line columns (obj, ts, type, role).
 *  "line": plus the default exclusions (request entries, noisy attachments). "element": the request-entry exclusion only (the kind selection
 *  decides what else is searched). "change": the model-change rows, which carry branch, cwd and model as columns of their own. */
function scopeFilters(opts: SearchOptions, mode: "line" | "element" | "change"): string[] {
  const filters: string[] = []
  const field = (column: string, jsonPath: string): string => (mode === "change" ? column : jstr("obj", jsonPath))
  if (mode !== "change") {
    if (opts.role) filters.push(`role = ${sq(opts.role)}`)
    if (opts.type) filters.push(`type = ${sq(opts.type)}`)
  }
  // An explicit --type already says which entries are wanted, so the default exclusions only apply without it.
  // Request entries are out of element mode too (owner ruling 2026-11-17): an api-request-blob holds a COPY of the whole conversation, so
  // its tool_use / tool_result blocks would be counted a second time (measured on this project: 5573 of the 14614 Bash "git" call blocks sit in
  // blobs, and 30963 of the 93635 Bash call blocks).
  if (mode !== "change" && !opts.type && !opts.includeRequests) filters.push(`coalesce(type, ${sq("")}) NOT IN (${REQUEST_TYPES.map(sq).join(",")})`)
  if (mode === "line" && !opts.type && !opts.includeAttachments) {
    filters.push(`(coalesce(type, ${sq("")}) <> ${sq("attachment")} OR ${jstr("obj", "$.attachment.type")} IN (${ATTACHMENT_TYPES.map(sq).join(",")}))`)
  }
  if (opts.since) filters.push(`ts >= ${sq(opts.since)}`)
  if (opts.until) filters.push(`ts <= ${sq(opts.until)}`)
  if (opts.branch) filters.push(`${field("branch", "$.gitBranch")} = ${sq(opts.branch)}`)
  if (opts.cwd) filters.push(`strpos(coalesce(${field("cwd", "$.cwd")}, ${sq("")}), ${sq(opts.cwd)}) > 0`)
  if (opts.worktree) filters.push(`strpos(coalesce(${field("cwd", "$.cwd")}, ${sq("")}), ${sq(`/worktrees/${opts.worktree}`)}) > 0`)
  if (opts.model) filters.push(`strpos(coalesce(${field("model", "$.message.model")}, ${sq("")}), ${sq(opts.model)}) > 0`)
  return filters
}

/** The element-mode flag rules, checked before any transcript is searched (and by the engine itself). */
export function checkElementOptions(pattern: string, opts: SearchOptions): void {
  const kinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : DEFAULT_KINDS
  for (const k of kinds) {
    if (!ELEMENT_KINDS.includes(k)) throw new UsageError(`unknown --kind "${k}" — one of: ${ELEMENT_KINDS.join(", ")}`)
  }
  const changeMode = kinds.includes("model-change")
  if (changeMode && (kinds.length > 1 || opts.tools || opts.file !== undefined || opts.commit !== undefined)) {
    throw new UsageError("--kind model-change stands alone: it cannot be combined with another --kind, --tool, --file or --commit")
  }
  if (!changeMode && pattern === "") throw new UsageError("a search <pattern> is required — see: agentlenspro search --help")
  if (opts.commit !== undefined && !/^[0-9a-f]{7,40}$/i.test(opts.commit)) throw new UsageError(`--commit expects 7 to 40 hex characters, got "${opts.commit}"`)
}

/** Any of these switches the engine from raw lines to elements. */
const isElementMode = (opts: SearchOptions): boolean =>
  Boolean(opts.kinds?.length) || Boolean(opts.tools?.length) || opts.file !== undefined || opts.commit !== undefined

/**
 * Search a set of transcripts. See the file header for the two-stage shape; every flag value goes
 * through sq(), and the transcript text never enters V8 beyond the shown excerpts.
 */
export async function searchTranscripts(files: TranscriptFile[], pattern: string, opts: SearchOptions = {}): Promise<SearchResult> {
  if (files.length === 0) return { hits: [], total: 0, counts: [], timing: { scanMs: 0, linesMs: 0 }, skipped: { lines: 0, files: 0 } }
  if (isElementMode(opts)) return searchElements(files, pattern, opts)
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 500)
  const width = Math.min(Math.max(1, opts.width ?? 300), 2000)
  const countMode = opts.mode === 'count'
  const single = files.length === 1 && !countMode
  const byFile = single && !opts.order
  const meta = new Map(files.map(f => [f.path, f]))

  // Literal mode matches the RAW JSON line, where a quote is \" and a newline is \n: escape the
  // pattern the way JSON would, or a pattern with any of those silently finds nothing.
  const needle = opts.regex ? pattern : JSON.stringify(pattern).slice(1, -1)
  const matchExpr = opts.regex
    ? `regexp_matches(raw, ${sq(needle)})`
    : `strpos(lower(raw), lower(${sq(needle)})) > 0`
  // Excerpt: a window around the first hit (literal) or the first regex capture, bounded by --width.
  // Computed in SQL so an MB-sized tool_result line never crosses into JS.
  const excerptExpr = opts.regex
    ? `substr(regexp_extract(raw, ${sq(needle)}), 1, ${width})`
    : `substr(raw, greatest(1, strpos(lower(raw), lower(${sq(needle)})) - 100), ${width})`

  const filters = scopeFilters(opts, "line")
  const where = filters.length > 0 ? `WHERE obj IS NULL OR (${filters.join(' AND ')})` : ''

  const columns = countMode
    ? 'filename'
    : single
      ? `filename, line, ts, type, role, ${excerptExpr} AS excerpt, NULL::VARCHAR AS h`
      : "filename, line, ts, type, role, '' AS excerpt, md5(raw) AS h"
  const stage1 = (group: TranscriptFile[], maxObjectSize: number, create: boolean): string => `
    ${create ? 'CREATE TEMP TABLE hits AS' : 'INSERT INTO hits'}
    WITH src AS (
      SELECT filename, ${single ? 'row_number() OVER ()' : 'NULL::BIGINT'} AS line, json AS obj, CAST(json AS VARCHAR) AS raw
      FROM read_ndjson_objects([${group.map(f => sq(f.path)).join(',')}], filename=true, maximum_object_size=${maxObjectSize}, ignore_errors=true)
    ), m AS (
      SELECT filename, line, obj, raw,
             json_extract_string(obj, '$.timestamp') AS ts,
             json_extract_string(obj, '$.type') AS type,
             json_extract_string(obj, '$.message.role') AS role
      FROM src WHERE obj IS NULL OR ${matchExpr}
    )
    SELECT ${columns}, (obj IS NULL) AS bad FROM m ${where}`

  const { inst, con } = await openDuck()
  try {
    // Stage 1 needs no row order (hits are re-sorted below), and ordered inserts make DuckDB buffer
    // out-of-order batches: with the default (true) this scan hit the 2GB limit on this project's 3 GB
    // (measured). The one-transcript form must KEEP the order: its row_number() numbers the scan order.
    if (!single) await con.run('SET preserve_insertion_order = false')
    const scanStart = Date.now()
    const groups = scanGroups(files)
    for (const [i, g] of groups.entries()) {
      await con.run(`SET threads = ${g.threads}`)
      await con.run(stage1(g.group, g.maxObjectSize, i === 0))
    }
    // WHY: the reader yields one row with json NULL per line that is not valid JSON. Stage 1 keeps those rows
    // (obj IS NULL OR ...) so they can be counted here; they are removed so that no later query sees them.
    const bad = (await con.runAndReadAll('SELECT count(*) AS n, count(DISTINCT filename) AS f FROM hits WHERE bad')).getRowObjects()[0]
    const skipped = { lines: Number(bad.n), files: Number(bad.f) }
    if (skipped.lines > 0) await con.run('DELETE FROM hits WHERE bad')
    const scanMs = Date.now() - scanStart
    const fileMeta = (p: unknown): TranscriptFile => {
      const f = meta.get(String(p))
      if (!f) throw new Error(`search returned a transcript that was not in the scan list: ${String(p)}`)
      return f
    }

    if (countMode) {
      const rows = (await con.runAndReadAll('SELECT filename, count(*) AS c FROM hits GROUP BY filename ORDER BY c DESC, filename')).getRowObjects()
      const counts = rows.map(r => {
        const f = fileMeta(r.filename)
        return { file: f.path, session: f.session, agent: f.agent, count: Number(r.c) }
      })
      return { hits: [], total: counts.reduce((n, c) => n + c.count, 0), counts, timing: { scanMs, linesMs: 0 }, skipped }
    }

    const total = Number((await con.runAndReadAll('SELECT count(*) AS n FROM hits')).getRowObjects()[0].n)
    const orderBy = byFile ? 'line' : `(ts IS NULL), ts ${opts.order === 'old' ? 'ASC' : 'DESC'}, filename, line`
    const rows = (await con.runAndReadAll(`SELECT filename, line, ts, type, role, excerpt, h FROM hits ORDER BY ${orderBy} LIMIT ${limit}`)).getRowObjects()
    const pending: Array<{ hit: SearchHit; h: string }> = []
    const hits = rows.map(r => {
      const f = fileMeta(r.filename)
      const hit: SearchHit = {
        line: r.line === null || r.line === undefined ? null : Number(r.line),
        ts: (r.ts as string | null) ?? null,
        type: (r.type as string | null) ?? null,
        role: (r.role as string | null) ?? null,
        excerpt: String(r.excerpt ?? '').replace(/\s+/g, ' ').trim(),
        file: f.path,
        session: f.session,
        agent: f.agent,
      }
      if (!single) pending.push({ hit, h: String(r.h) })
      return hit
    })
    let linesMs = 0
    if (pending.length > 0) {
      // Stage 2's row_number() OVER () numbers the scan order, so the order must be preserved again.
      await con.run('SET preserve_insertion_order = true')
      // Stage 2 reads ONE file with the full 256 MB object cap: one thread, whatever stage 1 left behind
      // (the last stage-1 group sets 4 threads when every file in scope is under 32 MB).
      await con.run('SET threads = 1')
      const linesStart = Date.now()
      await assignLines(con, pending, excerptExpr, matchExpr)
      linesMs = Date.now() - linesStart
    }
    return { hits, total, counts: [], timing: { scanMs, linesMs }, skipped }
  } finally {
    con.closeSync()
    inst.closeSync()
  }
}

/** One transcript, one statement (the original entry point; file order unless `order` is given). */
export async function searchTranscript(file: string, pattern: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const st = fs.statSync(file)
  const stem = path.basename(file).replace(/\.jsonl$/, '')
  const isAgent = stem.startsWith('agent-')
  return searchTranscripts(
    [{ path: file, session: isAgent ? path.basename(path.dirname(path.dirname(file))) : stem, agent: isAgent ? stem.slice('agent-'.length) : null, size: st.size, mtimeMs: st.mtimeMs }],
    pattern,
    opts,
  )
}

// ── argv ─────────────────────────────────────────────────────────────────────────────────────────

function positiveArg(argv: string[], flag: string): number | undefined {
  const v = flagValue(argv, flag, 'a positive number')
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 1) throw new UsageError(`${flag} needs a positive number`)
  return Math.floor(n)
}

function listArg(argv: string[], flag: string): string[] | undefined {
  const v = flagValue(argv, flag, 'an id or a comma-separated list')
  if (v === undefined) return undefined
  const parts = v.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) throw new UsageError(`${flag} needs at least one id`)
  return parts
}

/** A path (resolved against the cwd) or an already-derived slug, the two shapes projectSlugOf takes. */
function projectArg(argv: string[]): string {
  const v = flagValue(argv, '--project', 'a directory')
  if (v === undefined) return process.cwd()
  return v.includes('/') || v.includes('\\') || v === '.' || v === '..' ? path.resolve(v) : v
}

function tag(x: { session: string; agent: string | null }): string {
  return x.session.slice(0, 8) + (x.agent ? `:${x.agent.slice(0, 8)}` : '')
}

// stdout is the matches alone, stderr the description of the run (see the file header).
const writeOut = (line: string): void => { process.stdout.write(`${line}\n`) }
const writeErr = (line: string): void => { process.stderr.write(`${line}\n`) }

export async function runSearchCli(argv: string[]): Promise<number> {
  assertKnownFlags(argv, KNOWN, VALUED, 'agentlenspro search --help')
  if (argv.includes('--help') || argv.includes('-h')) {
    writeOut(SEARCH_USAGE)
    return EXIT.OK
  }
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (VALUED.has(argv[i])) { i++; continue }
    if (!argv[i].startsWith('-')) positionals.push(argv[i])
  }
  const elementOpts: SearchOptions = {
    kinds: listArg(argv, '--kind'), tools: listArg(argv, '--tool'),
    file: flagValue(argv, '--file', 'a text'), commit: flagValue(argv, '--commit', 'a commit SHA'),
  }
  const pattern = positionals[0] ?? ''
  if (isElementMode(elementOpts)) checkElementOptions(pattern, elementOpts)
  else if (pattern === '') throw new UsageError('a search <pattern> is required — see: agentlenspro search --help')
  if (positionals.length > 1) throw new UsageError(`one pattern only (got ${positionals.length}) — quote patterns containing spaces`)

  const has = (flag: string): boolean => argv.includes(flag)
  const limit = positiveArg(argv, '--limit')
  const width = positiveArg(argv, '--width')
  if (has('--main-only') && has('--subagents-only')) throw new UsageError('--main-only and --subagents-only are mutually exclusive')
  if (has('--count') && has('--files')) throw new UsageError('--count and --files are mutually exclusive')
  const orderRaw = flagValue(argv, '--order')
  if (orderRaw !== undefined && orderRaw !== 'new' && orderRaw !== 'old') throw new UsageError(`--order expects new or old, got "${orderRaw}"`)
  const now = Date.now()
  const sinceRaw = flagValue(argv, '--since')
  const untilRaw = flagValue(argv, '--until')
  const since = sinceRaw !== undefined ? parseTimeArg(sinceRaw, '--since', now) : undefined
  const until = untilRaw !== undefined ? parseTimeArg(untilRaw, '--until', now) : undefined

  const project = projectArg(argv)
  let files: TranscriptFile[]
  try {
    files = discoverTranscripts(project, {
      sessions: listArg(argv, '--session'),
      agents: listArg(argv, '--agent'),
      mainOnly: has('--main-only'),
      subagentsOnly: has('--subagents-only'),
      worktrees: has('--worktrees'),
      sinceMs: since !== undefined ? Date.parse(since) : undefined,
    })
  } catch (e) {
    if (e instanceof SearchScopeError) {
      writeErr(e.message)
      return EXIT.UNKNOWN
    }
    throw e
  }
  if (files.length === 0) {
    writeErr(`no transcript found for project ${project} with this scope (--project DIR, --worktrees, --session and --agent change it)`)
    return EXIT.UNKNOWN
  }

  const countMode = has('--count')
  const filesMode = has('--files')
  const t0 = Date.now()
  const { hits, total, counts, timing, skipped } = await searchTranscripts(files, pattern, {
    regex: has('--regex'),
    role: flagValue(argv, '--role'),
    type: flagValue(argv, '--type'),
    limit,
    width,
    since,
    until,
    branch: flagValue(argv, '--branch'),
    cwd: flagValue(argv, '--cwd'),
    worktree: flagValue(argv, '--worktree'),
    model: flagValue(argv, '--model'),
    includeRequests: has('--include-requests'),
    includeAttachments: has('--include-attachments'),
    order: orderRaw,
    mode: countMode || filesMode ? 'count' : 'hits',
    ...elementOpts,
  })
  // WHAT was searched + coverage → stderr; matches alone → stdout (pipe-safe split).
  const mb = (files.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1)
  const shown = countMode || filesMode ? `${counts.length} transcript(s) match` : `showing ${hits.length}`
  const skippedNote = skipped.lines > 0 ? ` — ${skipped.lines} invalid line(s) in ${skipped.files} transcript(s) skipped` : ''
  writeErr(`searched ${files.length} transcript(s), ${mb}MB — ${total} match(es), ${shown}, ${Date.now() - t0}ms (scan ${timing.scanMs}ms, lines ${timing.linesMs}ms)${skippedNote}`)

  const asJson = has('--json')
  if (countMode) {
    if (asJson) writeOut(JSON.stringify({ total, counts, skipped }))
    else for (const c of counts) writeOut(`${c.count}\t${tag(c)}`)
  } else if (filesMode) {
    if (asJson) writeOut(JSON.stringify({ total, files: counts.map(c => c.file), skipped }))
    else for (const c of counts) writeOut(c.file)
  } else if (asJson) {
    writeOut(JSON.stringify({ total, hits, skipped }))
  } else {
    for (const h of hits) {
      const label = h.kind !== undefined ? `${h.kind}${h.tool ? ` ${h.tool}` : ''}` : h.role ?? h.type ?? '?'
      writeOut(`${tag(h)}\t#${h.line ?? '?'}\t${h.ts ?? '-'}\t[${label}]\t${h.excerpt}`)
    }
  }
  return EXIT.OK
}
