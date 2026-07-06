/**
 * Reads local session logs for Claude Code, Codex, Copilot CLI, and
 * Copilot Chat (VS Code sidebar), and synthesises SessionSummaryCard records.
 *
 * Agent log paths (Mac → Windows → Linux):
 *
 *   Claude Code  ~/.claude/projects/<project>/<uuid>.jsonl
 *                %APPDATA%\Claude\projects\<project>\<uuid>.jsonl
 *                Override: CLAUDE_CONFIG_DIR (comma-separated list of config dirs)
 *
 *   Codex        ~/.codex/sessions/<project>/<uuid>.jsonl
 *                %LOCALAPPDATA%\Codex\sessions\<project>\<uuid>.jsonl  (Windows)
 *                Override: CODEX_HOME (comma-separated list of home dirs)
 *
 *   Copilot CLI  ~/.copilot/session-state/<uuid>/events.jsonl
 *                %APPDATA%\copilot\session-state\<uuid>\events.jsonl  (Windows)
 *
 *   Copilot Chat ~/Library/Application Support/<IDE>/User/workspaceStorage/<hash>/chatSessions/<uuid>.jsonl
 *   (VS Code-   %APPDATA%\<IDE>\User\workspaceStorage\<hash>\chatSessions\<uuid>.jsonl
 *   family IDE) ~/.config/<IDE>/User/workspaceStorage/<hash>/chatSessions/<uuid>.jsonl
 *               where <IDE> is any VS Code-family IDE (see VSCODE_FAMILY_IDE_NAMES)
 *
 * Data available from logs (vs OTEL):
 *   Claude / Codex: session ID, workspace, model, timestamps, full token counts
 *                   (incl. cache reads/writes), tool calls
 *   Copilot CLI:    session ID, workspace, model, timestamps, input/output/cache tokens
 *   Copilot Chat:   session ID, workspace, initial model, timestamps, output tokens per turn
 *                   (input tokens and cache tokens are not stored by VS Code)
 *   Not available in any log: TTFT, per-tool timing, streaming speed, loop signals
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { SessionSummaryCard, TimelineEntry } from './summarizers/summarizerTypes'
import { VSCODE_FAMILY_IDE_NAMES } from './vscodeFamilyIdes'

// ── Cross-platform home resolution ────────────────────────────────────────────

function homeDir(): string {
  return os.homedir()
}

function claudeProjectsDirs(): string[] {
  // Env override: comma-separated list of Claude config dirs (each must have a projects/ sub-dir).
  const envVal = process.env['CLAUDE_CONFIG_DIR']
  if (envVal) {
    return envVal.split(',').map(p => p.trim()).filter(Boolean)
      .map(p => (p.endsWith('projects') ? p : path.join(p, 'projects')))
  }

  const home = homeDir()
  const candidates: string[] = [path.join(home, '.claude', 'projects')]

  // Windows: Claude Code uses %APPDATA%\Claude\projects
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    if (appData) candidates.unshift(path.join(appData, 'Claude', 'projects'))
  } else {
    // XDG_CONFIG_HOME on Linux/Mac
    const xdg = process.env['XDG_CONFIG_HOME']
    if (xdg) candidates.push(path.join(xdg, 'claude', 'projects'))
  }

  return candidates.filter(d => { try { return fs.statSync(d).isDirectory() } catch { return false } })
}

function codexSessionsDirs(): string[] {
  const envVal = process.env['CODEX_HOME']
  if (envVal) {
    return envVal.split(',').map(p => p.trim()).filter(Boolean)
      .map(p => path.join(p, 'sessions'))
  }
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA']
    const appData = process.env['APPDATA']
    if (local) candidates.push(path.join(local, 'Codex', 'sessions'))
    if (appData) candidates.push(path.join(appData, 'Codex', 'sessions'))
  }
  candidates.push(path.join(homeDir(), '.codex', 'sessions'))
  return candidates.filter(d => { try { return fs.statSync(d).isDirectory() } catch { return false } })
}

function openCodeDataDirs(): string[] {
  const envVal = process.env['OPENCODE_DATA_DIR']
  if (envVal) {
    return envVal.split(',').map(p => p.trim()).filter(Boolean)
      .filter(d => { try { return fs.statSync(d).isDirectory() } catch { return false } })
  }
  const home = homeDir()
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    if (appData) candidates.push(path.join(appData, 'opencode'))
  } else {
    const xdgData = process.env['XDG_DATA_HOME'] ?? path.join(home, '.local', 'share')
    candidates.push(path.join(xdgData, 'opencode'))
  }
  return candidates.filter(d => { try { return fs.statSync(d).isDirectory() } catch { return false } })
}

function copilotSessionStateDir(): string | null {
  // Copilot CLI writes session logs to ~/.copilot/session-state/<uuid>/events.jsonl
  // automatically, with no env setup required.
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    if (appData) candidates.push(path.join(appData, 'copilot', 'session-state'))
  }
  candidates.push(path.join(homeDir(), '.copilot', 'session-state'))
  return candidates.find(d => { try { return fs.statSync(d).isDirectory() } catch { return false } }) ?? null
}

function vscodeFamilyWorkspaceStorageRoots(): string[] {
  // Returns all existing workspaceStorage directories across every known
  // VS Code-family IDE (see VSCODE_FAMILY_IDE_NAMES). Copilot Chat and other
  // VS Code extensions always write chatSessions under the host IDE's directory,
  // so scanning all of them covers Cursor, Windsurf, VSCodium, Trae, Kiro, etc.
  const home = homeDir()
  const candidates: string[] = []

  for (const name of VSCODE_FAMILY_IDE_NAMES) {
    switch (process.platform) {
      case 'win32': {
        const appData = process.env['APPDATA']
        if (appData) candidates.push(path.join(appData, name, 'User', 'workspaceStorage'))
        break
      }
      case 'darwin':
        candidates.push(path.join(home, 'Library', 'Application Support', name, 'User', 'workspaceStorage'))
        break
      default: {
        const xdg = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config')
        candidates.push(path.join(xdg, name, 'User', 'workspaceStorage'))
        break
      }
    }
  }

  return candidates.filter(d => { try { return fs.statSync(d).isDirectory() } catch { return false } })
}

// ── File state tracking ───────────────────────────────────────────────────────

interface FileState {
  bytesRead: number
  mtimeMs: number
}

// ── Public interface ──────────────────────────────────────────────────────────

/** Minimal sql.js surface needed to open an external SQLite file read-only. */
export interface OpenCodeSqlFactory {
  Database: new (data: Buffer | Uint8Array) => {
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
    close(): void
  }
}

export interface LogReaderOptions {
  log?: (msg: string) => void
  /** When provided, enables reading OpenCode sessions from its SQLite DB. */
  sqlFactory?: OpenCodeSqlFactory
  /** Read-chunk size for the streaming line reader (bytes). Test-only; defaults to 1 MiB. */
  streamChunkBytes?: number
}

export interface LogSessionResult {
  card: SessionSummaryCard
  /** Workspace path extracted from the log file (cwd). May be empty for Copilot. */
  workspace: string
}

export class LogReader {
  private readonly log: (msg: string) => void
  private readonly sqlFactory: OpenCodeSqlFactory | undefined
  private readonly fileState = new Map<string, FileState>()

  // Per-file parse accumulators for INCREMENTAL parsing of large JSONL logs. Holding
  // the running accumulator across scans is what lets a growing multi-GB session be
  // re-parsed by reading only the bytes appended since the last scan (instead of the
  // whole file every time). The cache is LRU-bounded so the thousands of static
  // historical files don't pin their accumulators in memory: a static file is parsed
  // once, then its (now useless) accumulator is evicted while only the tiny
  // `fileState` skip-record is kept. A cold file that later changes is safely rebuilt
  // from offset 0 (see `_incrementalParse`).
  private readonly accumCache = new Map<string, unknown>()
  private static readonly ACCUM_CACHE_MAX = 24
  // Defensive caps for the NON-streaming read paths (Copilot line-array reads and the
  // single-object JSON snapshot reads). The large Claude/Codex logs do not use these —
  // they stream incrementally. A file beyond the cap is skipped with one log line
  // rather than risking a multi-GB heap allocation. 256 MiB array / 64 MiB JSON.
  private static readonly MAX_ARRAY_READ_BYTES = 256 * 1024 * 1024
  private static readonly MAX_JSON_BYTES = 64 * 1024 * 1024
  // Read chunk for the streaming line reader. Small enough to keep memory flat on a
  // multi-GB file, large enough to amortise syscalls. Overridable for tests so a
  // chunk-boundary (and split-UTF-8) can be exercised without a huge fixture.
  private readonly streamChunkBytes: number
  // One-shot guard: a drifted OpenCode DB schema (newer OpenCode moved model/tokens off
  // the session table into message `data` JSON) is logged once, not on every 30s scan.
  private openCodeSchemaWarned = false

  constructor(options: LogReaderOptions = {}) {
    this.log = options.log ?? (() => { /* silent */ })
    this.sqlFactory = options.sqlFactory
    this.streamChunkBytes = options.streamChunkBytes && options.streamChunkBytes > 0
      ? options.streamChunkBytes
      : 1 << 20  // 1 MiB
  }

  /** Clears cached file state so the next scan re-reads all files from scratch. */
  clearFileState(): void {
    this.fileState.clear()
    this.accumCache.clear()
  }

