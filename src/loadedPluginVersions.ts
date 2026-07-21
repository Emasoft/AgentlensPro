import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { claudeProjectsDirs } from './logReader'
import { transcriptFiles, scanCacheRiskCommands } from './cacheRiskCommands'

// Which plugin VERSION is each Claude Code session actually running? (AgentlensPro#5)
//
// The problem this answers: a plugin update lands machine-wide, but hooks and skills are
// SESSION-LOADED — a running session keeps executing the OLD cached code until its own
// `/reload-plugins` lands. A fleet-wide fix rollout therefore has invisible "old-behavior ghosts",
// and a ghost is indistinguishable from "the fix doesn't work" (ai-maestro-janitor TRDD-P7WU40G9:
// a session on 0.52.0 hooks kept using the old compact threshold for ~20 minutes after 0.53.0
// shipped the fix).
//
// THE SOURCE — `attachment` records, not prose. When Claude Code loads a skill it writes a record
// of shape:
//   {type:"attachment", attachment:{type:"invoked_skills", skills:[{path:"plugin:<p>:<s>",
//    content:"Base directory for this skill: …/plugins/cache/<marketplace>/<plugin>/<VERSION>/…"}]},
//    timestamp, sessionId, cwd, version, gitBranch}
// That header is emitted by the HARNESS at load time, so unlike a versioned path appearing in
// assistant prose or a Bash argument it cannot be authored, quoted, or guessed by the model. On a
// 40-file sample the versioned path also appears 465 times inside `tool_use:Bash` inputs and 111
// times in assistant text — all of which are the model TOUCHING a path (often reading an OLD
// cached version deliberately), never proof of what is loaded. We read only the attachment.

/** Semver-ish compare; falls back to a string compare for non-numeric tails. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.'), pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i] ?? '0', 10), nb = parseInt(pb[i] ?? '0', 10)
    if (Number.isNaN(na) || Number.isNaN(nb)) return (pa[i] ?? '').localeCompare(pb[i] ?? '')
    if (na !== nb) return na - nb
  }
  return 0
}

/** One session's relationship to one plugin. */
export interface LoadedPluginVersion {
  session: string
  /** The session's working directory, i.e. which project the ghost is in. */
  project?: string
  marketplace: string
  plugin: string
  /** Best estimate of the version this session is running — see the note on `loadedVersion`. */
  loadedVersion: string
  /** Every version this session was ever observed loading, oldest first. */
  versionsSeen: string[]
  /**
   * How many distinct versions were observed. Redundant with `versionsSeen.length` on the raw
   * payload and deliberately so: the CLI's lean shaping truncates long arrays, which made a lean
   * row read as self-contradictory (`loadedVersion` absent from its own `versionsSeen`). The count
   * is what lets a reader see the list was clipped instead of doubting the verdict.
   */
  versionsSeenCount: number
  /** Skill loads observed for this plugin in this session. */
  observations: number
  /** Newest version present in the plugin cache right now. */
  newestCached?: string
  /**
   * `true` = running behind the cache · `false` = current · `'unknown'` = a reload happened after
   * our last evidence, so the real version is at least `loadedVersion` but we cannot see it.
   */
  stale: boolean | 'unknown'
  /** Epoch ms of the newest attachment that evidenced `loadedVersion`. */
  lastObservationTs: number
  /** Epoch ms of the last /reload-plugins or /reload-skills in this session, when any. */
  lastReloadTs?: number
  /** Transcript mtime — the liveness proxy (we cannot see a pid; see the report note). */
  lastActivityTs: number
  /** Claude Code's own version, as stamped on the record. */
  ccVersion?: string
}

export interface LoadedVersionsReport {
  rows: LoadedPluginVersion[]
  /** Transcripts examined after the window/plugin filters. */
  sessionsScanned: number
  /** Of those, how many carried at least one skill-load attachment — the rest are UNKNOWN, not current. */
  sessionsWithSkillEvidence: number
  stale: number
  unknown: number
  /** Newest cached version per `<marketplace>/<plugin>`. */
  newestCached: Record<string, string>
  activeMinutes: number | null
  /** Why there is no pid column, stated rather than silently omitted. */
  note: string
}

const RE_BASEDIR = /Base directory for this skill:\s*\S*?\/plugins\/cache\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\//