  /**
   * Collects all session files across all agents, sorted newest-first by mtime.
   * Does NOT read file contents. Used by the startup batch-loader to process
   * files in priority order without one big synchronous block.
   */
  collectFileMeta(): Array<{ filePath: string; mtimeMs: number; agentKey: string }> {
    const entries: Array<{ filePath: string; mtimeMs: number; agentKey: string }> = []

    // Claude
    for (const projectsDir of claudeProjectsDirs()) {
      for (const filePath of this._collectJsonlFiles(projectsDir)) {
        try { entries.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs, agentKey: 'claude' }) } catch { /* skip */ }
      }
    }
    // Codex
    for (const sessionsDir of codexSessionsDirs()) {
      for (const filePath of this._collectJsonlFiles(sessionsDir)) {
        try { entries.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs, agentKey: 'codex' }) } catch { /* skip */ }
      }
    }
    // Copilot CLI session-state
    const stateDir = copilotSessionStateDir()
    if (stateDir) {
      try {
        for (const d of fs.readdirSync(stateDir)) {
          const f = path.join(stateDir, d, 'events.jsonl')
          try { entries.push({ filePath: f, mtimeMs: fs.statSync(f).mtimeMs, agentKey: 'copilot' }) } catch { /* skip */ }
        }
      } catch { /* ignore */ }
    }

    // Copilot Chat (VS Code sidebar) — workspaceStorage/<hash>/chatSessions/
    // Two file formats exist: <uuid>.jsonl (delta log, newer) and <uuid>.json (full snapshot, older).
    // Prefer .jsonl; skip a .json file when a .jsonl sibling exists for the same session UUID.
    // Build a Set from the directory listing to avoid per-file fs.existsSync calls.
    for (const root of vscodeFamilyWorkspaceStorageRoots()) {
      try {
        for (const hashDir of fs.readdirSync(root)) {
          const chatDir = path.join(root, hashDir, 'chatSessions')
          let names: string[]
          try { names = fs.readdirSync(chatDir) } catch { continue }
          const jsonlIds = new Set(names.filter(n => n.endsWith('.jsonl')).map(n => n.slice(0, -6)))
          for (const name of names) {
            if (name.endsWith('.jsonl')) {
              const f = path.join(chatDir, name)
              try { entries.push({ filePath: f, mtimeMs: fs.statSync(f).mtimeMs, agentKey: 'copilot_vscode' }) } catch { /* skip */ }
            } else if (name.endsWith('.json') && !jsonlIds.has(name.slice(0, -5))) {
              const f = path.join(chatDir, name)
              try { entries.push({ filePath: f, mtimeMs: fs.statSync(f).mtimeMs, agentKey: 'copilot_vscode_json' }) } catch { /* skip */ }
            }
          }
        }
      } catch { /* root not accessible */ }
    }

    // OpenCode — one entry per data dir (the DB file itself is the tracked unit)
    for (const dataDir of openCodeDataDirs()) {
      const dbPath = path.join(dataDir, 'opencode.db')
      try { entries.push({ filePath: dbPath, mtimeMs: fs.statSync(dbPath).mtimeMs, agentKey: 'opencode' }) } catch { /* skip */ }
    }

    // Newest first — caller processes in this order so recent sessions appear first.
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return entries
  }

  /**
   * Parses a single file identified by collectFileMeta() and returns a result if
   * the file is new or has grown since the last scan. Returns null if unchanged.
   */
  parseFile(filePath: string, agentKey: string): LogSessionResult | null {
    const sessionId = agentKey === 'copilot'
      ? path.basename(path.dirname(filePath))  // directory name is session UUID
      : agentKey === 'copilot_vscode_json'
        ? path.basename(filePath, '.json')
        : path.basename(filePath, '.jsonl')

    switch (agentKey) {
      case 'claude':              return this._processFile(filePath, () => this._parseClaudeFile(filePath))
      case 'codex':               return this._processFile(filePath, () => this._parseCodexFile(filePath, ''))
      case 'copilot':             return this._processFile(filePath, () => this._parseCopilotFile(filePath, sessionId))
      case 'copilot_vscode':      return this._processFile(filePath, () => this._parseCopilotVSCodeFile(filePath, sessionId))
      case 'copilot_vscode_json': return this._processFile(filePath, () => this._parseCopilotVSCodeJsonFile(filePath, sessionId))
      case 'opencode':            return null  // OpenCode DB returns multiple sessions; use _scanOpenCode
      default:                    return null
    }
  }

  /** Returns all directories that should be watched for file changes. */
  getWatchDirs(): string[] {
    return [
      ...claudeProjectsDirs(),
      ...codexSessionsDirs(),
      ...((() => { const d = copilotSessionStateDir(); return d ? [d] : [] })()),
      ...vscodeFamilyWorkspaceStorageRoots(),
      ...openCodeDataDirs(),
    ]
  }

  /**
   * Scans all log directories and returns new/updated session results.
   * Files that are new or have changed since the last scan are re-parsed.
   */
  scan(): LogSessionResult[] {
    return [
      ...this._scanClaude(),
      ...this._scanCodex(),
      ...this._scanCopilot(),
      ...this._scanCopilotVSCode(),
      ...this._scanOpenCode(),
    ]
  }

  // ── Claude Code ─────────────────────────────────────────────────────────────

  private _scanClaude(): LogSessionResult[] {
    const results: LogSessionResult[] = []
    for (const projectsDir of claudeProjectsDirs()) {
      this._collectJsonlFiles(projectsDir).forEach(filePath => {
        const result = this._processFile(filePath, () => this._parseClaudeFile(filePath))
        if (result) results.push(result)
      })
    }
    return results
  }

  private _parseClaudeFile(filePath: string): LogSessionResult | null {
    // Incremental + streaming: a multi-GB Claude session is parsed in flat memory and
    // only its newly-appended bytes are processed on each scan (see _incrementalParse).
    const a = this._incrementalParse<ClaudeAccum>(filePath, _newClaudeAccum, _claudeOnEntry)
    if (!a || !a.firstTimestamp) return null
    const effectiveModel = (a.model && a.hasFastMode) ? `${a.model}-fast` : a.model
    const card = _buildCard(path.basename(filePath, '.jsonl'), 'claude_code', effectiveModel || 'claude', a.firstTimestamp, a.lastTimestamp, a.card, a.workspace)
    // Sub-agent fleet linkage (TRDD-TKN5VALS P1.3). Worktree/Task sub-agents write their
    // transcripts under a child project dir whose mangled name embeds ".claude/worktrees/
    // agent-<id>" (each "/" and "." becomes "-"). These fleet transcripts were being ingested
    // as standalone sessions, so a launching session's token cost (often on a pricey model
    // like fable-5) was invisible in its own total. Deriving the parent project from the path
    // (no guessing) lets the dashboard group the fleet under its launcher and roll their
    // tokens up. Marked agent-initiated so the UI can render them as an expandable sub-branch.
    const proj = path.basename(path.dirname(filePath))
    const wtIdx = proj.indexOf('-claude-worktrees')
    if (wtIdx > 0) {
      card.parentSessionId = proj.slice(0, wtIdx).replace(/-+$/, '')
      card.initiator = 'agent'
    }
    return { workspace: a.workspace, card }
  }

  // ── Codex ───────────────────────────────────────────────────────────────────

  private _scanCodex(): LogSessionResult[] {
    const results: LogSessionResult[] = []
    for (const sessionsDir of codexSessionsDirs()) {
      this._collectJsonlFiles(sessionsDir).forEach(filePath => {
        const result = this._processFile(filePath, () => this._parseCodexFile(filePath, sessionsDir))
        if (result) results.push(result)
      })
    }
    return results
  }

  private _parseCodexFile(filePath: string, _sessionsDir: string): LogSessionResult | null {
    // Incremental + streaming (see _incrementalParse). Codex tracks the LATEST
    // cumulative total_token_usage, so processing only newly-appended lines keeps the
    // totals correct without re-reading the whole (potentially multi-GB) file.
    const a = this._incrementalParse<CodexAccum>(filePath, _newCodexAccum, _codexOnEntry)
    if (!a || !a.firstTimestamp) return null

    // Use final total_token_usage; input_tokens includes cached, so subtract to get
    // the raw (non-cached) portion that _buildCard will re-add alongside cacheRead.
    const totalCacheRead = a.lastTotalUsage?.['cached_input_tokens'] ?? 0
    const totalInput     = Math.max(0, (a.lastTotalUsage?.['input_tokens'] ?? 0) - totalCacheRead)
    // Include reasoning tokens in output — they're billed at the output rate for o-series.
    const totalOutput    = (a.lastTotalUsage?.['output_tokens'] ?? 0)
                         + (a.lastTotalUsage?.['reasoning_output_tokens'] ?? 0)

    return {
      workspace: a.workspace,
      card: _buildCard(path.basename(filePath, '.jsonl'), 'codex', a.model || 'codex', a.firstTimestamp, a.lastTimestamp, {
        totalInput, totalOutput, totalCacheRead, totalCacheCreate: 0,
        peakContextPerTurn: 0, turns: a.turns, totalToolCalls: 0, toolCounts: {},
        filesRead: new Set(), filesChanged: new Set(), filesWritten: new Set(), filesSearched: new Set(),
        userRequest: a.userRequest, timeline: [], initiator: 'user',
      }, a.workspace),
    }
  }

  // ── Copilot CLI ──────────────────────────────────────────────────────────────
  // Reads ~/.copilot/session-state/<uuid>/events.jsonl — written automatically,
  // no env setup required. Each directory is one session (dirname = session ID).
  //
  // Key event types:
  //   session.start        → data.sessionId, data.selectedModel, data.startTime, data.context.cwd
  //   user.message         → data.transformedContent (user request text)
  //   assistant.message    → data.outputTokens, data.toolRequests
  //   session.shutdown     → data.modelMetrics[model].usage.{inputTokens,cacheReadTokens,cacheWriteTokens}

  private _scanCopilot(): LogSessionResult[] {
    const results: LogSessionResult[] = []
    const stateDir = copilotSessionStateDir()
    if (!stateDir) return results

    let sessionDirs: string[]
    try {
      sessionDirs = fs.readdirSync(stateDir)
    } catch { return results }

    for (const sessionDirName of sessionDirs) {
      const eventsFile = path.join(stateDir, sessionDirName, 'events.jsonl')
      const result = this._processFile(eventsFile, () => this._parseCopilotFile(eventsFile, sessionDirName))
      if (result) results.push(result)
    }

    return results
  }

  private _parseCopilotFile(filePath: string, sessionId: string): LogSessionResult | null {
    const lines = this._readNewLines(filePath)
    if (!lines) return null

    let workspace = ''
    let model = ''
    let firstTimestamp = ''
    let lastTimestamp = ''
    let userRequest = ''
    let totalOutput = 0
    let totalInputFromShutdown = 0
    let totalCacheRead = 0
    let totalCacheCreate = 0
    let turns = 0, totalToolCalls = 0
    const toolCounts: Record<string, number> = {}
    const filesChanged = new Set<string>()

    for (const line of lines) {
      let event: Record<string, unknown>
      try { event = JSON.parse(line) as Record<string, unknown> } catch { continue }

      const ts = event['timestamp'] as string | undefined
      if (ts) {
        if (!firstTimestamp) firstTimestamp = ts
        const type = event['type'] as string | undefined
        if (type === 'user.message' || type === 'assistant.message' || type === 'session.shutdown') lastTimestamp = ts
      }

      const type = event['type'] as string | undefined
      const data = event['data'] as Record<string, unknown> | undefined
      if (!type || !data) continue

      if (type === 'session.start') {
        if (data['selectedModel']) model = String(data['selectedModel'])
        const ctx = data['context'] as Record<string, unknown> | undefined
        if (ctx?.['cwd']) workspace = String(ctx['cwd'])
        if (data['startTime'] && !firstTimestamp) firstTimestamp = String(data['startTime'])
      }

      if (type === 'user.message' && !userRequest) {
        userRequest = _extractCopilotUserText(String(data['transformedContent'] ?? ''))
      }

      if (type === 'assistant.message') {
        const outTok = data['outputTokens'] as number | undefined
        if (outTok) { totalOutput += outTok; turns++ }
        const toolReqs = data['toolRequests'] as Array<Record<string, unknown>> | undefined
        if (toolReqs) {
          for (const req of toolReqs) {
            const name = String(req['name'] ?? '')
            if (!name) continue
            totalToolCalls++
            toolCounts[name] = (toolCounts[name] ?? 0) + 1
            // Track file paths from write/edit tools
            const args = req['arguments'] as Record<string, unknown> | undefined
            const fp = String(args?.['path'] ?? args?.['file_path'] ?? '')
            if (fp && (name === 'edit' || name === 'write' || name === 'create')) {
              filesChanged.add(fp)
            }
          }
        }
        if (data['model']) model = String(data['model'])
      }

      if (type === 'session.shutdown') {
        // modelMetrics[model].usage has the real cumulative token counts.
        // data['currentTokens'] is only the context window size at shutdown — do not use it.
        const metrics = data['modelMetrics'] as Record<string, Record<string, unknown>> | undefined
        if (metrics) {
          for (const entry of Object.values(metrics)) {
            const usage = (entry as Record<string, unknown>)?.['usage'] as Record<string, number> | undefined
            if (!usage) continue
            totalInputFromShutdown += usage['inputTokens']     ?? 0
            totalCacheRead          += usage['cacheReadTokens']  ?? 0
            totalCacheCreate        += usage['cacheWriteTokens'] ?? 0
          }
        }
      }
    }

    if (!firstTimestamp) return null

    return {
      workspace,
      card: _buildCard(sessionId, 'copilot', model || 'copilot', firstTimestamp, lastTimestamp, {
        totalInput: totalInputFromShutdown,
        totalOutput,
        totalCacheRead,
        totalCacheCreate,
        peakContextPerTurn: 0,
        turns,
        totalToolCalls,
        toolCounts,
        filesRead: new Set(),
        filesChanged,
        filesWritten: new Set(),
        filesSearched: new Set(),
        userRequest: userRequest.slice(0, 500),
        timeline: [],
        initiator: 'user',
      }, workspace),
    }
  }

  // ── Copilot Chat (VS Code sidebar) ───────────────────────────────────────────
  // Reads workspaceStorage/<hash>/chatSessions/<uuid>.jsonl — written automatically
  // by VS Code for every Copilot Chat panel session, no env setup required.
  //
  // The JSONL is a delta log; each line is an operation on a shared session object:
  //   kind=0  initial session snapshot (creationDate, sessionId, selectedModel)
  //   kind=1  set  — k is key path, v is new value
  //   kind=2  push — k is key path, v is array of items to append
  //
  // Data available: sessionId, creationDate, workspace (via workspace.json),
  //   initial model, completionTokens per turn, turn timestamps, turn duration.
  // NOT available: input tokens, cache tokens, model per turn.

  private _scanCopilotVSCode(): LogSessionResult[] {
    const results: LogSessionResult[] = []
    for (const root of vscodeFamilyWorkspaceStorageRoots()) {
      try {
        for (const hashDir of fs.readdirSync(root)) {
          const chatDir = path.join(root, hashDir, 'chatSessions')
          let names: string[]
          try { names = fs.readdirSync(chatDir) } catch { continue }
          const jsonlIds = new Set(names.filter(n => n.endsWith('.jsonl')).map(n => n.slice(0, -6)))
          for (const name of names) {
            if (name.endsWith('.jsonl')) {
              const filePath = path.join(chatDir, name)
              const sessionId = path.basename(filePath, '.jsonl')
              const result = this._processFile(filePath, () => this._parseCopilotVSCodeFile(filePath, sessionId))
              if (result) results.push(result)
            } else if (name.endsWith('.json') && !jsonlIds.has(name.slice(0, -5))) {
              const filePath = path.join(chatDir, name)
              const sessionId = path.basename(filePath, '.json')
              const result = this._processFile(filePath, () => this._parseCopilotVSCodeJsonFile(filePath, sessionId))
              if (result) results.push(result)
            }
          }
        }
      } catch { /* root not accessible */ }
    }
    return results
  }

  private _parseCopilotVSCodeFile(filePath: string, sessionId: string): LogSessionResult | null {
    const lines = this._readNewLines(filePath)
    if (!lines) return null

    // Workspace from sibling workspace.json two levels up (workspaceStorage/<hash>/workspace.json)
    const workspaceJsonPath = path.join(path.dirname(filePath), '..', 'workspace.json')
    let workspace = ''
    try {
      const wj = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf-8')) as Record<string, unknown>
      const folderUri = String(wj['folder'] ?? '')
      if (folderUri.startsWith('file:///')) {
        let p = decodeURIComponent(folderUri.slice(7))  // strip 'file://'
        // On Windows file:///C:/... → /C:/... → strip leading slash
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1)
        workspace = p
      }
    } catch { /* no workspace.json — no-folder or untitled window */ }

    let sessionCreatedMs = 0
    let model = ''
    let userRequest = ''
    let totalOutput = 0

    // Per-turn data keyed by turn index.
    // completionTokens appears in three formats depending on VS Code / Copilot Chat version:
    //   Format A (current):  kind=1, k=["requests", N, "completionTokens"], v=number
    //   Format B (current):  embedded in kind=2 push object as req.completionTokens
    //   Format C (pre-mid-2026): kind=1, k=["requests", N, "result"], v.usage.completionTokens
    //     Format C also carries v.usage.promptTokens (per-turn input tokens — correct for billing).
    // kind=1 always takes precedence over Format B (arrives later, streaming-final value).
    const turnCompletionTokens = new Map<number, number>()
    const turnPromptTokens = new Map<number, number>()  // Format C only
    const turnTimestamps: number[] = []
    let requestPushCount = 0  // tracks implicit turn index for kind=2 pushes

    for (const line of lines) {
      let entry: Record<string, unknown>
      try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }

      const kind = entry['kind'] as number | undefined
      const k = entry['k']
      const v = entry['v']

      // kind=0: initial session snapshot
      if (kind === 0 && v && typeof v === 'object') {
        const sv = v as Record<string, unknown>
        if (typeof sv['creationDate'] === 'number') sessionCreatedMs = sv['creationDate']
        const inputState = sv['inputState'] as Record<string, unknown> | undefined
        const selModel = inputState?.['selectedModel'] as Record<string, unknown> | undefined
        const meta = selModel?.['metadata'] as Record<string, unknown> | undefined
        if (typeof meta?.['family'] === 'string') model = meta['family']
        else if (typeof selModel?.['id'] === 'string') model = selModel['id']
      }

      // kind=2 push to 'requests' — new turn(s); may already carry completionTokens (Format B).
      // k must be exactly ['requests']; k=['requests', N, 'response'] are sub-array pushes for
      // turn response entries and must not be treated as new request objects.
      if (kind === 2 && Array.isArray(k) && k.length === 1 && k[0] === 'requests' && Array.isArray(v)) {
        for (let j = 0; j < (v as unknown[]).length; j++) {
          const req = (v as Array<Record<string, unknown>>)[j]
          const turnIdx = requestPushCount + j
          if (typeof req['timestamp'] === 'number') turnTimestamps[turnIdx] = req['timestamp']
          // Format B: completionTokens already in the push object (don't overwrite kind=1 value)
          if (typeof req['completionTokens'] === 'number' && !turnCompletionTokens.has(turnIdx)) {
            turnCompletionTokens.set(turnIdx, req['completionTokens'])
          }
          // Format B: message.text is the raw user prompt — much cleaner than renderedUserMessage
          if (turnIdx === 0 && !userRequest) {
            const msg = req['message'] as Record<string, unknown> | undefined
            if (typeof msg?.['text'] === 'string' && (msg['text'] as string).trim()) {
              userRequest = (msg['text'] as string).trim()
            }
          }
          // Format B: modelId field (e.g. "copilot/gpt-4.1")
          if (!model && typeof req['modelId'] === 'string') {
            model = (req['modelId'] as string).replace(/^copilot\//, '')
          }
        }
        requestPushCount += (v as unknown[]).length
      }

      // kind=1 sets on a specific request key (Format A/C, or late-arriving streaming final value)
      if (kind === 1 && Array.isArray(k) && k[0] === 'requests' && typeof k[1] === 'number') {
        const idx = k[1] as number
        // Format A: output tokens stored directly at the completionTokens key
        if (k[2] === 'completionTokens' && typeof v === 'number') {
          turnCompletionTokens.set(idx, v)
        }
        if (k[2] === 'result' && v && typeof v === 'object') {
          const result = v as Record<string, unknown>
          // Format C (pre-mid-2026): token counts nested inside result.usage
          const usage = result['usage'] as Record<string, number> | undefined
          if (usage) {
            if (typeof usage['completionTokens'] === 'number') {
              turnCompletionTokens.set(idx, usage['completionTokens'])
            }
            if (typeof usage['promptTokens'] === 'number') {
              turnPromptTokens.set(idx, usage['promptTokens'])
            }
          }
          // User message from renderedUserMessage (any-turn fallback when message.text not available)
          if (!userRequest) {
            const meta = result['metadata'] as Record<string, unknown> | undefined
            const rendered = meta?.['renderedUserMessage'] as Array<Record<string, unknown>> | undefined
            if (rendered) {
              for (const chunk of rendered) {
                if (chunk['type'] === 1 && typeof chunk['text'] === 'string') {
                  userRequest = _extractVSCodeCopilotUserText(chunk['text'])
                  if (userRequest) break
                }
              }
            }
          }
        }
      }
    }

    for (const tokens of turnCompletionTokens.values()) totalOutput += tokens
    let totalInput = 0
    for (const tokens of turnPromptTokens.values()) totalInput += tokens
    const turns = turnCompletionTokens.size
    if (turns === 0 || sessionCreatedMs === 0) return null

    const startTs = new Date(sessionCreatedMs).toISOString()
    const validTs = turnTimestamps.filter((n): n is number => n !== undefined)
    const lastTurnMs = validTs.length > 0 ? Math.max(...validTs) : sessionCreatedMs
    const endTs = new Date(lastTurnMs).toISOString()

    return {
      workspace,
      card: _buildCard(sessionId, 'copilot', model || 'copilot', startTs, endTs, {
        totalInput,
        totalOutput,
        totalCacheRead: 0,
        totalCacheCreate: 0,
        peakContextPerTurn: 0,
        turns,
        totalToolCalls: 0,
        toolCounts: {},
        filesRead: new Set(),
        filesChanged: new Set(),
        filesWritten: new Set(),
        filesSearched: new Set(),
        userRequest: userRequest.slice(0, 500),
        timeline: [],
        initiator: 'user',
      }, workspace),
    }
  }

  // ── Copilot Chat (VS Code sidebar) — legacy JSON snapshot format ─────────────
  // Older Copilot Chat versions (before the delta-log JSONL format) wrote each
  // session as a single <uuid>.json file containing the full session state object.
  // These files are only collected when no .jsonl sibling exists for the same UUID.
  //
  // Data available: sessionId, creationDate, lastMessageDate, model (from per-turn
  //   modelId or inputState.selectedModel), user prompt (message.text), turn count,
  //   tool call presence.
  // Not available: output/input/cache tokens (not stored in older format).

  private _parseCopilotVSCodeJsonFile(filePath: string, sessionId: string): LogSessionResult | null {
    const data = this._readJsonFile(filePath)
    if (!data) return null

    const creationMs = typeof data['creationDate'] === 'number' ? data['creationDate'] : 0
    const lastMs     = typeof data['lastMessageDate'] === 'number' ? data['lastMessageDate'] : 0
    if (!creationMs) return null

    const requests = data['requests']
    if (!Array.isArray(requests) || requests.length === 0) return null

    // Workspace from sibling workspace.json two levels up (workspaceStorage/<hash>/workspace.json)
    const workspaceJsonPath = path.join(path.dirname(filePath), '..', 'workspace.json')
    let workspace = ''
    try {
      const wj = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf-8')) as Record<string, unknown>
      const folderUri = String(wj['folder'] ?? '')
      if (folderUri.startsWith('file:///')) {
        let p = decodeURIComponent(folderUri.slice(7))
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1)
        workspace = p
      }
    } catch { /* no workspace.json — no-folder or untitled window */ }

    // Model: prefer per-turn modelId on first request; fall back to inputState
    let model = ''
    const inputState = data['inputState'] as Record<string, unknown> | undefined
    if (inputState) {
      const selModel = inputState['selectedModel'] as Record<string, unknown> | undefined
      const meta = selModel?.['metadata'] as Record<string, unknown> | undefined
      if (typeof meta?.['family'] === 'string') model = meta['family']
      else if (typeof selModel?.['id'] === 'string') model = selModel['id']
    }

    let userRequest = ''
    let totalToolCalls = 0
    const toolCounts: Record<string, number> = {}

    for (const req of requests as Array<Record<string, unknown>>) {
      if (!model && typeof req['modelId'] === 'string') {
        model = (req['modelId'] as string).replace(/^copilot\//, '')
      }
      if (!userRequest) {
        const msg = req['message'] as Record<string, unknown> | undefined
        if (typeof msg?.['text'] === 'string' && (msg['text'] as string).trim()) {
          userRequest = (msg['text'] as string).trim()
        } else if (Array.isArray(msg?.['parts'])) {
          // Older format: message has no top-level text, only a parts array
          for (const part of msg['parts'] as Array<Record<string, unknown>>) {
            if (typeof part['text'] === 'string' && (part['text'] as string).trim()
                && !((part['text'] as string).trim().startsWith('<'))) {
              userRequest = (part['text'] as string).trim()
              break
            }
          }
        }
      }
      const response = req['response']
      if (Array.isArray(response)) {
        for (const entry of response as Array<Record<string, unknown>>) {
          if (entry['kind'] === 'toolInvocationSerialized') {
            totalToolCalls++
            const toolId = String(entry['toolId'] ?? 'unknown')
            toolCounts[toolId] = (toolCounts[toolId] ?? 0) + 1
          }
        }
      }
    }

    const sid = String(data['sessionId'] ?? sessionId)
    const startTs = new Date(creationMs).toISOString()
    const endTs   = new Date(lastMs || creationMs).toISOString()

    return {
      workspace,
      card: _buildCard(sid, 'copilot', model || 'copilot', startTs, endTs, {
        totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheCreate: 0,
        peakContextPerTurn: 0,
        turns: (requests as unknown[]).length,
        totalToolCalls,
        toolCounts,
        filesRead: new Set(), filesChanged: new Set(), filesWritten: new Set(), filesSearched: new Set(),
        userRequest: userRequest.slice(0, 500),
        timeline: [], initiator: 'user',
      }, workspace),
    }
  }

  // ── OpenCode ──────────────────────────────────────────────────────────────────
  // Primary data source: ~/.local/share/opencode/opencode.db (SQLite)
  //   Tables: session (id, parent_id, title, cwd, time), message (id, session_id, data JSON)
  // Fallback: ~/.local/share/opencode/storage/message/*.json (one JSON per message)
  // Override: OPENCODE_DATA_DIR (comma-separated list of data dirs)
  //
  // Only root sessions (parent_id IS NULL / '') are included in this pass.
  // Subagent session attribution is left for a follow-up.

  /** Public entry point for the initial batch load in extension.ts. */
  scanOpenCode(): LogSessionResult[] {
    return this._scanOpenCode()
  }

  private _scanOpenCode(): LogSessionResult[] {
    const results: LogSessionResult[] = []
    const dirs = openCodeDataDirs()

    for (const dataDir of dirs) {
      const dbPath = path.join(dataDir, 'opencode.db')
      const walPath = dbPath + '-wal'
      try {
        const stat = fs.statSync(dbPath)
        // Also check WAL mtime — OpenCode writes to the WAL, not the DB file directly.
        let walMtime = 0
        try { walMtime = fs.statSync(walPath).mtimeMs } catch { /* no WAL */ }
        const effectiveMtime = Math.max(stat.mtimeMs, walMtime)
        const prev = this.fileState.get(dbPath)
        if (prev && effectiveMtime === prev.mtimeMs && stat.size === prev.bytesRead) continue
        this.fileState.set(dbPath, { bytesRead: stat.size, mtimeMs: effectiveMtime })
      } catch {
        continue
      }

      if (this.sqlFactory) {
        try {
          results.push(...this._parseOpenCodeDb(dbPath))
        } catch (err) {
          this.log(`[LogReader] OpenCode DB error ${dbPath}: ${err}`)
          results.push(...this._parseOpenCodeJsonFallback(dataDir))
        }
      } else {
        results.push(...this._parseOpenCodeJsonFallback(dataDir))
      }
    }
    return results
  }

  private _parseOpenCodeDb(dbPath: string): LogSessionResult[] {
    let buf: Uint8Array = fs.readFileSync(dbPath)
    const walPath = dbPath + '-wal'
    try {
      const wal = fs.readFileSync(walPath)
      if (wal.length > 32) buf = _mergeWal(buf, wal)
    } catch { /* no WAL file — main DB is fully checkpointed */ }
    const db = new this.sqlFactory!.Database(buf)
    try {
      // Schema-drift guard: newer OpenCode moved model + token columns off the `session`
      // table (into message `data` JSON), so the legacy query below throws `no such column:
      // s.model` on every scan. Detect the unsupported schema, log ONCE, and skip cleanly —
      // no per-scan error spam, and don't fall through to the JSON fallback (which targets an
      // even-older on-disk format and would find nothing here). Updating the parser to the new
      // schema is deferred until there's real data to validate against.
      const info = db.exec('PRAGMA table_info(session)')
      const sessionCols = new Set((info[0]?.values ?? []).map(r => String(r[1])))
      if (!sessionCols.has('model') || !sessionCols.has('tokens_input')) {
        if (!this.openCodeSchemaWarned) {
          this.openCodeSchemaWarned = true
          this.log('[LogReader] OpenCode DB schema unsupported (session table lacks model/tokens columns — newer OpenCode stores them in message data); skipping OpenCode sessions until the parser is updated.')
        }
        return []
      }
      // ── Session rows ───────────────────────────────────────────────────────
      const sessRows = db.exec(`
        SELECT s.id, s.directory, s.title, s.time_created,
               json_extract(s.model, '$.id') AS model_id,
               s.tokens_input, s.tokens_output, s.tokens_reasoning,
               s.tokens_cache_read, s.tokens_cache_write
        FROM session s
        WHERE (s.parent_id IS NULL OR s.parent_id = '')
          AND (s.tokens_input + s.tokens_output + s.tokens_cache_read + s.tokens_cache_write) > 0
        ORDER BY s.time_created DESC
      `)
      if (!sessRows[0]) return []
      const sc = (n: string) => sessRows[0].columns.indexOf(n)
      const sessionIds = sessRows[0].values.map(r => String(r[sc('id')]))
      if (sessionIds.length === 0) return []

      // ── Message rows (per-turn timing & token breakdown) ──────────────────
      // db.exec() doesn't accept bind parameters — inline quoted IDs (trusted, same-DB source).
      const inList = sessionIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',')
      const msgRows = db.exec(
        `SELECT session_id, id AS msg_id,
                json_extract(data,'$.role')           AS role,
                json_extract(data,'$.time.created')   AS t_created,
                json_extract(data,'$.time.completed') AS t_completed,
                json_extract(data,'$.tokens.input')   AS tok_in,
                json_extract(data,'$.tokens.output')  AS tok_out
         FROM message WHERE session_id IN (${inList})
         ORDER BY time_created ASC`,
      )

      // ── Part rows (user text, tool names, files, tool I/O for timeline) ──────
      // part table may be absent in older DB versions — gracefully skip if so.
      let partRows: Array<{ columns: string[]; values: unknown[][] }> = []
      try {
        partRows = db.exec(
          `SELECT p.session_id, p.message_id, p.time_created AS part_ts,
                  json_extract(m.data,'$.role')                 AS msg_role,
                  json_extract(p.data,'$.type')                 AS type,
                  json_extract(p.data,'$.text')                 AS text,
                  json_extract(p.data,'$.tool')                 AS tool_name,
                  json_extract(p.data,'$.callID')               AS call_id,
                  json_extract(p.data,'$.state.input.filePath') AS file_path,
                  json_extract(p.data,'$.state.input')          AS tool_input_json,
                  substr(json_extract(p.data,'$.state.output'),1,2000) AS tool_output,
                  json_extract(p.data,'$.state.status')         AS tool_status
           FROM part p JOIN message m ON m.id = p.message_id
           WHERE p.session_id IN (${inList})
           ORDER BY p.time_created ASC`,
        )
      } catch { /* part table absent in this DB version */ }

      // Index by session
      interface MsgInfo { msgId: string; tCreated: number; tCompleted: number; tokIn: number; tokOut: number }
      interface PartInfo {
        partTs: number; msgRole: string; type: string
        text: string | null; toolName: string | null; callId: string | null
        filePath: string | null; toolInputJson: string | null
        toolOutput: string | null; toolStatus: string | null
      }
      const msgsBySess  = new Map<string, MsgInfo[]>()
      const partsBySess = new Map<string, PartInfo[]>()

      if (msgRows[0]) {
        const mc = (n: string) => msgRows[0].columns.indexOf(n)
        for (const r of msgRows[0].values) {
          const sid = String(r[mc('session_id')])
          if (!msgsBySess.has(sid)) msgsBySess.set(sid, [])
          if (String(r[mc('role')]) === 'assistant') {
            msgsBySess.get(sid)!.push({
              msgId: String(r[mc('msg_id')]),
              tCreated:   Number(r[mc('t_created')]   ?? 0),
              tCompleted: Number(r[mc('t_completed')] ?? 0),
              tokIn:  Number(r[mc('tok_in')]  ?? 0),
              tokOut: Number(r[mc('tok_out')] ?? 0),
            })
          }
        }
      }
      if (partRows[0]) {
        const pc = (n: string) => partRows[0].columns.indexOf(n)
        for (const r of partRows[0].values) {
          const sid = String(r[pc('session_id')])
          if (!partsBySess.has(sid)) partsBySess.set(sid, [])
          partsBySess.get(sid)!.push({
            partTs:       Number(r[pc('part_ts')]         ?? 0),
            msgRole:      String(r[pc('msg_role')]        ?? ''),
            type:         String(r[pc('type')]            ?? ''),
            text:         r[pc('text')]           != null ? String(r[pc('text')])           : null,
            toolName:     r[pc('tool_name')]      != null ? String(r[pc('tool_name')])      : null,
            callId:       r[pc('call_id')]        != null ? String(r[pc('call_id')])        : null,
            filePath:     r[pc('file_path')]      != null ? String(r[pc('file_path')])      : null,
            toolInputJson:r[pc('tool_input_json')]!= null ? String(r[pc('tool_input_json')]): null,
            toolOutput:   r[pc('tool_output')]    != null ? String(r[pc('tool_output')])    : null,
            toolStatus:   r[pc('tool_status')]    != null ? String(r[pc('tool_status')])    : null,
          })
        }
      }

      // ── Build cards ────────────────────────────────────────────────────────
      const results: LogSessionResult[] = []
      for (const row of sessRows[0].values) {
        const sessionId = String(row[sc('id')] ?? '')
        if (!sessionId) continue

        const timeMs    = Number(row[sc('time_created')]      ?? 0)
        const startTs   = timeMs > 0 ? new Date(timeMs).toISOString() : ''
        const modelId   = String(row[sc('model_id')]          ?? '')
        const workspace = String(row[sc('directory')]         ?? '')
        const tokIn     = Number(row[sc('tokens_input')]      ?? 0)
        const tokOut    = Number(row[sc('tokens_output')]     ?? 0)
        const tokReason = Number(row[sc('tokens_reasoning')]  ?? 0)
        const tokCR     = Number(row[sc('tokens_cache_read')] ?? 0)
        const tokCW     = Number(row[sc('tokens_cache_write')]?? 0)
        const title     = String(row[sc('title')] ?? '')

        const msgs  = msgsBySess.get(sessionId)  ?? []
        const parts = partsBySess.get(sessionId) ?? []

        // User request: last user-typed text (parts are ordered ASC, so last wins).
        // OpenCode sessions are multi-turn; the most recent prompt best identifies current work.
        // Falls back to AI-generated session title if no user text parts exist.
        let userRequest = title.slice(0, 500)
        for (const p of parts) {
          if (p.msgRole === 'user' && p.type === 'text' && p.text) {
            userRequest = p.text.slice(0, 500)
          }
        }

        // Tools, files, and timeline events built in a single pass (parts are ASC by time).
        // LLM entries come from messages; tool entries come from tool parts.
        // We merge them by timestamp so the Flow tab shows real interleaved activity.
        const toolCounts: Record<string, number> = {}
        const filesRead    = new Set<string>()
        const filesWritten = new Set<string>()
        const filesChanged = new Set<string>()
        let totalToolCalls = 0

        // Keyed events: msgId → LLM entry (filled from msgs), callId → tool entry
        type PendingLlm  = { ts: number; entry: TimelineEntry }
        type PendingTool = { ts: number; entry: TimelineEntry }
        const llmEvents:  PendingLlm[]  = []
        const toolEvents: PendingTool[] = []

        // LLM entries from assistant messages
        let llmIdx = 0
        let lastCompleted = 0
        for (const m of msgs) {
          const durationMs = m.tCompleted > m.tCreated ? m.tCompleted - m.tCreated : 0
          llmEvents.push({
            ts: m.tCreated,
            entry: {
              type: 'llm', spanId: `oc-${m.msgId}`,
              label: `Turn ${++llmIdx}`,
              durationMs,
              inputTokens: m.tokIn, outputTokens: m.tokOut,
              isError: false,
              timestamp: m.tCreated > 0 ? new Date(m.tCreated).toISOString() : startTs,
              model: modelId || undefined,
            },
          })
          if (m.tCompleted > lastCompleted) lastCompleted = m.tCompleted
        }

        // Tool entries from tool parts
        for (const p of parts) {
          if (p.type !== 'tool' || !p.toolName) continue
          toolCounts[p.toolName] = (toolCounts[p.toolName] ?? 0) + 1
          totalToolCalls++
          if (p.filePath) {
            const t = p.toolName.toLowerCase()
            if (t === 'read' || t === 'glob' || t === 'grep') {
              filesRead.add(p.filePath)
            } else if (t === 'write' || t === 'edit' || t === 'patch') {
              filesWritten.add(p.filePath)
              filesChanged.add(p.filePath)
            }
          }
          const isError = p.toolStatus === 'error'
          const label = p.filePath
            ? `${p.toolName}: ${p.filePath.split('/').pop()}`
            : p.toolName
          toolEvents.push({
            ts: p.partTs,
            entry: {
              type: 'tool', spanId: `oc-tool-${p.callId ?? p.partTs}`,
              label,
              action: p.toolName,
              toolInput: p.toolInputJson ?? undefined,
              resultSummary: p.toolOutput ? p.toolOutput.slice(0, 200) : undefined,
              fullResult: p.toolOutput ?? undefined,
              durationMs: 0,
              isError,
              errorMessage: isError ? (p.toolOutput ?? undefined) : undefined,
              timestamp: p.partTs > 0 ? new Date(p.partTs).toISOString() : startTs,
            },
          })
        }

        // Merge LLM and tool events in chronological order
        const allEvents = [...llmEvents, ...toolEvents].sort((a, b) => a.ts - b.ts)
        const timeline: TimelineEntry[] = allEvents.map(e => e.entry)

        const endTs = lastCompleted > 0 ? new Date(lastCompleted).toISOString() : startTs

        const card = _buildCard(
          sessionId, 'opencode', modelId || 'opencode',
          startTs, endTs,
          {
            totalInput: tokIn, totalOutput: tokOut + tokReason,
            totalCacheRead: tokCR, totalCacheCreate: tokCW, peakContextPerTurn: 0,
            turns: msgs.length, totalToolCalls, toolCounts,
            filesRead, filesChanged, filesWritten, filesSearched: new Set(),
            userRequest, timeline, initiator: 'user',
          },
          workspace,
        )
        results.push({ card, workspace })
      }
      return results
    } finally {
      db.close()
    }
  }

  private _parseOpenCodeJsonFallback(dataDir: string): LogSessionResult[] {
    // Reads ~/.local/share/opencode/storage/message/*.json as a fallback when
    // the SQLite DB is unavailable. Each file is one message; session grouping
    // uses the session_id field. Session title and cwd are not available here.
    const msgDir = path.join(dataDir, 'storage', 'message')
    let names: string[]
    try { names = fs.readdirSync(msgDir).filter(n => n.endsWith('.json')) } catch { return [] }

    const sessions = new Map<string, {
      model: string; sessionTime: string
      tokIn: number; tokOut: number; tokReasoning: number
      tokCacheRead: number; tokCacheWrite: number; turns: number
    }>()

    for (const name of names) {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(fs.readFileSync(path.join(msgDir, name), 'utf-8')) as Record<string, unknown> } catch { continue }
      if (msg['role'] !== 'assistant') continue
      const sessionId = String(msg['session_id'] ?? '')
      if (!sessionId) continue
      const tokens = msg['tokens'] as Record<string, unknown> | undefined
      const cache  = tokens?.['cache'] as Record<string, unknown> | undefined
      const modelId = String(msg['id'] ?? '')
      let s = sessions.get(sessionId)
      if (!s) {
        s = { model: modelId, sessionTime: '', tokIn: 0, tokOut: 0, tokReasoning: 0, tokCacheRead: 0, tokCacheWrite: 0, turns: 0 }
        sessions.set(sessionId, s)
      }
      if (modelId && !s.model) s.model = modelId
      s.tokIn        += Number(tokens?.['input']     ?? 0)
      s.tokOut       += Number(tokens?.['output']    ?? 0)
      s.tokReasoning += Number(tokens?.['reasoning'] ?? 0)
      s.tokCacheRead += Number(cache?.['read']  ?? 0)
      s.tokCacheWrite+= Number(cache?.['write'] ?? 0)
      s.turns++
    }

    const results: LogSessionResult[] = []
    for (const [sessionId, s] of sessions) {
      const totalOutput = s.tokOut + s.tokReasoning
      const card = _buildCard(
        sessionId, 'opencode', s.model || 'opencode',
        s.sessionTime, s.sessionTime,
        {
          totalInput: s.tokIn, totalOutput, totalCacheRead: s.tokCacheRead,
          totalCacheCreate: s.tokCacheWrite, peakContextPerTurn: 0,
          turns: s.turns, totalToolCalls: 0, toolCounts: {},
          filesRead: new Set(), filesChanged: new Set(),
          filesWritten: new Set(), filesSearched: new Set(),
          userRequest: '', timeline: [], initiator: 'user',
        },
        '',
      )
      results.push({ card, workspace: '' })
    }
    return results
  }

  // ── Shared helpers ────────────────────────────────────────────────────────────

  private _collectJsonlFiles(dir: string): string[] {
    const results: string[] = []
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) results.push(...this._collectJsonlFiles(full))
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(full)
      }
    } catch { /* directory gone or no permission */ }
    return results
  }

  /** Reads and parses a JSON file, updating file state. Returns null if unchanged or on error. */
  private _readJsonFile(filePath: string): Record<string, unknown> | null {
    try {
      const stat = fs.statSync(filePath)
      const prev = this.fileState.get(filePath)
      if (prev && stat.mtimeMs === prev.mtimeMs && stat.size === prev.bytesRead) return null
      if (stat.size > LogReader.MAX_JSON_BYTES) {
        // A single JSON object cannot be parsed incrementally without a streaming JSON
        // parser; these snapshot files are small in practice. Skip oversized ones with
        // one log line (and record state so the next poll doesn't re-log) instead of
        // throwing on readFileSync / JSON.parse.
        this.fileState.set(filePath, { bytesRead: stat.size, mtimeMs: stat.mtimeMs })
        this.log(`[LogReader] skipping oversized JSON snapshot ${filePath} (${(stat.size / 1048576) | 0}MB)`)
        return null
      }
      const content = fs.readFileSync(filePath, 'utf-8')
      this.fileState.set(filePath, { bytesRead: stat.size, mtimeMs: stat.mtimeMs })
      return JSON.parse(content) as Record<string, unknown>
    } catch (err) {
      this.log(`[LogReader] read error ${filePath}: ${err}`)
      return null
    }
  }

  /**
   * Streams COMPLETE (newline-terminated) lines from `filePath` starting at byte
   * `fromOffset`, invoking `onLine` for each. Reads in bounded `streamChunkBytes`
   * chunks via fs.readSync so a multi-GB file never materialises as one string
   * (V8 caps a single string at ~512 MiB) and heap stays flat regardless of file size.
   *
   * A trailing PARTIAL line (no terminating '\n' — e.g. a file mid-append) is NOT
   * delivered; the returned offset points just past the last complete line so the
   * caller resumes there next time. Splitting is on the raw 0x0A byte and each line's
   * bytes are concatenated before utf-8 decoding, so a multi-byte character straddling
   * a chunk boundary is preserved (0x0A never appears inside a multi-byte sequence).
   * Returns the byte offset just past the last complete line consumed.
   */
  private _streamLinesFrom(filePath: string, fromOffset: number, onLine: (line: string) => void): number {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.allocUnsafe(this.streamChunkBytes)
      let readPos = fromOffset
      let consumed = fromOffset            // byte offset just past the last '\n' delivered
      let pending: Buffer[] = []           // bytes of the current incomplete line (may span chunks)
      for (;;) {
        const bytes = fs.readSync(fd, buf, 0, buf.length, readPos)
        if (bytes <= 0) break
        const chunkStart = readPos         // file offset of buf[0]
        readPos += bytes
        let lineStart = 0
        for (let i = 0; i < bytes; i++) {
          if (buf[i] !== 0x0A) continue    // not '\n'
          const tail = buf.subarray(lineStart, i)
          let line: string
          if (pending.length === 0) {
            line = tail.toString('utf8')
          } else {
            pending.push(Buffer.from(tail))            // copy: buf is reused on the next read
            line = Buffer.concat(pending).toString('utf8')
            pending = []
          }
          onLine(line)
          consumed = chunkStart + i + 1    // exact file offset just past this '\n'
          lineStart = i + 1
        }
        if (lineStart < bytes) pending.push(Buffer.from(buf.subarray(lineStart, bytes)))  // copy
      }
      return consumed
    } finally {
      fs.closeSync(fd)
    }
  }

  /**
   * Reads a whole JSONL file's non-blank lines via the streaming reader (so it never
   * builds one >512 MiB string). Returns null if unchanged since the last scan, or if
   * the file exceeds MAX_ARRAY_READ_BYTES — a defensive cap for the small Copilot logs
   * that use this path. The large Claude/Codex logs use `_incrementalParse`, which
   * holds no full line array and so handles multi-GB files in flat memory.
   */
  private _readNewLines(filePath: string): string[] | null {
    let stat: fs.Stats
    try { stat = fs.statSync(filePath) } catch (err) { this.log(`[LogReader] read error ${filePath}: ${err}`); return null }
    const prev = this.fileState.get(filePath)
    if (prev && stat.mtimeMs === prev.mtimeMs && stat.size === prev.bytesRead) return null
    if (stat.size > LogReader.MAX_ARRAY_READ_BYTES) {
      // Record state so the next poll skips it (rather than re-stat-and-log every 30s).
      this.fileState.set(filePath, { bytesRead: stat.size, mtimeMs: stat.mtimeMs })
      this.log(`[LogReader] skipping oversized non-incremental log ${filePath} (${(stat.size / 1048576) | 0}MB)`)
      return null
    }
    const lines: string[] = []
    try {
      this._streamLinesFrom(filePath, 0, line => { if (line.trim()) lines.push(line) })
    } catch (err) { this.log(`[LogReader] read error ${filePath}: ${err}`); return null }
    this.fileState.set(filePath, { bytesRead: stat.size, mtimeMs: stat.mtimeMs })
    return lines
  }

  /** LRU insert into accumCache; evicts the oldest entry when over ACCUM_CACHE_MAX. */
  private _lruPut(filePath: string, accum: unknown): void {
    this.accumCache.delete(filePath)
    this.accumCache.set(filePath, accum)
    while (this.accumCache.size > LogReader.ACCUM_CACHE_MAX) {
      const oldest = this.accumCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.accumCache.delete(oldest)
    }
  }

  /**
   * INCREMENTAL streaming parse for large JSONL logs (Claude, Codex). Streams only
   * the bytes appended since the last scan into a PERSISTED accumulator, so a growing
   * multi-GB session is never re-read from the start and heap stays flat. Returns the
   * (updated) accumulator, or null if the file is unchanged.
   *
   * Resumes from the prior byte offset only when the accumulator is still cached AND
   * the file did not shrink; otherwise it rebuilds from offset 0 with a fresh
   * accumulator. This correctly handles rotation/truncation and an evicted
   * accumulator — it never emits a partial card (the bug that previously forced a
   * full re-read every scan).
   */
  private _incrementalParse<T>(
    filePath: string,
    factory: () => T,
    onEntry: (accum: T, entry: Record<string, unknown>) => void,
  ): T | null {
    let stat: fs.Stats
    try { stat = fs.statSync(filePath) } catch (err) { this.log(`[LogReader] read error ${filePath}: ${err}`); return null }
    const prev = this.fileState.get(filePath)
    if (prev && stat.mtimeMs === prev.mtimeMs && stat.size === prev.bytesRead) return null

    const prevOffset = prev?.bytesRead ?? 0
    const cached = this.accumCache.get(filePath) as T | undefined
    const canResume = cached !== undefined && prevOffset > 0 && stat.size >= prevOffset
    const accum = canResume ? cached : factory()

    let newOffset = canResume ? prevOffset : 0
    try {
      newOffset = this._streamLinesFrom(filePath, canResume ? prevOffset : 0, line => {
        if (!line.trim()) return
        let entry: Record<string, unknown>
        try { entry = JSON.parse(line) as Record<string, unknown> } catch { return }
        onEntry(accum, entry)
      })
    } catch (err) { this.log(`[LogReader] read error ${filePath}: ${err}`); return null }

    this.fileState.set(filePath, { bytesRead: newOffset, mtimeMs: stat.mtimeMs })
    this._lruPut(filePath, accum)
    return accum
  }

  /** Checks if a file has changed since last scan; if so, delegates to parseFn. */
  private _processFile(
    filePath: string,
    parseFn: () => LogSessionResult | null,
  ): LogSessionResult | null {
    try {
      const stat = fs.statSync(filePath)
      const prev = this.fileState.get(filePath)
      if (prev && stat.mtimeMs === prev.mtimeMs && stat.size === prev.bytesRead) return null
      // parseFn reads its own bytes via _readNewLines; state update happens there.
      return parseFn()
    } catch {
      return null
    }
  }
}

// ── Shared card builder ───────────────────────────────────────────────────────

interface CardAccum {
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreate: number
  peakContextPerTurn: number
  turns: number
  totalToolCalls: number
  toolCounts: Record<string, number>
  filesRead: Set<string>
  filesChanged: Set<string>
  filesWritten: Set<string>
  filesSearched: Set<string>
  fileOps?: Map<string, FileOpAccum>
  userRequest: string
  timeline: TimelineEntry[]
  initiator: 'user' | 'agent' | 'api'
}

// Per-path byte/operation accumulator for file tool I/O (Claude logs). Converted to the
// card's FileOpSummary[] in _buildCard. Read bytes come from the matching tool_result
// content; write/edit bytes from the tool_use input. Kept as a Map so incremental scans
// accumulate in place. Optional on CardAccum — only the Claude path populates it.
interface FileOpAccum {
  readBytes: number; writeBytes: number; editBytes: number
  readCount: number; writeCount: number; editCount: number
}

// ── Incremental parse accumulators (Claude / Codex large-JSONL streaming) ──────
// Each holds the running per-session state ACROSS scans so _incrementalParse can
// process only newly-appended bytes. The per-entry updaters are faithful to the
// original single-pass parsers — they accumulate into these objects instead of
// local variables, which is exactly what makes incremental re-parsing correct
// (the previous code re-read the whole file every scan to avoid partial cards).