interface Observation { ts: number; version: string }

/** Newest cached version per `<marketplace>/<plugin>`, straight off the plugin cache dir. */
export function scanPluginCache(cacheRoot?: string): Record<string, string> {
  const root = cacheRoot ?? path.join(os.homedir(), '.claude', 'plugins', 'cache')
  const out: Record<string, string> = {}
  let markets: string[]
  try { markets = fs.readdirSync(root) } catch { return out }
  for (const market of markets) {
    let plugins: string[]
    try { plugins = fs.readdirSync(path.join(root, market)) } catch { continue }
    for (const plugin of plugins) {
      let versions: string[]
      try { versions = fs.readdirSync(path.join(root, market, plugin)) } catch { continue }
      // A version dir is a directory whose name starts with a digit — the cache also holds
      // scratch files (tsconfig.test.json, walkthrough/) that would otherwise sort as "newest".
      const real = versions.filter(v => /^\d/.test(v))
      if (!real.length) continue
      out[`${market}/${plugin}`] = real.sort(compareVersions)[real.length - 1]
    }
  }
  return out
}

export interface LoadedVersionsOptions {
  /** Only report this plugin (bare name, e.g. `ai-maestro-janitor`). */
  plugin?: string
  /** Only sessions whose transcript was touched within the last N minutes. */
  activeMinutes?: number
  /** Only report sessions that are behind the cache. */
  staleOnly?: boolean
  dirs?: ReadonlyArray<string>
  cacheRoot?: string
  /** Injectable clock so tests are not wall-clock dependent. */
  nowMs?: number
}

/**
 * Report the plugin version each session has LOADED.
 *
 * `loadedVersion` is the MAXIMUM version observed in the session, deliberately NOT the
 * latest-by-timestamp one. A compaction REPLAYS earlier skill invocations as fresh attachment
 * records carrying their ORIGINAL content, so record order stops being chronological: measured on
 * 40 real transcripts, 18 of 19 multi-version sessions are non-monotone in time and the
 * latest-timestamp record is routinely an OLD version (one session whose history reaches 0.57.0
 * reports 0.41.0 last). Max is sound because a session's loaded version only ever moves forward —
 * the cache only gains versions and a reload takes the newest — so a replay can echo an old
 * version but can never invent a newer one than was really loaded.
 *
 * It can still UNDER-estimate: if the session reloaded and then invoked no skill from that plugin,
 * the newer load left no trace. That case is reported as `stale: 'unknown'` rather than as a false
 * "stale" — the consumer contract (AgentlensPro#2) is fail-open, and a wrong staleness verdict is
 * worse than an honest gap.
 */