function _emptyCardAccum(initiator: 'user' | 'agent' | 'api' = 'user'): CardAccum {
  return {
    totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheCreate: 0,
    peakContextPerTurn: 0, turns: 0, totalToolCalls: 0, toolCounts: {},
    filesRead: new Set<string>(), filesChanged: new Set<string>(),
    filesWritten: new Set<string>(), filesSearched: new Set<string>(),
    fileOps: new Map<string, FileOpAccum>(),
    userRequest: '', timeline: [], initiator,
  }
}

interface ClaudeAccum {
  workspace: string
  model: string
  firstTimestamp: string
  lastTimestamp: string
  hasFastMode: boolean
  idx: number               // monotonic timeline index; persists across scans → stable spanIds
  // In-flight Read tool_use id → its file path. A Read's byte volume lives in the matching
  // tool_result (which only carries the tool_use_id), which often arrives in a LATER entry —
  // or even a later scan — so this map persists in the accumulator to bridge that gap.
  pendingReads: Map<string, string>
  // Anthropic message.ids whose `usage` has already been counted. Claude Code splits one
  // assistant message across multiple JSONL rows (one per content block) and repeats the full
  // `usage` in each — so usage must be counted ONCE per message.id, not per row. Persists across
  // scans (incremental parsing) so a message split across a scan boundary is still deduped.
  seenMessageIds: Set<string>
  card: CardAccum
}

function _newClaudeAccum(): ClaudeAccum {
  return { workspace: '', model: '', firstTimestamp: '', lastTimestamp: '', hasFastMode: false, idx: 0, pendingReads: new Map<string, string>(), seenMessageIds: new Set<string>(), card: _emptyCardAccum('user') }
}

// UTF-8 byte length of a value that may or may not be a string (0 for non-strings).
function _utf8Bytes(v: unknown): number {
  return typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : 0
}

// Bytes an Edit-family tool produced: Edit / replace_string_in_file → new_string; MultiEdit →
// sum of edits[].new_string; else fall back to content. Approximates the change volume.
function _editInputBytes(inp: Record<string, unknown>): number {
  if (Array.isArray(inp['edits'])) {
    return (inp['edits'] as Array<Record<string, unknown>>)
      .reduce((n, e) => n + _utf8Bytes(e['new_string'] ?? e['newString']), 0)
  }
  return _utf8Bytes(inp['new_string'] ?? inp['newString'] ?? inp['content'])
}

// Bytes a Read returned: tool_result content is either a string or an array of {text} blocks.
function _toolResultBytes(content: unknown): number {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8')
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .reduce((n, b) => n + (typeof b['text'] === 'string' ? Buffer.byteLength(b['text'] as string, 'utf8') : 0), 0)
  }
  return 0
}