export function buildLoadedVersionsReport(opts: LoadedVersionsOptions = {}): LoadedVersionsReport {
  const dirs = opts.dirs ?? claudeProjectsDirs()
  const newestCached = scanPluginCache(opts.cacheRoot)
  const now = opts.nowMs ?? Date.now()
  const activeCutoff = opts.activeMinutes !== undefined ? now - opts.activeMinutes * 60_000 : undefined

  // Reload commands are scanned ONCE for every session up front and indexed by session id. Doing
  // it per transcript inside the loop below would re-walk the whole projects tree for each of the
  // ~300 files — quadratic, and the reason this lookup is a Map and not a call site.
  const lastReloadBySession = new Map<string, number>()
  for (const c of scanCacheRiskCommands({
    dirs,
    kinds: ['PLUGINS_RELOADED', 'SKILLS_RELOADED'],
    sinceMs: activeCutoff,
  })) {
    if (!c.session) continue
    const prev = lastReloadBySession.get(c.session)
    if (prev === undefined || c.ts > prev) lastReloadBySession.set(c.session, c.ts)
  }

  const rows: LoadedPluginVersion[] = []
  let scanned = 0, withEvidence = 0

  for (const file of transcriptFiles(dirs)) {
    let mtime: number
    try { mtime = fs.statSync(file).mtimeMs } catch { continue }
    if (activeCutoff !== undefined && mtime < activeCutoff) continue
    let text: string
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    scanned++
    if (!text.includes('invoked_skills')) continue

    // key: `<marketplace>/<plugin>` → observations
    const perPlugin = new Map<string, Observation[]>()
    let session = '', project: string | undefined, ccVersion: string | undefined
    for (const line of text.split('\n')) {
      if (!line.includes('invoked_skills')) continue
      let rec: {
        type?: unknown
        timestamp?: unknown
        sessionId?: unknown
        cwd?: unknown
        version?: unknown
        attachment?: { type?: unknown; skills?: unknown }
      }
      try { rec = JSON.parse(line) } catch { continue }
      if (rec.type !== 'attachment' || rec.attachment?.type !== 'invoked_skills') continue
      const skills = rec.attachment.skills
      if (!Array.isArray(skills)) continue
      const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN
      if (!Number.isFinite(ts)) continue
      if (typeof rec.sessionId === 'string') session = rec.sessionId
      if (typeof rec.cwd === 'string') project = rec.cwd
      if (typeof rec.version === 'string') ccVersion = rec.version
      for (const s of skills as Array<{ content?: unknown }>) {
        if (typeof s?.content !== 'string') continue
        const m = RE_BASEDIR.exec(s.content)
        if (!m) continue
        const key = `${m[1]}/${m[2]}`
        if (opts.plugin && m[2] !== opts.plugin) continue
        const list = perPlugin.get(key)
        if (list) list.push({ ts, version: m[3] })
        else perPlugin.set(key, [{ ts, version: m[3] }])
      }
    }
    if (!perPlugin.size) continue
    withEvidence++
    if (!session) session = path.basename(file, '.jsonl')

    const lastReloadTs = lastReloadBySession.get(session)

    for (const [key, obs] of perPlugin) {
      const versions = [...new Set(obs.map(o => o.version))].sort(compareVersions)
      const loaded = versions[versions.length - 1]
      // The newest moment we have evidence of the version we are reporting.
      const lastObservationTs = Math.max(...obs.filter(o => o.version === loaded).map(o => o.ts))
      const newest = newestCached[key]
      const behind = newest !== undefined && compareVersions(loaded, newest) < 0
      // A reload after our last evidence means the session may already have moved on unseen.
      const blind = lastReloadTs !== undefined && lastReloadTs > lastObservationTs
      const stale: boolean | 'unknown' = behind ? (blind ? 'unknown' : true) : false
      if (opts.staleOnly && stale === false) continue
      const [marketplace, plugin] = key.split('/')
      const row: LoadedPluginVersion = {
        session,
        marketplace,
        plugin,
        loadedVersion: loaded,
        versionsSeen: versions,
        versionsSeenCount: versions.length,
        observations: obs.length,
        stale,
        lastObservationTs,
        lastActivityTs: mtime,
      }
      if (project) row.project = project
      if (newest !== undefined) row.newestCached = newest
      if (lastReloadTs !== undefined) row.lastReloadTs = lastReloadTs
      if (ccVersion) row.ccVersion = ccVersion
      rows.push(row)
    }
  }

  // Ghosts first, then most-recently-active, then session id. The severity key is what makes the
  // list actionable AND survives the CLI's lean truncation (the rows that matter are the ones kept).
  // The session tie-break is not cosmetic: on a busy machine many live transcripts share an mtime
  // to the millisecond, so an mtime-only sort reorders itself between two runs seconds apart.
  const severity = (s: boolean | 'unknown'): number => (s === true ? 0 : s === 'unknown' ? 1 : 2)
  rows.sort((a, b) =>
    severity(a.stale) - severity(b.stale) ||
    b.lastActivityTs - a.lastActivityTs ||
    a.session.localeCompare(b.session))
  return {
    rows,
    sessionsScanned: scanned,
    sessionsWithSkillEvidence: withEvidence,
    stale: rows.filter(r => r.stale === true).length,
    unknown: rows.filter(r => r.stale === 'unknown').length,
    newestCached: opts.plugin
      ? Object.fromEntries(Object.entries(newestCached).filter(([k]) => k.endsWith(`/${opts.plugin}`)))
      : newestCached,
    activeMinutes: opts.activeMinutes ?? null,
    note:
      'No pid column: a session id cannot be mapped to an OS process from the transcript substrate, ' +
      'so lastActivityTs (transcript mtime) is the liveness proxy — use activeMinutes to scope it. ' +
      'sessionsScanned minus sessionsWithSkillEvidence is the blind spot: a session that invoked no ' +
      'plugin skill has no loaded-version evidence and is absent from rows, NOT current.',
  }
}