// Accumulate one file operation's byte volume into the per-path map (lazily created).
function _addFileOp(card: CardAccum, filePath: string, op: 'read' | 'write' | 'edit', bytes: number): void {
  const ops = card.fileOps ?? (card.fileOps = new Map<string, FileOpAccum>())
  let fo = ops.get(filePath)
  if (!fo) { fo = { readBytes: 0, writeBytes: 0, editBytes: 0, readCount: 0, writeCount: 0, editCount: 0 }; ops.set(filePath, fo) }
  if (op === 'read')       { fo.readBytes  += bytes; fo.readCount++  }
  else if (op === 'write') { fo.writeBytes += bytes; fo.writeCount++ }
  else                     { fo.editBytes  += bytes; fo.editCount++  }
}

function _claudeOnEntry(a: ClaudeAccum, entry: Record<string, unknown>): void {
  const ts = entry['timestamp'] as string | undefined
  if (ts) { if (!a.firstTimestamp) a.firstTimestamp = ts; a.lastTimestamp = ts }
  if (entry['cwd'] && !a.workspace) a.workspace = entry['cwd'] as string

  if (entry['type'] === 'user') {
    // isSidechain: true → session was spawned by the Agent tool, not typed by a human.
    // <local-command-caveat> prefix → session started via `claude -p` (non-interactive API).
    if (!a.card.userRequest) {
      if (entry['isSidechain'] === true) a.card.initiator = 'agent'
    }
    const content = (entry['message'] as Record<string, unknown>)?.['content']
    const text = _extractTextContent(content)
    if (!a.card.userRequest && text) {
      if (a.card.initiator === 'user' && text.startsWith('<local-command-caveat>')) {
        a.card.initiator = 'api'
        const afterCaveat = text.replace(/^<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/i, '').trim()
        a.card.userRequest = afterCaveat || '[api session]'
      } else {
        a.card.userRequest = text
      }
    }
    // Resolve Read tool_results → per-file read bytes (tool_use.id ↔ tool_result.tool_use_id).
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] !== 'tool_result') continue
        const id = block['tool_use_id'] as string | undefined
        if (!id) continue
        const fp = a.pendingReads.get(id)
        if (!fp) continue
        a.pendingReads.delete(id)
        _addFileOp(a.card, fp, 'read', _toolResultBytes(block['content']))
      }
    }
    a.card.timeline.push({ type: 'user_input', spanId: `log-u-${a.idx}`, label: 'User', durationMs: 0, isError: false, timestamp: ts ?? '', responseText: text })
    a.idx++
  }

  if (entry['type'] === 'assistant') {
    const msg = entry['message'] as Record<string, unknown> | undefined
    // Claude writes model:"<synthetic>" on injected/auto rows (tool-result
    // continuations, interrupts, isApiErrorMessage entries). Letting that
    // placeholder overwrite a.model makes the card's headline model read
    // "<synthetic>" whenever the last assistant row happens to be synthetic —
    // so ignore it and keep the real model the session actually ran on.
    const rowModel = msg?.['model'] as string | undefined
    if (rowModel && rowModel !== '<synthetic>') a.model = rowModel
    // Claude Code writes ONE assistant message as MULTIPLE JSONL rows — one per content block
    // (thinking / text / each tool_use) — and repeats the FULL `usage` in every row. Counting
    // usage per row over-counts tokens (and `turns`) 2–5×, worst for tool-heavy orchestrator /
    // sub-agent / workflow / fork sessions that emit many tool_use blocks per message. So count
    // `usage` exactly ONCE per Anthropic message.id. The content blocks below stay per-row (each
    // row carries a DISTINCT block), so tool counts / file-ops remain correct. (Verified on a real
    // 1018-row session that held only 407 real messages → 2.4–4.5× over-count before this fix.)
    const messageId = msg?.['id'] as string | undefined
    const isFirstRowOfMessage = !messageId || !a.seenMessageIds.has(messageId)
    if (messageId) a.seenMessageIds.add(messageId)
    const rawUsage = msg?.['usage'] as Record<string, unknown> | undefined
    if (rawUsage?.['speed'] === 'fast') a.hasFastMode = true
    const usage = rawUsage as Record<string, number> | undefined
    if (usage && isFirstRowOfMessage) {
      const inp = usage['input_tokens']                ?? 0
      const cr  = usage['cache_read_input_tokens']     ?? 0
      const cc  = usage['cache_creation_input_tokens'] ?? 0
      a.card.totalInput       += inp
      a.card.totalOutput      += usage['output_tokens'] ?? 0
      a.card.totalCacheRead   += cr
      a.card.totalCacheCreate += cc
      const turnContext = inp + cr + cc
      if (turnContext > a.card.peakContextPerTurn) a.card.peakContextPerTurn = turnContext
      a.card.turns++
    }
    const content = (msg?.['content'] as Array<Record<string, unknown>>) ?? []
    let hasToolCall = false
    for (const block of content) {
      if (block['type'] === 'tool_use' && block['name']) {
        hasToolCall = true; a.card.totalToolCalls++
        const name = block['name'] as string
        a.card.toolCounts[name] = (a.card.toolCounts[name] ?? 0) + 1
        const inp = (block['input'] ?? {}) as Record<string, unknown>
        const fp  = String(inp['file_path'] ?? inp['filePath'] ?? inp['path'] ?? '')
        if (fp) {
          if (name === 'Read' || name === 'read_file') {
            a.card.filesRead.add(fp)
            // A Read's byte volume is in the matching tool_result; record the tool_use id
            // now and resolve it to read-bytes when that result arrives (see the user branch).
            const id = block['id'] as string | undefined
            if (id) a.pendingReads.set(id, fp)
          } else if (['Edit', 'MultiEdit', 'replace_string_in_file', 'NotebookEdit'].includes(name)) {
            a.card.filesChanged.add(fp)
            _addFileOp(a.card, fp, 'edit', _editInputBytes(inp))
          } else if (name === 'Write' || name === 'create_file') {
            a.card.filesChanged.add(fp); a.card.filesWritten.add(fp)
            _addFileOp(a.card, fp, 'write', _utf8Bytes(inp['content']))
          }
        }
      }
    }
    const responseText = (content.find(b => b['type'] === 'text') as Record<string, string> | undefined)?.['text']
    a.card.timeline.push({ type: hasToolCall ? 'tool' : 'llm', spanId: `log-a-${a.idx}`, label: hasToolCall ? 'Tool calls' : 'Response', model: a.model || undefined, inputTokens: isFirstRowOfMessage ? usage?.['input_tokens'] : undefined, outputTokens: isFirstRowOfMessage ? usage?.['output_tokens'] : undefined, durationMs: 0, isError: false, timestamp: ts ?? '', responseText })
    a.idx++
  }
}

interface CodexAccum {
  workspace: string
  model: string
  firstTimestamp: string
  lastTimestamp: string
  userRequest: string
  turns: number
  // Final cumulative total_token_usage (we keep the LAST one: the per-turn sums drift
  // from the authoritative total, and input_tokens includes cached_input_tokens which
  // the parser subtracts back out for correct billing).
  lastTotalUsage?: Record<string, number>
}

function _newCodexAccum(): CodexAccum {
  return { workspace: '', model: '', firstTimestamp: '', lastTimestamp: '', userRequest: '', turns: 0 }
}

function _codexOnEntry(a: CodexAccum, entry: Record<string, unknown>): void {
  const ts = entry['timestamp'] as string | undefined
  if (ts) {
    if (!a.firstTimestamp) a.firstTimestamp = ts
    if (entry['type'] === 'event_msg') a.lastTimestamp = ts
  }
  // session_meta carries the actual project working directory
  if (entry['type'] === 'session_meta' && !a.workspace) {
    const payload = entry['payload'] as Record<string, unknown> | undefined
    if (payload?.['cwd']) a.workspace = String(payload['cwd'])
  }
  // turn_context carries the model name
  if (entry['type'] === 'turn_context') {
    const payload = entry['payload'] as Record<string, unknown> | undefined
    if (payload?.['model']) a.model = String(payload['model'])
  }
  if (entry['type'] === 'event_msg') {
    const payload = entry['payload'] as Record<string, unknown> | undefined
    if (payload?.['type'] === 'user_message' && !a.userRequest) {
      const msg = String(payload['message'] ?? '').trim()
      if (msg) a.userRequest = _extractCodexUserText(msg)
    }
    if (payload?.['type'] === 'token_count') {
      const info = payload['info'] as Record<string, unknown> | undefined
      if (info?.['model']) a.model = String(info['model'])
      const total = info?.['total_token_usage'] as Record<string, number> | undefined
      const last  = info?.['last_token_usage']  as Record<string, number> | undefined
      if (total) a.lastTotalUsage = total
      if (last) a.turns++
    }
  }
}

function _buildCard(
  sessionId: string,
  source: 'claude_code' | 'codex' | 'copilot' | 'opencode',
  model: string,
  firstTimestamp: string,
  lastTimestamp: string,
  acc: CardAccum,
  workspace = '',
): SessionSummaryCard {
  const startMs  = _parseTs(firstTimestamp)
  const endMs    = _parseTs(lastTimestamp)
  const durationMs = (endMs > 0 && startMs > 0) ? Math.max(0, endMs - startMs) : 0
  // Use total context (raw + cache read + cache create) as the denominator so the
  // rate stays 0–1. Using raw input_tokens alone produces rates >> 1 in multi-turn
  // sessions where the cached context dwarfs the new tokens added each turn.
  const totalContext = acc.totalInput + acc.totalCacheRead + acc.totalCacheCreate
  const cacheHitRate = totalContext > 0 ? acc.totalCacheRead / totalContext : 0

  return {
    sessionId,
    traceId: sessionId,
    source,
    dataSource: 'log',
    initiator: acc.initiator,
    workspace,
    userRequest: acc.userRequest.slice(0, 500),
    model,
    turns: acc.turns,
    // inputTokens is the RAW uncached input only (NEW tokens billed at the input rate).
    // It used to be totalContext (raw + cacheRead + cacheCreate summed per turn), which
    // inflated the headline to millions because cacheRead re-reads the whole transcript
    // every turn. cacheRead/cacheCreate are carried in their own fields below; cost reads
    // all four buckets separately (writer.ts), so billing is unchanged.
    inputTokens: acc.totalInput,
    outputTokens: acc.totalOutput,
    cacheReadTokens: acc.totalCacheRead,
    cacheCreateTokens: acc.totalCacheCreate,
    cacheHitRate,
    durationMs,
    startTime: startMs > 0 ? new Date(startMs).toISOString() : '',
    filesRead:     Array.from(acc.filesRead),
    filesSearched: Array.from(acc.filesSearched),
    filesChanged:  Array.from(acc.filesChanged),
    filesWritten:  Array.from(acc.filesWritten),
    fileOps: acc.fileOps && acc.fileOps.size > 0
      ? Array.from(acc.fileOps.entries()).map(([path, f]) => ({ path, ...f }))
      : undefined,
    toolCounts: acc.toolCounts,
    totalToolCalls: acc.totalToolCalls,
    totalLlmCalls: acc.turns,
    errors: 0,
    outcome: acc.totalToolCalls > 0 ? 'tool_calls' : 'text_response',
    timeline: acc.timeline,
    backgroundSpans: [],
    loopSignals: [],
    peakContextPerTurn: acc.turns > 1 ? acc.peakContextPerTurn : undefined,
  }
}

// ── Text content helpers ──────────────────────────────────────────────────────

/**
 * Extracts the real user text from Copilot's `transformedContent` field, which
 * can be prefixed with injected XML-like blocks:
 *   <current_datetime>...</current_datetime>
 *   <system_reminder>...</system_reminder>
 * Returns the first non-empty line that isn't inside such a block.
 */
function _extractCopilotUserText(raw: string): string {
  // Split into lines, skip lines that are entirely part of injected XML blocks.
  const lines = raw.split('\n')
  let inTag = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Opening XML-like injection tag — enter skip mode
    if (/^<[a-z_]+[^>]*>/.test(trimmed) && !trimmed.startsWith('</')) {
      // If the tag closes on the same line, skip just this line
      if (/<\/[a-z_]+>$/.test(trimmed)) continue
      inTag = true
      continue
    }
    // Closing tag — exit skip mode
    if (/^<\/[a-z_]+>/.test(trimmed)) { inTag = false; continue }
    if (inTag) continue
    return trimmed
  }
  return ''
}

/**
 * Strips IDE-injected context from a Codex user_message event.
 * When invoked from within VS Code, Codex prepends context in the form:
 *   "# Context from my IDE setup:\n\n## Active file: ...\n\n## My request for Codex:\n<actual prompt>"
 * The actual user text always follows "## My request for Codex:".
 * For plain messages (no preamble), the raw text is returned as-is.
 */
function _extractCodexUserText(raw: string): string {
  const marker = '## My request for Codex:\n'
  const idx = raw.indexOf(marker)
  if (idx !== -1) return raw.slice(idx + marker.length).trim()
  return raw
}

function _extractVSCodeCopilotUserText(raw: string): string {
  // renderedUserMessage is prefixed with injected XML blocks (<attachments>, <context>, …).
  // The actual user-typed text follows after the last closing tag.
  // Greedy match up through the last </tag> then take what remains.
  const stripped = raw.replace(/^[\s\S]*<\/[^>]+>\s*/, '').trim()
  if (stripped && stripped !== raw.trim()) return stripped.split('\n')[0]?.trim() ?? ''
  // stripped is empty → entire message was XML with no trailing user text (e.g. attachment-only).
  if (!stripped) return ''
  return raw.trim().split('\n')[0]?.trim() ?? ''
}

function _extractTextContent(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) {
        return (block['text'] as string).trim()
      }
    }
  }
  return ''
}

/**
 * Merges outstanding WAL frames into the database buffer so sql.js can read
 * sessions written since the last checkpoint. SQLite WAL format (spec §2):
 *   - 32-byte header: magic, version, page size, seq, salt1, salt2, cksum1, cksum2
 *   - Frames: 24-byte frame header + pageSize bytes of page data
 *     Frame header: pgno (4), dbSize (4), salt1 (4), salt2 (4), cksum1 (4), cksum2 (4)
 * Frames whose salts don't match the WAL header belong to a stale WAL — stop there.
 */
function _mergeWal(dbBuf: Uint8Array, walBuf: Uint8Array): Uint8Array {
  const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (walBuf.length < 32) return dbBuf
  const wDv = dv(walBuf)
  const magic = wDv.getUint32(0)
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return dbBuf
  const pageSize = wDv.getUint32(8)
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) return dbBuf
  const salt1 = wDv.getUint32(16)
  const salt2 = wDv.getUint32(20)

  const FRAME = 24 + pageSize
  let result = new Uint8Array(dbBuf)
  let off = 32

  while (off + FRAME <= walBuf.length) {
    const pgno   = wDv.getUint32(off)
    const fSalt1 = wDv.getUint32(off + 8)
    const fSalt2 = wDv.getUint32(off + 12)
    if (fSalt1 !== salt1 || fSalt2 !== salt2) break  // stale generation
    if (pgno >= 1) {
      const pageOff = (pgno - 1) * pageSize
      const pageEnd = pageOff + pageSize
      if (pageEnd > result.length) {
        const ext = new Uint8Array(pageEnd)
        ext.set(result)
        result = ext
      }
      result.set(walBuf.slice(off + 24, off + 24 + pageSize), pageOff)
    }
    off += FRAME
  }

  return result
}

function _parseTs(ts: string): number {
  if (!ts) return 0
  // ISO string
  const ms = Date.parse(ts)
  if (!isNaN(ms)) return ms
  // Unix nanoseconds (very large numbers)
  const n = parseInt(ts)
  if (!isNaN(n) && n > 1e15) return Math.floor(n / 1e6)  // ns → ms
  return 0
}
