// src/cli/setup.ts — `agentlenspro setup` (TRDD-7284WCW7): the idempotent install / repair
// verb. detect → converge → VERIFY-per-step → final end-to-end self-test.
//
// The discipline every step obeys (CHECK → ACT → VERIFY → RECORD):
//   CHECK  reads the real state and decides whether anything is needed (read-only).
//   ACT    converges — only when CHECK said so, and never in --dry-run.
//   VERIFY re-reads the real state through a DIFFERENT path than ACT wrote it
//          (falsify-the-layer: after safeConfigEdit we re-parse the file ourselves; after a
//          server start we curl the ports; after a skill install we hash-compare; after a
//          hook install we EXECUTE the registered command). An actor's exit code is never
//          trusted as proof.
//   RECORD one table row per step: found → action → verify (PASS/FAIL/SKIP).
// Any VERIFY failure → fail-fast: remaining steps do not run, exit non-zero. No fallbacks.
//
// Repair mode is not a separate mode: CHECK is written against the full breakage matrix
// (missing/wrong/truncated env vars, duplicated or stale hook registrations of every past
// generation, skill content drift, corrupt forensics.db, old-generation bins), so a broken
// install simply produces more ACTs. Data is NEVER wiped: a corrupt DB is backed up aside
// as .corrupt-<ts>; span-store preservation is itself a VERIFY assertion (post ≥ pre).

import { spawn, spawnSync, execFileSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import { agentlensDisabled, noRevivePath, reviveBraked, STARTED_BY_ENV } from './killSwitch'
import { EXIT, UsageError } from './cliErrors'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { loadSqlJs } from '../forensicsDb'
import { countNdjsonLinesAuto } from '../ndjsonLines'
import { readFsMarkers } from '../environment/runtime'
import {
  TelemetryConflict, TelemetryVerdictRow, ensureTelemetryConfig, forceInstallManagedTelemetry, formatTelemetryConflicts,
  formatTelemetryVerdict, ownedTelemetryKeys, sameTelemetryValue, shown as shownValue, telemetryVerdict, verdictConflicts as detectConflictsFromRows,
} from '../telemetryConfig'
import { disableForForeignTelemetry, enableIfForeign } from './foreignTelemetry'
import { effectiveBodiesDir, RAW_BODIES_KEY } from '../captureConfig'
import { alstoreBin as resolveAlstoreBin, rustIngestPass } from '../rustStorePass'
import { safeConfigEdit } from '../safeConfigEdit'
import { DEFAULT_MAX_BYTES_PER_PASS, IngestPassResult } from '../store/ingestPass'
import { envPort, sleep } from './cliCore'
import { dataDirFrom } from '../dataDir'
import {
  CLI_BIN, GATE_CMD, GATE_EVENTS, GATE_MATCHER, HOOK_CMD, HOOK_EVENTS, HookMatcher,
  INSTALLED_EVENTS, REVIEW_CMD, REVIEW_EVENTS, SUPERVISOR_CMD, SUPERVISOR_EVENTS, isStaleGeneration,
  installHooks, installSkill, isOurHookCommand, rebuildEventMatchers, resolveOnPath,
  HOOK_TIMEOUT_SEC, sha256File, SKILL_NAMES, findPackageRoot, skillFiles, skillTreeHash, installAgents, AGENT_NAMES,
} from './hookInstall'
import { alcoreBin, alcoreServeArgs, ALCORE_MIMALLOC_PURGE_DELAY_MS, resolveBinNativeDir, statsOwnership } from './serverControl'

import { chooseServerPorts, liveLockPid, readChosenPort, writePortsFile } from './portSelect'
export interface SetupOptions {
  dryRun?: boolean
  yes?: boolean
  /** `--force-install-telemetry`: overwrite a foreign telemetry config with agentlenspro's (per invocation). */
  forceInstall?: boolean
  /** `--json`: build the full JSON document into SetupOutcome.json and print no table/detection text. */
  json?: boolean
  /** Where the foreign-telemetry guard looks besides ~/.claude/settings.json (managed-settings files, process env).
   *  Production leaves it unset (real OS paths + process.env); tests pin it so a developer's company config or
   *  OTEL_* shell exports cannot leak into a fixture run. */
  telemetryProbe?: { managedSettingsPaths?: string[]; processEnv?: NodeJS.ProcessEnv }
  /** Injectable roots/ports — tests point ALL of them at temp fixtures + ephemeral ports.
   *  Defaults are the real machine paths/env (the production behavior). */
  home?: string
  dataDir?: string
  settingsPath?: string
  skillsDir?: string
  agentsDir?: string
  repoRoot?: string
  uiPort?: number
  mcpPort?: number
  otlpPort?: number
  pathEnv?: string
  log?: (line: string) => void
}

export type Verify = 'PASS' | 'FAIL' | 'SKIP'
export interface StepResult {
  step: string
  found: string
  action: string
  verify: Verify
  detail?: string
}

export interface SetupOutcome {
  exitCode: number
  steps: StepResult[]
  /** Number of steps whose ACT actually mutated something — the idempotency metric:
   *  a second run over a converged install MUST report 0. */
  actions: number
  serverPid: number | null
  /** `--json`: the full untruncated document (steps + per-key telemetry verdict + hook drift). */
  json?: unknown
}

export interface Ctx {
  dryRun: boolean
  yes: boolean
  forceInstall: boolean
  telemetryProbe: { managedSettingsPaths?: string[]; processEnv?: NodeJS.ProcessEnv }
  home: string
  dataDir: string
  settingsPath: string
  skillsDir: string
  agentsDir: string
  repoRoot: string
  uiPort: number
  mcpPort: number
  otlpPort: number
  pathEnv: string
  log: (line: string) => void
  serverPid: number | null
}

export function resolveCtx(opts: SetupOptions): Ctx {
  const home = opts.home ?? os.homedir()
  const repoRoot = opts.repoRoot ?? findPackageRoot(__dirname)
  if (!repoRoot) throw new Error(`cannot locate the agentlenspro package root above ${__dirname}`)
  // The shared resolver (src/dataDir.ts), against THIS home: AGENTLENS_DATA_DIR, then DATA_DIR, then
  // <home>/.agentlens. WHY (TRDD-TYOQA14F): this read only DATA_DIR and ignored AGENTLENS_DATA_DIR, the canonical
  // variable every other verb honours first, so `agentlenspro setup` and the launch self-heal converged and started
  // a server in ~/.agentlens while server stop/status, the hooks and findServerPid used the user's own dir.
  const dataDir = opts.dataDir ?? dataDirFrom({ ...process.env, HOME: home })
  // Same resolution as the server start (serverControl.alcoreServeArgs): env first, then the
  // ports the running server recorded in ports.json (honoured only while its pidfile is live),
  // then the canonical default — so detection, probes and the self-test dial where the clients do.
  const port = (raw: string | undefined, key: 'otlp' | 'ui' | 'mcp', fallback: number): number =>
    Number(envPort(raw, readChosenPort(dataDir, key) ?? fallback))
  return {
    dryRun: !!opts.dryRun,
    yes: !!opts.yes,
    forceInstall: !!opts.forceInstall,
    telemetryProbe: opts.telemetryProbe ?? {},
    home,
    dataDir,
    settingsPath: opts.settingsPath ?? process.env.AGENTLENS_CLAUDE_SETTINGS ?? path.join(home, '.claude', 'settings.json'),
    skillsDir: opts.skillsDir ?? path.join(home, '.claude', 'skills'),
    agentsDir: opts.agentsDir ?? path.join(home, '.claude', 'agents'),
    repoRoot,
    // TRDD-99HUNXJS: `Number(process.env.UI_PORT ?? 3000)` made `UI_PORT=''` bind port 0 (`Number('')`);
    // `envPort` is the one validated parser shared with the spawn path.
    uiPort: opts.uiPort ?? port(process.env.UI_PORT, 'ui', 3000),
    mcpPort: opts.mcpPort ?? port(process.env.MCP_PORT, 'mcp', 4316),
    otlpPort: opts.otlpPort ?? port(process.env.OTLP_PORT, 'otlp', 4318),
    pathEnv: opts.pathEnv ?? process.env.PATH ?? '',
    log: opts.log ?? ((line: string) => console.log(line)),
    serverPid: null,
  }
}

// ── Local transport bound to the ctx ports (cliCore reads env — setup must not) ────────────

/** Overall budgets for setup's own HTTP calls (TRDD-V2HFI30L). The socket timeout each call also sets is an IDLE
 *  timeout — every byte resets it — so a server that trickled one byte every few seconds held setup forever. The
 *  overall deadline bounds the whole exchange. 10 s is twice the idle timeout, so a slow but healthy server under
 *  load still answers in time; the MCP budget keeps the same margin over its 10 s idle timeout. */
export const HTTP_TOTAL_DEADLINE_MS = 10_000
const MCP_TOTAL_DEADLINE_MS = 15_000

export function httpJson(port: number, method: string, p: string, payload?: unknown): Promise<{ status: number; json: unknown }> {
  const body = payload === undefined ? null : JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      finish()
    }
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, res => {
      let raw = ''
      res.on('data', (c: Buffer) => { raw += c })
      res.on('error', e => settle(() => reject(e)))
      res.on('end', () => settle(() => {
        let json: unknown = null
        try { json = JSON.parse(raw) } catch { /* non-JSON body (e.g. the dashboard HTML) */ }
        resolve({ status: res.statusCode ?? 0, json })
      }))
    })
    req.on('error', e => settle(() => reject(e)))
    const deadline = setTimeout(() => settle(() => { req.destroy(); reject(new Error('timeout')) }), HTTP_TOTAL_DEADLINE_MS)
    req.setTimeout(5000, () => req.destroy(new Error('timeout')))
    if (body) req.write(body)
    req.end()
  })
}

async function mcpCall(port: number, method: string, params: unknown): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      finish()
    }
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = ''
      res.on('data', (c: Buffer) => { raw += c })
      res.on('error', e => settle(() => reject(e)))
      res.on('end', () => settle(() => {
        const line = raw.split('\n').find(l => l.startsWith('data:'))
        const payload = line ? line.slice(5).trim() : raw
        try {
          const j = JSON.parse(payload) as { error?: { message?: string }; result?: unknown }
          if (j.error) return reject(new Error(j.error.message || 'rpc error'))
          resolve(j.result)
        } catch { reject(new Error(`bad MCP response (${res.statusCode}): ${raw.slice(0, 200)}`)) }
      }))
    })
    // TRDD-V2HFI30L: the overall bound, see HTTP_TOTAL_DEADLINE_MS.
    const deadline = setTimeout(() => settle(() => { req.destroy(); reject(new Error('timeout')) }), MCP_TOTAL_DEADLINE_MS)
    req.on('error', e => settle(() => reject(e)))
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')))
    req.write(body)
    req.end()
  })
}

/** A /api/server-stats answer. `dataDir` and `ports` are optional because the answer comes from whatever
 *  listens on the UI port: a build from before data-dir reporting (82d3776) or a foreign HTTP service may omit
 *  them (TRDD-V2HFI30L). */
export interface StatsShape {
  pid: number
  dataDir?: string
  ports?: { ui: number; mcp: number; otlp: number }
  spans?: { store?: { totalSpans: number }; inMemory?: number }
  hookEvents?: { receivedSinceBoot: number }
}

async function serverStats(ctx: Ctx): Promise<StatsShape | null> {
  try {
    const r = await httpJson(ctx.uiPort, 'GET', '/api/server-stats')
    if (r.status === 200 && r.json && typeof r.json === 'object') return r.json as StatsShape
    return null
  } catch { return null }
}

/** A directory as the filesystem sees it: symlinks resolved (realpath), or path.resolve for a path that does
 *  not exist yet. */
function canonicalDir(p: string): string {
  try { return fs.realpathSync.native(p) } catch { return path.resolve(p) }
}

/** Is the server that answered /api/server-stats OURS, the one that owns ctx.dataDir? (TRDD-V2HFI30L)
 *  Checked in findServerPid's order: (a) pidfile identity — `<ctx.dataDir>/server.pid` names a live owner
 *  (liveLockPid checks the start reference, so a recycled pid is not it) and that owner is the pid the server
 *  reports; else (b) the data dir it reports is ctx.dataDir with symlinks resolved on both sides (statsOwnership).
 *  A server that reports no data dir (statsOwnership's 'unknown': a build from before data-dir reporting, 82d3776,
 *  or a foreign HTTP service) is therefore FOREIGN unless (a) matched.
 *  WHY: the old test was "any 200 JSON on the UI port", so an isolated setup (a test, a second instance) on the
 *  default ports adopted the developer's live collector as its own, then SIGTERMed it for its data dir. */
export function statsAreOurs(ctx: Ctx, stats: StatsShape): boolean {
  const owner = liveLockPid(ctx.dataDir)
  if (owner !== null && owner === stats.pid) return true
  const reported = typeof stats.dataDir === 'string' ? canonicalDir(stats.dataDir) : undefined
  return statsOwnership(reported, canonicalDir(ctx.dataDir)) === 'ours'
}

/** Whether `port`, one of the three listeners, is held by OUR server. Per port (TRDD-V2HFI30L): the stats come
 *  from the UI port, so a server that is ours there makes a port ours only when it reports that port as its own;
 *  otherwise a stranger on 4318 passed the OTLP refusal because our server answered on 3000. */
async function portHeldByOurs(ctx: Ctx, kind: 'otlp' | 'ui' | 'mcp', port: number): Promise<boolean> {
  const stats = await serverStats(ctx)
  return stats !== null && statsAreOurs(ctx, stats) && stats.ports?.[kind] === port
}

/** The server signature the pidfile check has always required (PR-15 review): `alcore` (TRDD-1B98LCVR box 4),
 *  plus a legacy TS-server pidfile. NOT `agentlenspro` (TRDD-V2HFI30L, review of 973aead7): a CLI process is never
 *  a server, and hooks spawn `agentlenspro …` constantly, so with a legacy bare-numeric lock (no start reference)
 *  a recycled pid now running a CLI process matched that arm, and setup would have SIGTERMed it. */
const SERVER_CMD_RE = /standalone[/\\]server\.js|[/\\]alcore(?:\s|$)/

/** The command line of `pid`, read from ONE `ps` snapshot (never a live grep), or null when no such process
 *  runs or ps failed. */
function processCommand(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf-8', timeout: 5_000 })
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (m !== null && Number(m[1]) === pid) return m[2]
    }
  } catch { /* ps failed: nothing about the pid is provable */ }
  return null
}

/** The `--data-dir` value of an `alcore serve` command line, or null. */
function alcoreServeDataDir(cmd: string): string | null {
  const m = /(?:^|[/\\])alcore\s+serve\s(?:.*\s)?--data-dir\s+(.+?)(?=\s+--[a-z]|$)/.exec(cmd)
  return m === null ? null : m[1]
}

/** `pid` when it is provably OUR server's process, else null: the ONLY pids setup may signal (TRDD-V2HFI30L).
 *  Provable means (a) `<ctx.dataDir>/server.pid` names it as a live owner AND its command line is a server's
 *  (the PR-15 guard stays: a legacy bare-numeric lock has no start reference, so liveness alone could be a
 *  recycled pid), or (b) a ps snapshot shows it running `alcore serve --data-dir <ctx.dataDir>`.
 *  A pid that a stats answer reports about itself is never enough: whatever answers the UI port can name any
 *  pid, and the old code sent SIGTERM to exactly that number. */
export function ownServerPid(ctx: Ctx, pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const cmd = processCommand(pid)
  if (cmd === null) return null
  if (liveLockPid(ctx.dataDir) === pid && SERVER_CMD_RE.test(cmd)) return pid
  const dir = alcoreServeDataDir(cmd)
  return dir !== null && canonicalDir(dir) === canonicalDir(ctx.dataDir) ? pid : null
}

/** The refusal for a UI port answered by a server that is not ours: who it is, and how the user stops it. */
function foreignServerDetail(ctx: Ctx, stats: StatsShape): string {
  const dir = typeof stats.dataDir === 'string' ? stats.dataDir : null
  // `server stop` resolves its target from AGENTLENS_DATA_DIR first (dataDir.ts resolveDataDirFrom), so naming
  // that variable reaches the other instance even when DATA_DIR is also set.
  const remedy = dir !== null
    ? `stop it with \`AGENTLENS_DATA_DIR='${dir}' agentlenspro server stop\`, or pin UI_PORT, MCP_PORT and OTLP_PORT to free ports`
    : 'stop it, or pin UI_PORT, MCP_PORT and OTLP_PORT to free ports'
  return `the server on UI port ${ctx.uiPort} (pid ${stats.pid}, data dir ${dir ?? 'not reported'}) does not own ${ctx.dataDir}; setup never stops another instance: ${remedy}`
}

// ── The result table (heavy header rule, light body — same family as heartbeat-cost) ───────

function renderTable(rows: StepResult[]): string {
  const cols: Array<{ h: string; get: (r: StepResult) => string }> = [
    { h: 'step', get: r => r.step },
    { h: 'found', get: r => r.found },
    { h: 'action', get: r => r.action },
    { h: 'verify', get: r => r.verify },
    { h: 'detail', get: r => r.detail ?? '' },
  ]
  const clip = (s: string, w: number): string => (s.length > w ? s.slice(0, w - 1) + '…' : s)
  const CAP = 46
  const widths = cols.map(c => Math.min(CAP, Math.max(c.h.length, ...rows.map(r => c.get(r).length))))
  const line = (l: string, mid: string, r: string, fill: string): string =>
    l + widths.map(w => fill.repeat(w + 2)).join(mid) + r
  const row = (cells: string[], sep: string): string =>
    sep + cells.map((c, i) => ` ${clip(c, widths[i]).padEnd(widths[i])} `).join(sep) + sep
  const out: string[] = []
  out.push(line('┏', '┳', '┓', '━'))
  out.push('┃' + cols.map((c, i) => ` ${c.h.padEnd(widths[i])} `).join('┃') + '┃')
  out.push(line('┡', '╇', '┩', '━'))   // heavy header rule, light body below
  for (const r of rows) out.push(row(cols.map(c => c.get(r)), '│'))
  out.push(line('└', '┴', '┘', '─'))
  return out.join('\n')
}

// ── Settings helpers (the independent re-read path — NEVER via safeConfigEdit) ─────────────

type Settings = Record<string, unknown>

export function readSettingsFresh(file: string): Settings | 'absent' | 'unparseable' {
  if (!fs.existsSync(file)) return 'absent'
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Settings } catch { return 'unparseable' }
}

function settingsHooks(s: Settings): Record<string, HookMatcher[]> {
  return (s.hooks && typeof s.hooks === 'object' ? s.hooks : {}) as Record<string, HookMatcher[]>
}

/** Would installHooks change anything? Mirrors the installer's change detection without writing. */
export function hooksConverged(s: Settings): boolean {
  const hooks = settingsHooks(s)
  const events = new Set([...Object.keys(hooks), ...INSTALLED_EVENTS])
  for (const ev of events) {
    const matchers = Array.isArray(hooks[ev]) ? hooks[ev] : []
    const r = rebuildEventMatchers(matchers, ev, false, HOOK_CMD, GATE_CMD, REVIEW_CMD)
    if (JSON.stringify(r.rebuilt) !== JSON.stringify(matchers)) return false
  }
  const env = s.env as Record<string, unknown> | undefined
  if (env && env.SPYGLASS_DIR !== undefined) return false
  return true
}

/** Independent post-install assertion: exactly one v2 entry per event, zero stale entries. */
/** Independent post-install assertion: exactly one v2 entry per event, zero stale entries, every
 *  agentlenspro entry at HOOK_TIMEOUT_SEC (a command match alone would pass a leftover 30s registration). */
function verifyHooksState(s: Settings): string | null {
  const hooks = settingsHooks(s)
  for (const ev of HOOK_EVENTS) {
    const cmds = (hooks[ev] ?? []).flatMap(m => (m.hooks ?? []).map(h => h.command))
    const ours = cmds.filter(c => c === HOOK_CMD)
    if (ours.length !== 1) return `${ev}: expected exactly one '${HOOK_CMD}' entry, found ${ours.length}`
  }
  for (const ev of GATE_EVENTS) {
    const gates = (hooks[ev] ?? []).filter(m => m.matcher === GATE_MATCHER)
      .flatMap(m => (m.hooks ?? []).map(h => h.command)).filter(c => c === GATE_CMD)
    if (gates.length !== 1) return `${ev}: expected exactly one '${GATE_CMD}' gate entry, found ${gates.length}`
  }
  for (const ev of REVIEW_EVENTS) {
    const reviews = (hooks[ev] ?? []).flatMap(m => (m.hooks ?? []).map(h => h.command)).filter(c => c === REVIEW_CMD)
    if (reviews.length !== 1) return `${ev}: expected exactly one '${REVIEW_CMD}' entry, found ${reviews.length}`
  }
  // The supervisor was registered by the installer but never VERIFIED here, so a converge that
  // silently dropped it still reported "registrations current". The supervisor exists to notice a
  // gate that has stopped firing; an unverified supervisor is a watchdog nobody watches.
  for (const ev of SUPERVISOR_EVENTS) {
    const sups = (hooks[ev] ?? []).flatMap(m => (m.hooks ?? []).map(h => h.command)).filter(c => c === SUPERVISOR_CMD)
    if (sups.length !== 1) return `${ev}: expected exactly one '${SUPERVISOR_CMD}' entry, found ${sups.length}`
  }
  for (const [ev, matchers] of Object.entries(hooks)) {
    for (const m of matchers ?? []) {
      for (const h of m.hooks ?? []) {
        if (isStaleGeneration(h.command)) {
          return `${ev}: stale previous-generation registration survived: ${h.command}`
        }
        if (isOurHookCommand(h.command) && h.timeout !== HOOK_TIMEOUT_SEC) {
          return `${ev}: '${h.command}' timeout ${h.timeout}s, expected ${HOOK_TIMEOUT_SEC}s`
        }
      }
    }
  }
  return null
}

/** Execute a registered hook command string with a synthetic stdin payload — the strongest
 *  possible verify: the EXACT string the hook runner will exec, resolved through the same
 *  PATH. Returns null on contract compliance (exit 0), else the violation. */
export function execRegisteredCommand(ctx: Ctx, command: string, payload: string, expectSilent: boolean): string | null {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: ctx.pathEnv,
    // TRDD-X4YTS5BF: the exec'd hook resolves its data dir from the ENVIRONMENT, and this env
    // inherited the caller's HOME — so a setup run against an isolated ctx (every setup test)
    // had its hooks read and write the REAL machine's ~/.agentlens: its server.pid, its
    // daemon-revive lock, its hook-spool. Pin both so the verify exercises the install it is
    // verifying. In production ctx.home/ctx.dataDir ARE the real ones, so nothing changes there.
    HOME: ctx.home,
    AGENTLENS_DATA_DIR: ctx.dataDir,
    AGENTLENS_UI_URL: `http://127.0.0.1:${ctx.uiPort}`,
    // TRDD-4EV3OJ19: a failed hook POST revives alcore via alcoreServeArgs(), which reads these
    // three from the hook process's own env. Unpinned, the revive binds the DEFAULT ports instead
    // of the ones this setup converged to (same pins as setup's own server spawn).
    UI_PORT: String(ctx.uiPort),
    MCP_PORT: String(ctx.mcpPort),
    OTLP_PORT: String(ctx.otlpPort),
    AGENTLENS_HOOK_TIMEOUT: '4', // doubled 2026-09-05 with every other hook budget (TRDD-GXKRBK1Q)
    AGENTLENS_GATE_TIMEOUT: '4',
  }
  delete env.AGENTLENS_GATE // an ambient kill-switch would make the gate exec vacuous
  // 15 s bounds /bin/sh + PATH shim + node startup; the child's own budgets are the 4 s above.
  // The ETIMEDOUTs seen under the full mocha suite (TRDD-X4YTS5BF) came through the HOME leak
  // fixed above: a failed hook POST revives the daemon, which ran an unbounded `ps` against the
  // real machine's pidfile — now bounded in processStartRef. Do not raise this to paper over a
  // hang; bound the hang.
  const r = spawnSync('/bin/sh', ['-c', command], { input: payload, env, encoding: 'utf8', timeout: 15_000 })
  if (r.error) return `spawn failed: ${r.error.message}`
  if (r.status !== 0) return `exit ${r.status} (must always exit 0): ${(r.stderr || '').slice(0, 120)}`
  if (expectSilent && r.stdout !== '') return `must print nothing, got: ${r.stdout.slice(0, 120)}`
  return null
}

// ── Legacy RAM-disk spool migration (TRDD-Z53IJFE9 step C) ──────────────────────────────────
// A published install upgraded from a spool-generation release can still carry three dead
// artifacts: a mounted /Volumes/AgentLensSpool RAM disk, OTEL_LOG_RAW_API_BODIES pointing at it,
// and the dead com.agentlens.spool LaunchAgent. The spool code is GONE (step D), so nothing
// drains that volume and capture silently dies when it fills — the exact 2026-08-06 outage.
// This migration runs BEFORE the telemetry step, in the card's exact order:
//   drain (alstore pass — no data lost) → detach the disk → rewrite the settings path via
//   safeConfigEdit → bootout the agent + move its plist aside.
// NEVER detach before draining: the pass must read every body off the volume while it is live.
// Residual surfaces deliberately IGNORED, not errored on (card review condition 2): the removed
// `summary.bodies.spool` summary key and the removed `AGENTLENS_BODIES_MAX_AGE_HOURS` env var.

/** The settings env value the old spool wrote, and the volume it mounted. Kept as literals:
 *  the spool module that owned them is deleted. */
const SPOOL_BODIES_VALUE = 'file:/Volumes/AgentLensSpool/otel-bodies'
const SPOOL_VOLUME = '/Volumes/AgentLensSpool'
const SPOOL_AGENT_LABEL = 'com.agentlens.spool'

/** Injectable seams — tests stub these; production defaults do the real work. Every seam the
 *  step's decisions flow through is here, so the tests drive the REAL decision flow (a test
 *  that re-implements the flow would pin nothing — review round 1 on this step). */
export interface SpoolMigrationDeps {
  /** A directory scannable AND drainable, i.e. the volume is mounted. */
  volumeMounted: (volume: string) => boolean
  /** Detach the RAM disk. Called ONLY after a proven-complete drain. */
  detachVolume: (volume: string) => void
  /** One throttled `alstore pass` over the spool bodies into the store. `--no-delete` is NEVER
   *  passed: the drain's whole point is to empty the volume before it is detached.
   *  `relocateStrandedTo` moves stranded bodies (bytes proven, ts row wrong — the pass keeps
   *  them on disk and skips them forever) onto the SSD dir so they survive the detach. */
  drain: (storeDir: string, bodiesDir: string, relocateStrandedTo?: string) => Promise<IngestPassResult | null>
  /** Resolve the alstore binary, or null when unavailable (a broken install — loud FAIL, the
   *  fail-fast direction: migration NEVER detaches with bodies undrained). */
  alstoreBin: () => string | null
  /** `launchctl bootout gui/<uid>/<label>` — stop the dead agent if launchd still holds it. */
  bootoutAgent: (label: string) => void
  /** The LaunchAgent plist's absolute path. */
  plistPath: () => string
  /** Names in the spool's bodies dir RIGHT NOW — the airtight no-residue gate: whatever the
   *  drain report says, the volume must not detach while any file remains. */
  listSpoolBodies: () => string[]
}

function realSpoolDeps(): SpoolMigrationDeps {
  return {
    volumeMounted: (volume) => {
      try { return fs.statSync(path.join(volume, 'otel-bodies')).isDirectory() } catch { return false }
    },
    detachVolume: (volume) => {
      // hdiutil is the only sanctioned detach for a disk image we mounted ourselves. A failure
      // THROWS — the step machinery reports it and the run stops; a forced detach could destroy
      // unsaved spool bytes, so there is no -force fallback (fail-fast, no data-loss path).
      execFileSync('hdiutil', ['detach', volume], { stdio: 'pipe', timeout: 60_000 })
    },
    drain: async (storeDir, bodiesDir, relocateStrandedTo) => {
      const bin = resolveAlstoreBin()
      if (!bin) return null
      // 0 max-age-ms = ingest regardless of age: this is a ONE-SHOT migration, not the 60s
      // steady-state drain — anything left behind here is lost the moment the volume detaches.
      return rustIngestPass(bin, {
        storeDir, bodiesDir, maxAgeMs: 0, maxBytesPerPass: DEFAULT_MAX_BYTES_PER_PASS,
        durableSource: true, relocateStrandedTo,
      })
    },
    alstoreBin: () => resolveAlstoreBin(),
    bootoutAgent: (label) => {
      // POSIX-only call: win32 is refused by the environment step (fail-fast) before this one
      // ever runs, so getuid always exists on a machine that reaches here.
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0
      // DELIBERATE fail-soft (review round 2, F5): the agent is DEAD either way — its baked node
      // path is gone and it exits 78 on every launch — so there is nothing real to stop, and a
      // launchctl failure here must not block the plist move, which is the actual teardown.
      try { execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'pipe', timeout: 15_000 }) } catch { /* dead agent: bootout failure is not a migration blocker */ }
    },
    plistPath: () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${SPOOL_AGENT_LABEL}.plist`),
    listSpoolBodies: () => fs.readdirSync(path.join(SPOOL_VOLUME, 'otel-bodies')),
  }
}

/** Detect the legacy spool state on THIS machine (read-only). Each artifact is reported
 *  independently: a machine can carry any subset after a partial manual migration. */
export function detectLegacySpool(settingsPath: string): {
  settingsPathPointsAtSpool: boolean
  volumeMounted: boolean
  plistPresent: boolean
  plistPath: string
} {
  return detectLegacySpoolWith(realSpoolDeps(), settingsPath)
}

/** The deps-parameterized half of detection — the seam the tests drive. Same read-only parse. */
function detectLegacySpoolWith(deps: SpoolMigrationDeps, settingsPath: string): {
  settingsPathPointsAtSpool: boolean
  volumeMounted: boolean
  plistPresent: boolean
  plistPath: string
} {
  let settingsPathPointsAtSpool = false
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { env?: Record<string, unknown> }
    settingsPathPointsAtSpool = settings.env?.[RAW_BODIES_KEY] === SPOOL_BODIES_VALUE
  } catch { /* absent/unparseable: the telemetry step owns that refusal — nothing spool-specific here */ }
  return {
    settingsPathPointsAtSpool,
    volumeMounted: deps.volumeMounted(SPOOL_VOLUME),
    plistPresent: fs.existsSync(deps.plistPath()),
    plistPath: deps.plistPath(),
  }
}

/** The migration body, deps-parameterized so tests drive the REAL flow — never a re-implementation:
 *  a test that re-implements the order pins nothing (review round 1). `stepSpoolMigration` below is
 *  the thin production wrapper calling this with the real seams. Detection uses deps too, so the
 *  volume/plist halves are testable without a real /Volumes mount or a real plist.
 *
 *  The NEVER-DETACH-BEFORE-DRAINING gate is AIRTIGHT, not report-trusting (review round 1, HIGH):
 *  after a "successful" drain the spool bodies dir is re-listed through a DIFFERENT path (readdir),
 *  and ANY residue file refuses the detach. strandedTs bodies (bytes proven, ts row wrong — the
 *  pass keeps them on disk and skips them forever) are also RELOCATED to the SSD bodies dir by the
 *  drain itself (--relocate-to), so a proven-byte-identical body never dies with the volume.
 *  The drain also LOOPS (review round 2, F1): a single pass leaves a window where a live writer
 *  lands a body after the last readdir, so passes repeat until one full pass ingests nothing —
 *  a starved writer — before the detach. */
export async function runSpoolMigration(ctx: Ctx, deps: SpoolMigrationDeps): Promise<{ result: StepResult; acted: boolean }> {
  const detected = detectLegacySpoolWith(deps, ctx.settingsPath)
  const artifacts = [
    detected.volumeMounted && 'RAM disk mounted',
    detected.settingsPathPointsAtSpool && 'settings path points at the spool',
    detected.plistPresent && 'LaunchAgent plist present',
  ].filter(Boolean).join(', ')
  if (!artifacts) {
    return { result: { step: 'spool-migration', found: 'no legacy spool artifacts', action: 'none', verify: 'PASS', detail: 'nothing to migrate' }, acted: false }
  }

  if (ctx.dryRun) {
    return {
      result: {
        step: 'spool-migration', found: artifacts,
        action: 'would: drain spool bodies (the legacy 72h/8GB limits do not apply by default — this one-shot drain ingests regardless of age) → detach RAM disk → rewrite settings path via safeConfigEdit → bootout + set aside the plist',
        verify: 'SKIP', detail: 'dry-run',
      },
      acted: false,
    }
  }

  // ACT 1 — DRAIN FIRST. Detaching a volume with bodies still on it loses them (the card's
  // NEVER-DETACH-BEFORE-DRAINING rule); so the drain runs whenever the volume is mounted,
  // regardless of whether settings still point at it — a mounted volume with bodies needs
  // draining even if the settings key was already rewritten by an earlier partial migration.
  //
  // The drain LOOPS (review round 2, F1): between the last readdir and the detach a live Claude
  // Code session (settings still pointing at the spool) can land a new body — a single pass
  // leaves that TOCTOU window open. Passes repeat until one full pass ingests NOTHING (a
  // pass-starved writer: the pass itself takes time, so no settle delay is needed between
  // iterations) AND the readdir gate reports zero files. The cap also bounds a huge backlog
  // (8 × DEFAULT_MAX_BYTES_PER_PASS ≈ 4 GB per setup run; a larger one refuses and re-runs).
  let drained = false
  if (detected.volumeMounted) {
    if (!deps.alstoreBin()) {
      return {
        result: {
          step: 'spool-migration', found: artifacts, action: 'refused', verify: 'FAIL',
          detail: 'alstore binary unavailable — cannot drain the spool safely; refusing to detach the RAM disk with bodies on it (install agentlenspro fully, then re-run setup)',
        },
        acted: false,
      }
    }
    // The pass deletes each body only after the store PROVES it reconstructs byte-for-byte
    // (durable_source fsyncs parts first) — that proof gate is the no-data-loss guarantee.
    // stranded bodies (kept on disk by the pass, excluded from every future pass) are
    // relocated to the SSD dir so they cannot be lost with the volume (review round 1).
    const DRAIN_LOOP_MAX = 8
    for (let pass = 1; ; pass++) {
      let res: IngestPassResult | null = null
      let drainErr: Error | null = null
      try {
        res = await deps.drain(path.join(ctx.dataDir, 'store'), path.join(SPOOL_VOLUME, 'otel-bodies'), path.join(ctx.dataDir, 'otel-bodies'))
      } catch (e) { drainErr = e as Error }
      if (drainErr || !res) {
        return {
          result: {
            step: 'spool-migration', found: artifacts, action: 'refused', verify: 'FAIL',
            detail: `drain failed${drainErr ? `: ${drainErr.message.slice(0, 120)}` : ' (another pass owns the store)'} — RAM disk left mounted; nothing detached, nothing rewritten. Fix and re-run setup.`,
          },
          acted: false,
        }
      }
      if (res.failed.length > 0 || res.throttled) {
        return {
          result: {
            step: 'spool-migration', found: artifacts, action: 'refused', verify: 'FAIL',
            detail: `drain incomplete: ${res.failed.length} failed, throttled=${res.throttled} — RAM disk left mounted; re-run setup until the drain completes`,
          },
          acted: false,
        }
      }
      // AIRTIGHT residue gate, now inside the loop: whatever the report says, the volume must
      // not detach while a pass could still find work. Success is ONE pass that ingested
      // NOTHING (a pass-starved writer — the pass itself takes time, so no settle delay is
      // needed between iterations) AND whose readdir comes back empty; readdir is a path
      // independent of the pass's own bookkeeping (falsify-the-layer).
      const residueNames = deps.listSpoolBodies()
      if (res.ingested === 0 && residueNames.length === 0) { drained = true; break }
      if (pass >= DRAIN_LOOP_MAX) {
        return {
          result: {
            step: 'spool-migration', found: artifacts, action: 'refused', verify: 'FAIL',
            detail: residueNames.length > 0
              ? `spool still holds ${residueNames.length} file(s) after ${DRAIN_LOOP_MAX} drain passes (${residueNames.slice(0, 3).join(', ')}${residueNames.length > 3 ? ', …' : ''}) — RAM disk left mounted; inspect and re-run setup`
              : `a live writer kept landing bodies through ${DRAIN_LOOP_MAX} drain passes (no starved pass) — RAM disk left mounted; stop the sessions still writing to the spool and re-run setup`,
          },
          acted: false,
        }
      }
    }
  }

  // ACT 2 — DETACH (only after a drain whose completion is proven by readdir, not just reported).
  if (detected.volumeMounted && drained) {
    deps.detachVolume(SPOOL_VOLUME)
  }

  // ACT 3 — REWRITE THE SETTINGS PATH via safeConfigEdit. Only the key's VALUE moves, to the one
  // bodies dir (raw capture is mandatory since 2026-10-02 — there is no off state to preserve).
  let settingsRewritten = false
  if (detected.settingsPathPointsAtSpool) {
    const ops = [{ op: 'set' as const, path: ['env', RAW_BODIES_KEY], value: `file:${effectiveBodiesDir(ctx.dataDir)}` }]
    await safeConfigEdit(ctx.settingsPath, 'json', ops, { createIfMissing: true })
    settingsRewritten = true
  }

  // ACT 4 — TEARDOWN THE DEAD LAUNCH AGENT. The plist lives OUTSIDE any project root, so the
  // safe-delete tool cannot take it (it refuses paths outside the tree) — it is moved ASIDE to
  // `disabled-<label>.plist.bak`, recoverable with one mv. The bootout runs first so launchd
  // stops holding a plist that is about to be renamed. An EXISTING .bak is never overwritten:
  // a re-created plist may differ (baked node path), so the newer copy gets a timestamped name
  // and both survive (review round 1, MEDIUM).
  let agentTornDown = false
  if (detected.plistPresent) {
    deps.bootoutAgent(SPOOL_AGENT_LABEL)
    const plist = detected.plistPath
    let aside = path.join(path.dirname(plist), `disabled-${SPOOL_AGENT_LABEL}.plist.bak`)
    if (fs.existsSync(aside)) {
      aside = path.join(path.dirname(plist), `disabled-${SPOOL_AGENT_LABEL}.plist.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`)
    }
    try { fs.renameSync(plist, aside) } catch (e) {
      return {
        result: {
          step: 'spool-migration', found: artifacts, action: 'refused', verify: 'FAIL',
          detail: `could not move the plist aside: ${(e as Error).message.slice(0, 100)} — bootout already ran; move ${plist} to ${aside} manually, then re-run setup`,
        },
        acted: true,
      }
    }
    agentTornDown = true
  }

  // VERIFY — re-detect through the SAME read-only path. Everything must be gone.
  const after = detectLegacySpoolWith(deps, ctx.settingsPath)
  const residue = [
    after.volumeMounted && 'RAM disk still mounted',
    after.settingsPathPointsAtSpool && 'settings still point at the spool',
    after.plistPresent && 'plist still present',
  ].filter(Boolean).join(', ')
  return {
    result: {
      step: 'spool-migration', found: artifacts,
      action: [
        drained && 'drained spool bodies into the store (stranded bodies relocated to the SSD dir)',
        detected.volumeMounted && drained && 'detached RAM disk',
        settingsRewritten && 'rewrote settings path via safeConfigEdit',
        agentTornDown && 'booted out the agent + moved its plist aside',
      ].filter(Boolean).join(', ') || 'none',
      verify: residue ? 'FAIL' : 'PASS',
      detail: residue
        ? `residue after migration: ${residue}`
        : `bodies now in the store; disabled plist kept at ${path.join(path.dirname(detected.plistPath), `disabled-${SPOOL_AGENT_LABEL}.plist.bak`)}`,
    },
    acted: drained || settingsRewritten || agentTornDown,
  }
}

/** The production step: the REAL seams, the shared decision body. */
const stepSpoolMigration: StepDef = {
  name: 'spool-migration',
  async run(ctx) {
    return runSpoolMigration(ctx, realSpoolDeps())
  },
}

// ── Steps ───────────────────────────────────────────────────────────────────────────────────

interface StepDef {
  name: string
  run: (ctx: Ctx) => Promise<{ result: StepResult; acted: boolean }>
}

// ── Environment probe (TRDD-KVDT1XMS) — read-only heuristics, ALWAYS the first step ─────────
// Facts are gathered from the real machine, then judged by a pure function (unit-testable
// fact-by-fact). FAIL blocks the whole pipeline (fail-fast); degradable problems only warn.

export interface EnvFacts {
  platform: NodeJS.Platform
  arch: string
  /** process.versions.node — no leading 'v'. */
  nodeVersion: string
  /** The supported floor, read from package.json engines.node (never hardcoded twice).
   *  Null when the manifest could not supply one — reported as a failed check, never guessed. */
  nodeFloor: string | null
  wsl: boolean
  /** @duckdb/node-api is a declared runtime dep (span store) — unresolvable = broken install. */
  duckdbResolvable: boolean
  /** sql.js is degradable: OpenCode ingestion falls back to per-message JSON files. */
  sqljsResolvable: boolean
  claudeDirPresent: boolean
  /** Something answers on the OTLP port but the UI port does not look like OUR server. */
  otlpPortBusyForeign: boolean
  freeDiskBytes: number | null
}

/** '>=20.9.0' | '20.9.0' → '20.9.0', or NULL when the manifest cannot supply one.
 *
 *  engines.node is the ONE home of the floor, so there is no compiled second copy to fall back to.
 *  The old code returned a hardcoded '20.9.0' on any failure, which made the "ONE home" claim
 *  false and was silent: after a floor bump, an unreadable package.json meant setup validated
 *  against the stale number and PASSED a Node version the package no longer supports.
 *
 *  It returns null rather than throwing because this runs during environment DETECTION, and a
 *  detection crash would bypass the step machinery that is supposed to report the problem — the
 *  caller turns null into a visible failed check instead. */
function parseNodeFloor(repoRoot: string): string | null {
  let pkg: { engines?: { node?: string } }
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { engines?: { node?: string } }
  } catch { return null }
  return (pkg.engines?.node ?? '').match(/(\d+)\.(\d+)\.(\d+)/)?.[0] ?? null
}

function versionAtLeast(version: string, floor: string): boolean {
  const v = version.split('.').map(Number)
  const f = floor.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) > (f[i] ?? 0)) return true
    if ((v[i] ?? 0) < (f[i] ?? 0)) return false
  }
  return true
}

async function gatherEnvFacts(ctx: Ctx): Promise<EnvFacts> {
  // Plain require.resolve — the deps that matter are the ones THIS process (the installed
  // package) would load, NOT whatever sits under the injectable repoRoot (that root is for
  // skill/package FILES; pointing dep resolution at it made a bogus-root fixture fail here
  // instead of at the skill step it targets).
  const resolvable = (mod: string): boolean => {
    try { require.resolve(mod); return true } catch { return false }
  }
  // Foreign-process heuristic: OTLP port answers ⇒ occupied; ours iff our own server reports that OTLP port
  // (portHeldByOurs). A foreign OTLP squatter would silently eat every span the hooks emit.
  let otlpBusy = false
  try { await httpJson(ctx.otlpPort, 'GET', '/'); otlpBusy = true } catch { otlpBusy = false }
  let uiIsOurs = false
  if (otlpBusy) {
    // OUR server, by pidfile identity or data dir, AND reporting this OTLP port as its own (portHeldByOurs).
    // WHY (TRDD-TYOQA14F): the old test was any 200 on the UI port, so a foreign server answering there hid an
    // OTLP squatter and suppressed this warning.
    uiIsOurs = await portHeldByOurs(ctx, 'otlp', ctx.otlpPort)
  }
  let freeDiskBytes: number | null = null
  try {
    // dataDir may not exist yet — probe the nearest existing ancestor.
    let probe = ctx.dataDir
    while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up }
    const s = fs.statfsSync(probe)
    freeDiskBytes = s.bavail * s.bsize
  } catch { freeDiskBytes = null }
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    nodeFloor: parseNodeFloor(ctx.repoRoot),
    wsl: readFsMarkers().wsl,
    duckdbResolvable: resolvable('@duckdb/node-api'),
    sqljsResolvable: resolvable('sql.js'),
    claudeDirPresent: fs.existsSync(path.join(ctx.home, '.claude')),
    otlpPortBusyForeign: otlpBusy && !uiIsOurs,
    freeDiskBytes,
  }
}

/** Pure verdict over gathered facts — exported for unit tests (TRDD-KVDT1XMS). */
export function judgeEnvFacts(facts: EnvFacts): StepResult {
  const step = 'environment'
  const label = `${facts.platform}${facts.wsl ? ' (WSL)' : ''} ${facts.arch}, node v${facts.nodeVersion}`
  // Hard gates first — each is a state in which the install CANNOT work.
  if (facts.platform === 'win32') {
    return {
      step, found: label, action: 'none', verify: 'FAIL',
      detail: 'native Windows is unsupported — run inside WSL2 (Ubuntu recommended): install Node >= '
        + `${facts.nodeFloor} in the WSL distro and run \`npm install -g agentlenspro\` there`,
    }
  }
  if (facts.nodeFloor === null) {
    return {
      step, found: label, action: 'none', verify: 'FAIL',
      detail: 'cannot read engines.node from the package manifest — the install is incomplete, so the '
        + 'supported Node floor is unknown and will NOT be guessed (reinstall with `npm install -g agentlenspro`)',
    }
  }
  if (!versionAtLeast(facts.nodeVersion, facts.nodeFloor)) {
    return {
      step, found: label, action: 'none', verify: 'FAIL',
      detail: `Node v${facts.nodeVersion} is below the supported floor ${facts.nodeFloor} (package.json engines.node) — upgrade Node`,
    }
  }
  if (!facts.duckdbResolvable) {
    return {
      step, found: label, action: 'none', verify: 'FAIL',
      detail: '@duckdb/node-api is not resolvable — the span store cannot run (broken install: reinstall with `npm install -g agentlenspro`)',
    }
  }
  // Degradable heuristics — warn, never block.
  const warns: string[] = []
  if (!facts.sqljsResolvable) warns.push('sql.js not resolvable — OpenCode SQLite ingestion degrades to per-message JSON')
  if (facts.otlpPortBusyForeign) warns.push('OTLP port answers but our server does not hold it — a foreign process may be squatting the collector port')
  if (!facts.claudeDirPresent) warns.push('~/.claude absent — no Claude Code on this machine yet? hooks/skill will install for its first run')
  if (facts.freeDiskBytes !== null && facts.freeDiskBytes < 2 ** 30) warns.push(`low disk: ${(facts.freeDiskBytes / 2 ** 20).toFixed(0)}MB free at the data dir`)
  return {
    step, found: label, action: 'none', verify: 'PASS',
    detail: warns.length ? warns.join('; ') : 'no incompatibilities detected',
  }
}

const stepEnvironment: StepDef = {
  name: 'environment',
  async run(ctx) {
    const result = judgeEnvFacts(await gatherEnvFacts(ctx))
    return { result, acted: false } // pure probe — never ACTs, dry-run identical
  },
}

/** Total spans persisted in the segmented store, read from the per-segment index files —
 *  a path independent of the server (VERIFY must not trust the process it just started). */
function storeSpanCount(dataDir: string): number {
  const spansDir = path.join(dataDir, 'spans')
  let total = 0
  try {
    for (const f of fs.readdirSync(spansDir)) {
      // A SEALED segment may be `<day>.ndjson.gz` (see segmentedSpanStore's
      // compressSealedSegments) — matching only the plain suffix here would silently drop every
      // compressed day from this count, which feeds the data-preservation assertion below and
      // would misreport spans as lost on every restart after the first compress sweep.
      if (!f.endsWith('.ndjson') && !f.endsWith('.ndjson.gz')) continue
      // Streamed, NOT readFileSync('utf8'): segments are uncapped, and a single day past
      // ~512 MB used to throw V8's max-string-length error here — which this function
      // rethrows, so the whole `setup` verb died on nothing worse than a busy machine.
      total += countNdjsonLinesAuto(path.join(spansDir, f))
    }
  } catch (e) {
    // ONLY "no store yet" may answer 0. This count feeds the data-preservation assertion
    // (postSpanCount < preSpanCount), so a permission or I/O error that returns 0 makes the
    // comparison `anything < 0` — permanently false. Spans could be lost during the restart and
    // the check would still PASS, which is the one thing it exists to catch.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`cannot count the span store at ${spansDir}: ${(e as Error).message}`)
    }
  }
  return total
}

const stepData: StepDef = {
  name: 'data-store',
  async run(ctx) {
    const dbPath = path.join(ctx.dataDir, 'forensics.db')
    const legacySpans = fs.existsSync(path.join(ctx.dataDir, 'spans.json'))
    const preSpans = storeSpanCount(ctx.dataDir)
    const bits: string[] = []
    if (!fs.existsSync(ctx.dataDir)) bits.push('no data dir (fresh install)')
    else bits.push(`${preSpans} stored span(s)${legacySpans ? ', legacy spans.json (server migrates at boot)' : ''}`)
    const hasDb = fs.existsSync(dbPath)
    bits.push(hasDb ? `forensics.db ${fs.statSync(dbPath).size}B` : 'no forensics.db')
    const found = bits.join('; ')

    if (!hasDb) {
      return { result: { step: this.name, found, action: 'none', verify: 'PASS', detail: 'nothing to probe' }, acted: false }
    }
    if (ctx.dryRun) {
      return { result: { step: this.name, found, action: 'would: sqlite quick_check forensics.db', verify: 'SKIP', detail: 'dry-run' }, acted: false }
    }
    const SQL = await loadSqlJs()
    if (!SQL) {
      return { result: { step: this.name, found, action: 'none', verify: 'SKIP', detail: 'sql.js unavailable — integrity probe skipped' }, acted: false }
    }
    const size = fs.statSync(dbPath).size
    let healthy = false
    try {
      const db = new SQL.Database(fs.readFileSync(dbPath))
      const res = db.exec('PRAGMA quick_check')
      healthy = String(res[0]?.values?.[0]?.[0]) === 'ok'
      db.close()
    } catch { healthy = false }
    if (healthy) {
      return { result: { step: this.name, found, action: 'none', verify: 'PASS', detail: 'quick_check ok' }, acted: false }
    }
    // Corrupt: back the bytes ASIDE (never wipe). forensics.db is a DERIVED store (rebuilt
    // incrementally from otel-bodies), so removing the active file only costs a rescan —
    // but the corrupt bytes stay recoverable in the .corrupt-<ts> sibling regardless.
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${dbPath}.corrupt-${ts}`
    fs.renameSync(dbPath, backup)
    // VERIFY through the filesystem, not the rename's lack-of-throw: bytes preserved, active gone.
    const ok = fs.existsSync(backup) && fs.statSync(backup).size === size && !fs.existsSync(dbPath)
    return {
      result: {
        step: this.name, found: `${found} (CORRUPT)`,
        action: `backed up aside → ${path.basename(backup)}`,
        verify: ok ? 'PASS' : 'FAIL',
        detail: ok ? 'bytes preserved; server rebuilds the derived DB' : 'backup-aside verification failed',
      },
      acted: true,
    }
  },
}

const stepHooks: StepDef = {
  name: 'hooks',
  async run(ctx) {
    const state = readSettingsFresh(ctx.settingsPath)
    if (state === 'unparseable') {
      // Refuse-unparseable (safeConfigEdit stance): never "repair" a config we cannot read.
      return {
        result: {
          step: this.name, found: `${ctx.settingsPath} is not parseable JSON`,
          action: 'refused', verify: 'FAIL',
          detail: 'fix the file manually, then re-run setup — never start fresh over user config',
        },
        acted: false,
      }
    }
    const settings = state === 'absent' ? {} : state
    const converged = state !== 'absent' && hooksConverged(settings)
    const staleCount = Object.values(settingsHooks(settings)).flat()
      .flatMap(m => m.hooks ?? [])
      .filter(h => isStaleGeneration(h.command)).length
    const found = state === 'absent'
      ? 'no settings.json'
      : converged ? 'registrations current' : staleCount === 0 ? 'needs converge (registration drift: timeout or shape)' : `needs converge (${staleCount} stale/legacy entr${staleCount === 1 ? 'y' : 'ies'})`

    if (ctx.dryRun) {
      return {
        result: {
          step: this.name, found,
          action: converged ? 'none' : `would: register '${HOOK_CMD}' + '${GATE_CMD}' + '${REVIEW_CMD}' via safeConfigEdit`,
          verify: 'SKIP', detail: 'dry-run',
        },
        acted: false,
      }
    }

    let acted = false
    if (!converged) {
      await installHooks(false, { settingsPath: ctx.settingsPath, pathEnv: ctx.pathEnv, log: ctx.log })
      acted = true
    }
    // VERIFY 1 — independent re-parse (fresh fs read, our own JSON.parse; not the editor).
    const after = readSettingsFresh(ctx.settingsPath)
    if (after === 'absent' || after === 'unparseable') {
      return { result: { step: this.name, found, action: acted ? 'installed' : 'none', verify: 'FAIL', detail: `post-state ${after}` }, acted }
    }
    const bad = verifyHooksState(after)
    if (bad) {
      return { result: { step: this.name, found, action: acted ? 'installed' : 'none', verify: 'FAIL', detail: bad }, acted }
    }
    // VERIFY 2 — execute the REGISTERED commands with synthetic payloads (contract: exit 0;
    // the forwarder prints nothing; both fail-open even while the server is still down).
    const hookErr = execRegisteredCommand(ctx, HOOK_CMD,
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'setup-verify' }), true)
    if (hookErr) {
      return { result: { step: this.name, found, action: acted ? 'installed' : 'none', verify: 'FAIL', detail: `'${HOOK_CMD}' ${hookErr}` }, acted }
    }
    const gateErr = execRegisteredCommand(ctx, GATE_CMD,
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: {} }), false)
    if (gateErr) {
      return { result: { step: this.name, found, action: acted ? 'installed' : 'none', verify: 'FAIL', detail: `'${GATE_CMD}' ${gateErr}` }, acted }
    }
    // No transcript_path resolves ⇒ nothing to scan ⇒ allow silently (exit 0, no stdout) — same
    // contract as hook/gate's synthetic-payload check above.
    const reviewErr = execRegisteredCommand(ctx, REVIEW_CMD,
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'setup-verify', transcript_path: '/nonexistent' }), true)
    if (reviewErr) {
      return { result: { step: this.name, found, action: acted ? 'installed' : 'none', verify: 'FAIL', detail: `'${REVIEW_CMD}' ${reviewErr}` }, acted }
    }
    return {
      result: {
        step: this.name, found, action: acted ? 'installed/migrated' : 'none', verify: 'PASS',
        detail: 'entries exact-once; registered commands executed clean',
      },
      acted,
    }
  },
}

const stepSkill: StepDef = {
  name: 'skill',
  async run(ctx) {
    // EVERY shipped skill, not just the first: a second skill that was shipped in the tarball but
    // never checked here would be installed once and then never repaired or refreshed, and setup's
    // whole contract is "detect → converge → verify" for the things it owns.
    // Hash the whole skill TREE, not just SKILL.md: a skill ships templates/scripts/references
    // alongside it, and a drift check that only reads SKILL.md would report "current" while the
    // user runs a stale template.
    const skills = SKILL_NAMES.map(name => {
      const src = path.join(ctx.repoRoot, 'skills', name)
      const dst = path.join(ctx.skillsDir, name)
      const srcHash = skillTreeHash(src)
      // The INSTALLED copy is hashed over the SHIPPED file list only (see skillTreeHash): an unshipped
      // extra that installSkill leaves in place must not read as drift, or this step re-runs on every
      // launch, rewrites nothing and fails its own verify below.
      const srcFiles = srcHash === null ? [] : skillFiles(src)
      return {
        name, src: path.join(src, 'SKILL.md'), dst, srcExists: srcHash !== null,
        srcHash, srcFiles,
        dstHash: skillTreeHash(dst, srcFiles),
      }
    })
    const missing = skills.filter(s => !s.srcExists)
    if (missing.length > 0) {
      return { result: { step: this.name, found: `shipped skill missing at ${missing.map(s => s.src).join(', ')}`, action: 'refused', verify: 'FAIL', detail: 'package is incomplete' }, acted: false }
    }
    const stale = skills.filter(s => s.dstHash !== s.srcHash)
    const supersededDir = path.join(ctx.skillsDir, 'agentlens-diagnostics')
    const hasSuperseded = fs.existsSync(supersededDir)
    const found = `${skills.length - stale.length}/${skills.length} current` +
      (stale.length > 0 ? ` (${stale.map(s => `${s.name}: ${s.dstHash === null ? 'not installed' : 'content drift'}`).join(', ')})` : '') +
      (hasSuperseded ? ' + superseded agentlens-diagnostics present' : '')

    if (ctx.dryRun) {
      const plan: string[] = []
      if (stale.length > 0) plan.push(`install/refresh ${stale.map(s => s.name).join(', ')}`)
      if (hasSuperseded) plan.push('move old agentlens-diagnostics aside')
      return { result: { step: this.name, found, action: plan.length ? `would: ${plan.join('; ')}` : 'none', verify: 'SKIP', detail: 'dry-run' }, acted: false }
    }

    let acted = false
    for (const s of stale) {
      installSkill({ repoRoot: ctx.repoRoot, skillsDir: ctx.skillsDir, log: ctx.log, name: s.name })
      acted = true
    }
    let supersededNote = ''
    if (hasSuperseded) {
      // Only claim it when the content identifies as the OLD generation (it talks about the
      // retired agentlens-cli binary). MOVE aside instead of deleting — never destroy what
      // we cannot prove is ours.
      const oldSkillMd = path.join(supersededDir, 'SKILL.md')
      const looksOurs = fs.existsSync(oldSkillMd) && fs.readFileSync(oldSkillMd, 'utf8').includes('agentlens-cli')
      if (looksOurs) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        fs.renameSync(supersededDir, `${supersededDir}.superseded-${ts}`)
        supersededNote = '; old skill moved aside'
        acted = true
      } else {
        supersededNote = '; agentlens-diagnostics left untouched (content not recognisably ours)'
      }
    }
    // The AGENT definitions converge with the skills, in this same step: a skill that dispatches
    // `agentlens-tldr-worker` is inert on a machine without that agent file, so a run that
    // refreshed the skills and skipped the agents would report PASS on a half-installed feature.
    const agentsStale = AGENT_NAMES.filter(name => {
      const src = path.join(ctx.repoRoot, 'agents', `${name}.md`)
      const dst = path.join(ctx.agentsDir, `${name}.md`)
      return fs.existsSync(src) && (!fs.existsSync(dst) || sha256File(dst) !== sha256File(src))
    })
    if (agentsStale.length > 0) {
      installAgents({ repoRoot: ctx.repoRoot, agentsDir: ctx.agentsDir, log: ctx.log })
      acted = true
    }

    // VERIFY — hash compare on a FRESH read of both trees (not the writer's buffer), for EVERY
    // skill and agent. One bad apple fails the step and is named, so "PASS" can never mean "the
    // first one was fine and the rest were not looked at".
    const bad = skills.filter(s => skillTreeHash(s.dst, s.srcFiles) !== s.srcHash)
    const badAgents = AGENT_NAMES.filter(name => {
      const src = path.join(ctx.repoRoot, 'agents', `${name}.md`)
      const dst = path.join(ctx.agentsDir, `${name}.md`)
      return !(fs.existsSync(src) && fs.existsSync(dst) && sha256File(dst) === sha256File(src))
    })
    return {
      result: {
        step: this.name, found: `${found}; agents ${AGENT_NAMES.length - agentsStale.length}/${AGENT_NAMES.length} current`,
        action: acted ? 'installed/refreshed' : 'none',
        verify: bad.length === 0 && badAgents.length === 0 ? 'PASS' : 'FAIL',
        detail: (bad.length === 0 && badAgents.length === 0
          ? `sha256 match on ${skills.length} skill tree(s) + ${AGENT_NAMES.length} agent(s)${supersededNote}`
          : `installed hash differs from shipped hash: ${[...bad.map(s => s.name), ...badAgents].join(', ')}`),
      },
      acted,
    }
  },
}

/** Read-only telemetry-env drift check shared by stepOtel and the auto-launch repair path, so the two
 *  can never disagree on what "converged" means. 'unparseable' = settings.json cannot be read.
 *  `conflicts` non-empty = ANOTHER telemetry pipeline is
 *  configured (company gateway / managed settings / shell env): nothing may be written. */
export function otelDrift(ctx: Ctx): 'unparseable' | {
  bodiesDir: string; expected: Record<string, string>; converged: boolean; found: string; conflicts: TelemetryConflict[]
  rows: TelemetryVerdictRow[]; converge: string[]; staleEnv: TelemetryVerdictRow[]
} {
  // Raw-body capture is MANDATORY (owner reversal 2026-10-02, TRDD-AGZ0XZKW): the key is always owned.
  const bodiesDir = effectiveBodiesDir(ctx.dataDir)
  const expected = ownedTelemetryKeys(bodiesDir, ctx.otlpPort)
  const state = readSettingsFresh(ctx.settingsPath)
  if (state === 'unparseable') return 'unparseable'
  // The verdict (telemetryConfig.ts) is the ONE judge: ABSENT/CONVERGE rows are repaired, FOREIGN rows block,
  // STALE-ENV rows (a Claude Code session's inherited snapshot) only warn.
  const rows = telemetryVerdict({
    settingsPath: ctx.settingsPath, markerPath: path.join(ctx.dataDir, 'telemetry-managed.json'),
    bodiesDir, otlpPort: ctx.otlpPort, dataDir: ctx.dataDir, ...ctx.telemetryProbe,
  })
  const conflicts = detectConflictsFromRows(rows)
  const userRows = rows.filter(r => r.scope === 'user')
  const missing = userRows.filter(r => r.state === 'ABSENT').length
  const converge = userRows.filter(r => r.state === 'CONVERGE').map(r => r.key)
  const staleEnv = rows.filter(r => r.state === 'STALE-ENV')
  const converged = conflicts.length === 0 && missing === 0 && converge.length === 0
  const found = conflicts.length > 0
    ? `${conflicts.length} conflicting key(s) — another telemetry pipeline is configured`
    : converged ? 'telemetry env current' : `${missing} missing, ${converge.length} to converge`
  return { bodiesDir, expected, converged, found, conflicts, rows, converge, staleEnv }
}

const stepOtel: StepDef = {
  name: 'otel-env',
  async run(ctx) {
    const markerPath = path.join(ctx.dataDir, 'telemetry-managed.json')
    const drift = otelDrift(ctx)
    if (drift === 'unparseable') {
      return { result: { step: this.name, found: 'settings.json unparseable', action: 'refused', verify: 'FAIL', detail: 'fix the file manually, then re-run setup' }, acted: false }
    }
    const { bodiesDir, expected, converged, found, conflicts, rows } = drift
    // A foreign pipeline (owner order 2026-10-02): refuse and write NOTHING unless --force-install-telemetry
    // was given. A conflicting SHELL export can never be fixed by a settings edit, so it refuses even then.
    if (conflicts.length > 0 && (!ctx.forceInstall || conflicts.some(c => c.scope === 'shell'))) {
      // Disable again, like the launch path (kill-switch re-armed, skills parked) — but never in a dry run.
      const note = ctx.dryRun ? '' : `\nagentlenspro has disabled itself: ${disableForForeignTelemetry({ dataDir: ctx.dataDir, skillsDir: ctx.skillsDir, rulesDir: path.join(ctx.home, '.claude', 'rules') }).length} skill(s) moved to ${path.join(ctx.dataDir, 'disabled-surfaces')}, hooks are no-ops`
      return { result: { step: this.name, found, action: ctx.dryRun ? 'would: refuse, disable agentlenspro, exit non-zero (dry-run: nothing done)' : 'refused', verify: ctx.dryRun ? 'SKIP' : 'FAIL', detail: formatTelemetryConflicts(conflicts) + note + (ctx.dryRun ? `\nverdict (dry-run, nothing written):\n${formatTelemetryVerdict(rows)}` : '') }, acted: !ctx.dryRun }
    }

    if (ctx.dryRun) {
      return { result: { step: this.name, found, action: converged ? 'none' : 'would: wire telemetry env (verified transaction)', verify: 'SKIP', detail: `dry-run — verdict, nothing written:\n${formatTelemetryVerdict(rows)}` }, acted: false }
    }
    let acted = false
    let backup = ''
    if (conflicts.some(c => c.scope === 'managed')) {
      // The organisation's managed-settings file: overwrite through safeConfigEdit when this user can
      // write it; otherwise exit with the administrator message (never escalate).
      try {
        for (const m of await forceInstallManagedTelemetry(conflicts, { bodiesDir, otlpPort: ctx.otlpPort, dataDir: ctx.dataDir, ...ctx.telemetryProbe })) {
          backup += `; managed ${m.file}${m.backupPath ? ` backup ${m.backupPath}` : ''}`
        }
      } catch (e) {
        return { result: { step: this.name, found, action: 'refused', verify: 'FAIL', detail: (e as Error).message }, acted: false }
      }
      acted = true
    }
    if (!converged) {
      const r = await ensureTelemetryConfig({ settingsPath: ctx.settingsPath, markerPath, bodiesDir, otlpPort: ctx.otlpPort, dataDir: ctx.dataDir, forceInstall: ctx.forceInstall, ...ctx.telemetryProbe })
      if (r.backupPath) backup += `; backup ${r.backupPath}`
      acted = true
    }
    // VERIFY — independent re-parse; every owned key must hold exactly the expected value.
    const after = readSettingsFresh(ctx.settingsPath)
    if (after === 'absent' || after === 'unparseable') {
      return { result: { step: this.name, found, action: acted ? 'wired' : 'none', verify: 'FAIL', detail: `post-state ${after}` }, acted }
    }
    const envAfter = (after.env && typeof after.env === 'object' ? after.env : {}) as Record<string, unknown>
    const bad = Object.keys(expected).find(k => envAfter[k] === undefined || !sameTelemetryValue(k, String(envAfter[k]), expected[k]))
    // Our telemetry is in place and nothing foreign remains: a kill-switch armed for the foreign-telemetry
    // reason has no more reason to stand (an operator-armed one is never touched).
    if (!bad) enableIfForeign({ dataDir: ctx.dataDir, skillsDir: ctx.skillsDir, rulesDir: path.join(ctx.home, '.claude', 'rules') })
    return {
      result: {
        step: this.name, found, action: acted ? 'wired' : 'none',
        verify: bad ? 'FAIL' : 'PASS',
        detail: bad
          ? `${bad} = ${JSON.stringify(envAfter[bad])} (expected ${JSON.stringify(expected[bad])})`
          : `${Object.keys(expected).length} key(s) exact${backup}`,
      },
      acted,
    }
  },
}

const stepOldPackage: StepDef = {
  name: 'old-package',
  async run(ctx) {
    // agentlens-dashboard is the pre-fork generation; its resident server would fight this
    // one for the canonical ports. The retired sibling bins of THIS package (agentlenspro-cli
    // etc.) disappear on the npm upgrade itself, so only report them.
    const oldBin = resolveOnPath('agentlens-dashboard', ctx.pathEnv)
    const staleSiblings = ['agentlens', 'agentlens-cli', 'agentlenspro-cli', 'agentlenspro-hook', 'agentlenspro-gate', 'agentlenspro-heartbeat-cost']
      .filter(b => resolveOnPath(b, ctx.pathEnv) !== null)
    const found = `${oldBin ? `agentlens-dashboard at ${oldBin}` : 'no old-generation install'}${staleSiblings.length ? `; stale bins on PATH: ${staleSiblings.join(', ')}` : ''}`
    if (!oldBin) {
      return { result: { step: this.name, found, action: 'none', verify: 'PASS', detail: staleSiblings.length ? 'reinstall/upgrade removes stale sibling bins' : undefined }, acted: false }
    }
    if (ctx.dryRun) {
      return { result: { step: this.name, found, action: 'would: npm rm -g agentlens-dashboard', verify: 'SKIP', detail: 'dry-run' }, acted: false }
    }
    if (!ctx.yes) {
      // Mutating the GLOBAL npm tree without explicit consent is out of bounds — report and
      // let the user opt in with --yes (non-interactive contract).
      return { result: { step: this.name, found, action: 'skipped (needs --yes)', verify: 'SKIP', detail: 'run `agentlenspro setup --yes` or `npm rm -g agentlens-dashboard`' }, acted: false }
    }
    try {
      execFileSync('npm', ['rm', '-g', 'agentlens-dashboard'], { stdio: 'pipe', timeout: 120_000, env: { ...process.env, PATH: ctx.pathEnv } })
    } catch (e) {
      return { result: { step: this.name, found, action: 'npm rm -g agentlens-dashboard', verify: 'FAIL', detail: (e as Error).message.slice(0, 120) }, acted: true }
    }
    // VERIFY — the bin must be gone from PATH (fresh probe, not npm's exit code).
    const still = resolveOnPath('agentlens-dashboard', ctx.pathEnv)
    return {
      result: { step: this.name, found, action: 'npm rm -g agentlens-dashboard', verify: still ? 'FAIL' : 'PASS', detail: still ? `still resolves at ${still}` : 'bin gone from PATH' },
      acted: true,
    }
  },
}

/** Exported for the direct-run test of its foreign-server refusal (TRDD-TYOQA14F). */
export const stepServer: StepDef = {
  name: 'server',
  async run(ctx) {
    const pre = await serverStats(ctx)
    // A failed stats probe is NOT proof the server is down — a busy server (GC-thrashing at
    // multi-GB rss) can miss the 5s HTTP window while very much owning the data directory.
    // Measured live: `setup --dry-run` printed "not running" against a server that `server
    // status` showed RUNNING, because its stats answer was slow. Collapsing that timeout into
    // "not running" is worse than cosmetic: the real-run remedy for "not running" is SPAWNING,
    // which slams into the single-owner data-dir guard and reports a confusing failure. So when
    // HTTP says nothing, consult the pidfile under ctx.dataDir: an alive owner means
    // "unresponsive — restart", never "absent — start".
    // The owner goes through ownServerPid, the same identity check every signal below uses
    // (TRDD-V2HFI30L): liveLockPid reads both lock shapes (TRDD-PIDFILEAT) and checks the start
    // reference, and the server-command guard (PR-15 review) still refuses a recycled pid — the
    // real-run path SIGTERMs this number, and a wrongly-spared real server is still protected by
    // its own single-owner boot guard (the safe failure direction).
    let stalePid: number | null = null
    if (pre === null) {
      const owner = liveLockPid(ctx.dataDir)
      if (owner !== null) stalePid = ownServerPid(ctx, owner)
    }
    const preSpanCount = pre?.spans?.store?.totalSpans ?? storeSpanCount(ctx.dataDir)
    const preOurs = pre !== null && statsAreOurs(ctx, pre)
    const healthy = pre !== null && preOurs
      && pre.ports?.ui === ctx.uiPort && pre.ports?.mcp === ctx.mcpPort && pre.ports?.otlp === ctx.otlpPort
    const found = pre
      ? `running pid=${pre.pid} (dataDir ${preOurs ? 'matches' : 'MISMATCH'})`
      : stalePid !== null
        ? `unresponsive (pid ${stalePid} alive, stats probe got no answer in 5s)`
        : 'not running'

    if (ctx.dryRun) {
      const would = healthy ? 'none'
        : pre !== null && !preOurs ? 'would: refuse (another instance answers on the UI port)'
          : pre !== null || stalePid !== null ? 'would: graceful restart from this install' : 'would: start server'
      return { result: { step: this.name, found, action: would, verify: 'SKIP', detail: 'dry-run' }, acted: false }
    }
    if (healthy) {
      ctx.serverPid = pre.pid
      return { result: { step: this.name, found, action: 'none', verify: 'PASS', detail: `dashboard+MCP+OTLP already serving ${preSpanCount} span(s)` }, acted: false }
    }

    // TRDD-V2HFI30L: setup never stops a server it cannot prove is its own. The old code SIGTERMed
    // `pre.pid` — a number the UI port's answerer reported about itself — whenever the reported data
    // dir differed, so an isolated setup (a test, a second instance) on the default ports killed the
    // developer's live collector. A foreign server is refused with its pid, data dir and the remedy.
    if (pre !== null && !preOurs) {
      return { result: { step: this.name, found, action: 'refuse', verify: 'FAIL', detail: foreignServerDetail(ctx, pre) }, acted: false }
    }
    // ACT — graceful stop of a mismatched/old/unresponsive server OF OURS (SIGTERM = span-flush), then
    // start from THIS install's bundle. The unresponsive case uses the pidfile pid: skipping the
    // stop and going straight to spawn would hit the single-owner guard.
    const stopPid = pre !== null ? ownServerPid(ctx, pre.pid) : stalePid
    if (pre !== null && stopPid === null) {
      return {
        result: {
          step: this.name, found, action: 'refuse', verify: 'FAIL',
          detail: `the server on UI port ${ctx.uiPort} reports this data dir but its pid ${pre.pid} is not provably ours (not the live owner in ${path.join(ctx.dataDir, 'server.pid')}, not \`alcore serve --data-dir ${ctx.dataDir}\`), so setup will not signal it: stop it yourself, or pin UI_PORT, MCP_PORT and OTLP_PORT to free ports`,
        },
        acted: false,
      }
    }
    if (stopPid !== null) {
      try { process.kill(stopPid, 'SIGTERM') } catch { /* already gone */ }
      const gone = async (): Promise<boolean> =>
        (await serverStats(ctx)) === null && (() => { try { process.kill(stopPid, 0); return false } catch { return true } })()
      // Wall clock, not a try count (TRDD-V2HFI30L): each stats probe can itself take seconds, so
      // "40 tries" stretched the promised 10s to minutes.
      const stopBy = Date.now() + 10_000
      while (Date.now() < stopBy && !(await gone())) await sleep(250)
      if (!(await gone())) {
        return { result: { step: this.name, found, action: 'stop old server', verify: 'FAIL', detail: `pid ${stopPid} did not stop within 10s` }, acted: true }
      }
    }
    // The kill-switch gates EVERY spawn path, including setup (TRDD-K3WDPR7M): this was the one
    // spawn site with no guard, discovered when a server booted minutes after `agentlenspro
    // disable`. The server now also refuses at its own boot — this check just makes setup report
    // the refusal honestly instead of spawning a child that immediately exits 78.
    if (agentlensDisabled(ctx.dataDir)) {
      return { result: { step: this.name, found, action: 'start server', verify: 'FAIL', detail: 'AgentlensPro is DISABLED — run `agentlenspro enable` first' }, acted: false }
    }
    // The NO_REVIVE brake refuses this spawn too: `setup` is idempotent and re-run casually, so a
    // silent override here would resurrect a server mid store-swap exactly like the hook path did
    // (TRDD-8VGQK9L9). Reported, not skipped — a setup step that quietly does nothing looks healthy.
    // Sits BELOW the graceful stop of a mismatched/unresponsive server on purpose, beside the
    // DISABLED gate: the brake forbids a SPAWN, not a stop, and "braked ⇒ no server" is the state
    // an operator armed it for — leaving a stale server up would be the surprising outcome.
    // Both flags are read in ctx.dataDir, the dir this step is about to start a server in, not the env-resolved one:
    // they differ whenever the data dir comes from options (TRDD-TYOQA14F).
    // DELIBERATE ASYMMETRY (TRDD-TYOQA14F): setup honours the FILE brake but NOT the AGENTLENS_NO_REVIVE env. That
    // env is documented as a brake on AUTOMATIC revives (hookHandlers.ts reviveDaemonDetached, `server revive`),
    // set by tests and by an operator supervising the daemon externally; an explicit `agentlenspro setup` is a
    // deliberate start, and the real-server setup tests (setupVerb.test.ts) run with that env set and still expect
    // setup to start a server.
    if (reviveBraked(ctx.dataDir)) {
      return { result: { step: this.name, found, action: 'start server', verify: 'FAIL', detail: `revive brake is set (${noRevivePath(ctx.dataDir)}) — \`agentlenspro server start\` clears it` }, acted: false }
    }
    // alcore is the only server this package ships (TRDD-1B98LCVR box 4) — no binary means the
    // step fails honestly rather than spawning a TS bundle that no longer exists.
    const platform = `${process.platform}-${process.arch}`
    let alcore: string | null
    try { alcore = alcoreBin(process.env, undefined, undefined, resolveBinNativeDir()) } catch (e) {
      return { result: { step: this.name, found, action: 'start server', verify: 'FAIL', detail: (e as Error).message }, acted: false }
    }
    if (!alcore) {
      return { result: { step: this.name, found, action: 'start server', verify: 'FAIL', detail: `no server available for ${platform} — set AGENTLENS_ALCORE or build rust-core` }, acted: false }
    }
    fs.mkdirSync(ctx.dataDir, { recursive: true })
    const logFile = path.join(ctx.dataDir, 'server.log')
    let outFd: number | 'ignore'
    try { outFd = fs.openSync(logFile, 'a') } catch { outFd = 'ignore' }
    const spawnEnv = {
      ...process.env,
      [STARTED_BY_ENV]: 'setup',  // boot-provenance stamp (TRDD-8VGQK9L9); found by sweep
      MIMALLOC_PURGE_DELAY: ALCORE_MIMALLOC_PURGE_DELAY_MS,  // TRDD-2JOIAH2G R1 — see serverControl.ts
      HOME: ctx.home,
      DATA_DIR: ctx.dataDir,
      UI_PORT: String(ctx.uiPort),
      MCP_PORT: String(ctx.mcpPort),
      OTLP_PORT: String(ctx.otlpPort),
      AGENTLENS_OPEN_BROWSER: '0', // setup verifies with HTTP probes; a browser popup is noise
    }
    // alcore reads NO env for ports/data-dir — flags only — so the ctx values go on the argv.
    const child = spawn(alcore, alcoreServeArgs(spawnEnv, ctx.dataDir), { cwd: ctx.dataDir, detached: true, stdio: ['ignore', outFd, outFd], env: spawnEnv })
    child.unref()
    if (typeof outFd === 'number') fs.closeSync(outFd)

    // VERIFY — through the network, never the child handle: dashboard 200, OTLP accepts,
    // pid is NEW, and the loaded span count did not shrink (data preservation assertion).
    // Up to 30s of wall clock — DB open + first log scan can be slow; counted in time, not tries,
    // because each probe can itself take seconds (TRDD-V2HFI30L).
    let post: StatsShape | null = null
    const readyBy = Date.now() + 30_000
    while (post === null && Date.now() < readyBy) {
      await sleep(250)
      post = await serverStats(ctx)
    }
    if (!post) {
      return { result: { step: this.name, found, action: 'start server', verify: 'FAIL', detail: `not ready within 30s — check ${logFile}` }, acted: true }
    }
    ctx.serverPid = post.pid
    const dash = await httpJson(ctx.uiPort, 'GET', '/').catch(() => ({ status: 0, json: null }))
    const otlp = await httpJson(ctx.otlpPort, 'POST', '/v1/traces', { resourceSpans: [] }).catch(() => ({ status: 0, json: null }))
    const postSpanCount = post.spans?.store?.totalSpans ?? 0
    const problems: string[] = []
    if (dash.status !== 200) problems.push(`dashboard HTTP ${dash.status}`)
    if (otlp.status !== 200) problems.push(`OTLP HTTP ${otlp.status}`)
    if (pre && post.pid === pre.pid) problems.push('pid unchanged — old process survived')
    if (postSpanCount < preSpanCount) problems.push(`span count shrank ${preSpanCount}→${postSpanCount}`)
    return {
      result: {
        step: this.name, found, action: pre ? 'restarted from this install' : 'started',
        verify: problems.length ? 'FAIL' : 'PASS',
        detail: problems.length ? problems.join('; ') : `pid=${post.pid}; dashboard 200; OTLP 200; spans ${postSpanCount} ≥ ${preSpanCount}`,
      },
      acted: true,
    }
  },
}

/** Owner rule 2026-10-02 — never squat a busy port. Wraps stepServer with the SAME chooser the
 *  `agentlenspro server start` path uses: env-pinned ports and OTLP refuse loudly naming the holder,
 *  unpinned UI/MCP move to the next free port; a port held by our own running server (our data dir,
 *  reporting that port as its own) is kept. The chosen ports go back into ctx so the server step,
 *  the verify probes and the final self-test all
 *  dial what is actually bound. ports.json is written only after the server step verified PASS,
 *  never from a dry-run (a dry-run claims nothing and writes nothing). */
const stepServerGuarded: StepDef = {
  name: stepServer.name,
  async run(ctx) {
    if (!ctx.dryRun) {
      try {
        const pinned = (raw: string | undefined): boolean => envPort(raw, 0) !== '0'
        const chosen = await chooseServerPorts(
          { otlp: ctx.otlpPort, ui: ctx.uiPort, mcp: ctx.mcpPort },
          { ui: pinned(process.env.UI_PORT), mcp: pinned(process.env.MCP_PORT) },
          // TRDD-V2HFI30L: ours = this setup's own server AND reporting that very port — "any 200 on
          // the UI port" adopted another instance's ports, after which the server step SIGTERMed it.
          (kind, port) => portHeldByOurs(ctx, kind, port),
        )
        ctx.otlpPort = chosen.otlp; ctx.uiPort = chosen.ui; ctx.mcpPort = chosen.mcp
      } catch (e) {
        // The chooser's refusal names the port holder's pid; when another instance answers on the UI
        // port, also name its data dir and how to stop it (TRDD-V2HFI30L).
        const holder = await serverStats(ctx)
        const hint = holder !== null && !statsAreOurs(ctx, holder) ? `\n${foreignServerDetail(ctx, holder)}` : ''
        return { result: { step: this.name, found: 'port claim', action: 'start server', verify: 'FAIL', detail: (e as Error).message + hint }, acted: false }
      }
    }
    const out = await stepServer.run(ctx)
    if (!ctx.dryRun && out.result.verify === 'PASS') writePortsFile(ctx.dataDir, { otlp: ctx.otlpPort, ui: ctx.uiPort, mcp: ctx.mcpPort })
    return out
  },
}

const stepSelfTest: StepDef = {
  name: 'final-test',
  async run(ctx) {
    if (ctx.dryRun) {
      return { result: { step: this.name, found: 'end-to-end self-test', action: 'would: OTLP span → get_recent_sessions round-trip; hook+gate exec', verify: 'SKIP', detail: 'dry-run' }, acted: false }
    }
    // 1. Synthetic OTLP span in one door…
    const marker = `setup-selftest-${crypto.randomBytes(6).toString('hex')}`
    const nowNs = `${Date.now()}000000`
    const post = await httpJson(ctx.otlpPort, 'POST', '/v1/traces', {
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: `${marker}-trace`,
            spanId: marker, // the Copilot builder keys the session card on the root span id
            name: 'invoke_agent setup-selftest',
            startTimeUnixNano: nowNs,
            endTimeUnixNano: nowNs,
            attributes: [],
            status: { code: 0 },
          }],
        }],
      }],
    }).catch(() => ({ status: 0, json: null }))
    if (post.status !== 200) {
      return { result: { step: this.name, found: 'server up', action: 'OTLP POST', verify: 'FAIL', detail: `OTLP ingest HTTP ${post.status}` }, acted: false }
    }
    // …2. and back out through the DIAGNOSTICS door (the get_recent_sessions MCP tool):
    // the round-trip proves collector → span store → summarizer → repository → MCP in one go.
    let seen = false
    // 10s of wall clock, not 40 tries: each MCP call can itself take seconds (TRDD-V2HFI30L).
    const seenBy = Date.now() + 10_000
    while (!seen && Date.now() < seenBy) {
      try {
        // The stateless Streamable-HTTP endpoint still wants the MCP handshake once per
        // client; it is cheap, so re-issue it per attempt rather than track session state.
        await mcpCall(ctx.mcpPort, 'initialize', {
          protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agentlenspro-setup', version: '2.0.0' },
        })
        const r = await mcpCall(ctx.mcpPort, 'tools/call', {
          name: 'get_recent_sessions',
          arguments: { limit: 50, verbosity: 'full' },
        })
        seen = JSON.stringify(r).includes(marker)
      } catch { /* MCP may need a beat after boot */ }
      if (!seen) await sleep(250)
    }
    if (!seen) {
      return { result: { step: this.name, found: 'server up', action: 'OTLP→MCP round-trip', verify: 'FAIL', detail: `synthetic span ${marker} not visible via get_recent_sessions within 10s` }, acted: false }
    }
    // 3. Hook + gate handlers against synthetic stdin payloads, via the REGISTERED strings.
    const preStats = await serverStats(ctx)
    const preHookCount = preStats?.hookEvents?.receivedSinceBoot ?? 0
    const hookErr = execRegisteredCommand(ctx, HOOK_CMD,
      JSON.stringify({ hook_event_name: 'SessionStart', session_id: marker }), true)
    if (hookErr) {
      return { result: { step: this.name, found: 'round-trip ok', action: 'hook exec', verify: 'FAIL', detail: `'${HOOK_CMD}' ${hookErr}` }, acted: false }
    }
    // Verified through a DIFFERENT path: the server's received-events counter must move.
    let counted = false
    for (let i = 0; i < 20 && !counted; i++) {
      const s = await serverStats(ctx)
      counted = (s?.hookEvents?.receivedSinceBoot ?? 0) > preHookCount
      if (!counted) await sleep(250)
    }
    if (!counted) {
      return { result: { step: this.name, found: 'round-trip ok', action: 'hook exec', verify: 'FAIL', detail: 'hook ran but the server never counted the event' }, acted: false }
    }
    const gateErr = execRegisteredCommand(ctx, GATE_CMD,
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'general-purpose' } }), false)
    if (gateErr) {
      return { result: { step: this.name, found: 'round-trip ok', action: 'gate exec', verify: 'FAIL', detail: `'${GATE_CMD}' ${gateErr}` }, acted: false }
    }
    return {
      result: {
        step: this.name, found: 'server up', action: 'span round-trip + hook/gate exec',
        verify: 'PASS', detail: `span ${marker} visible via get_recent_sessions; hook event counted`,
      },
      acted: false,
    }
  },
}

export interface MemoryCheck { verdict: 'PASS' | 'INFO' | 'WARN' | 'SKIP'; detail: string }

/** The memory-check detail when server.log has no composition line yet. Exported: the setupVerb test matches it. */
export const NO_COMPOSITION_LINE_DETAIL = 'no composition line in server.log yet'

/** Parse one server.log composition line: PASS when live + free-in-page is within 1 MB of
 *  committed (measured rounding bound); INFO (never FAIL — an unexplained ~1 MB committed class
 *  was not ruled out) on larger drift, and INFO when free-in-page exceeds half of committed
 *  (~664 of ~690 MB at boot, expected until Phase D streaming restore lands); WARN when the line
 *  is unparseable; SKIP when unmeasured. Never throws. */
export function checkCompositionLine(line: string | null): MemoryCheck {
  if (!line) return { verdict: 'SKIP', detail: NO_COMPOSITION_LINE_DETAIL }
  const num = (re: RegExp): number | null | undefined => {
    const m = re.exec(line)
    return m ? (m[1] === '?' ? null : Number(m[1])) : undefined
  }
  const live = num(/mi live (\d+|\?) MB/)
  const free = num(/mi free-in-page (\d+|\?) MB/)
  const committed = num(/mi committed (\d+) MB/)
  if (live === undefined || free === undefined) return { verdict: 'WARN', detail: `unparseable composition line: ${line.slice(0, 200)}` }
  if (live === null || free === null) return { verdict: 'SKIP', detail: 'mi live/free-in-page unmeasured (?)' }
  if (committed == null) return { verdict: 'SKIP', detail: 'no mi committed reading on the line' }
  // The mi fields are the END of the line, so keep the tail when quoting it.
  const drift = Math.abs(committed - (live + free))
  if (drift > 1) return { verdict: 'INFO', detail: `live ${live} + free-in-page ${free} MB differs from committed ${committed} MB by ${drift} MB: ${line.slice(-200)}` }
  if (free > committed / 2) return { verdict: 'INFO', detail: `free-in-page ${free} MB > 50% of committed ${committed} MB — expected until Phase D (streaming restore) lands: ${line.slice(-200)}` }
  return { verdict: 'PASS', detail: `committed ${committed} MB = live ${live} + free-in-page ${free} (±1)` }
}

/** The composition tick fires every 60 s; a log untouched for 2.5 ticks has no fresh line. */
export const COMPOSITION_STALE_MS = 150_000

/** Check the newest composition line in server.log (tail only, never the whole log). The step
 *  model has no WARN state, so an unparseable line (a broken instrument) and a stale or absent log
 *  both map to SKIP — never PASS. Never throws. */
export function memoryCheckFromLog(logFile: string, nowMs: number = Date.now()): { verify: Verify; detail: string } {
  let line: string | null = null
  try {
    const fd = fs.openSync(logFile, 'r')
    try {
      const st = fs.fstatSync(fd)
      const age = nowMs - st.mtimeMs
      if (age > COMPOSITION_STALE_MS) return { verify: 'SKIP', detail: `no fresh composition line (server.log last written ${Math.round(age / 1000)}s ago)` }
      const len = Math.min(st.size, 256 * 1024) // tail only — never the whole log
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, st.size - len)
      line = buf.toString('utf-8').split('\n').filter(l => l.includes('alcore: composition:')).pop() ?? null
    } finally { fs.closeSync(fd) }
  } catch { return { verify: 'SKIP', detail: 'server.log absent or unreadable' } }
  // Age the LINE, not the file: any log line refreshes the mtime, so a dead composition chore on a
  // still-logging server would otherwise pass stale numbers. Every server.log line starts with its
  // own wall-clock stamp (log_ts), so the line carries its time and no server.pid is needed.
  const stamp = line ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)([+-]\d\d)(\d\d)/.exec(line) : null
  if (line && !stamp) return { verify: 'SKIP', detail: `composition line has no timestamp: ${line.slice(-200)}` }
  if (stamp) {
    const lineAge = nowMs - Date.parse(`${stamp[1]}${stamp[2]}:${stamp[3]}`)
    if (!(lineAge <= COMPOSITION_STALE_MS)) return { verify: 'SKIP', detail: `no fresh composition line (newest composition line is ${Math.round(lineAge / 1000)}s old)` }
  }
  const c = checkCompositionLine(line)
  if (c.verdict === 'WARN') return { verify: 'SKIP', detail: `composition line unparseable: ${(line ?? '').slice(-200)}` }
  if (c.verdict === 'SKIP') return { verify: 'SKIP', detail: c.detail }
  return { verify: 'PASS', detail: c.verdict === 'PASS' ? c.detail : `${c.verdict}: ${c.detail}` }
}

const stepMemoryCheck: StepDef = {
  name: 'memory-check',
  async run(ctx) {
    if (ctx.dryRun) {
      return { result: { step: this.name, found: 'server.log', action: 'would: check last composition line (live + free-in-page ≈ committed)', verify: 'SKIP', detail: 'dry-run' }, acted: false }
    }
    const c = memoryCheckFromLog(path.join(ctx.dataDir, 'server.log'))
    return { result: { step: this.name, found: 'server.log', action: 'composition line check', verify: c.verify, detail: c.detail }, acted: false }
  },
}

// ── Detection banner (read-only first pass) ─────────────────────────────────────────────────

function printDetection(ctx: Ctx): void {
  const lines: string[] = ['agentlenspro setup — detection (read-only)']
  const binPath = resolveOnPath(CLI_BIN, ctx.pathEnv)
  let binDesc = 'NOT on PATH'
  if (binPath) {
    let real = binPath
    try { real = fs.realpathSync(binPath) } catch { /* dangling symlink — report the link */ }
    const kind = real.includes('node_modules') ? (real === binPath ? 'npm -g' : 'npm link/global') : 'other'
    binDesc = `${binPath} → ${real} (${kind})`
  }
  lines.push(`  bin:      ${binDesc}`)
  const state = readSettingsFresh(ctx.settingsPath)
  if (state === 'unparseable') lines.push(`  settings: ${ctx.settingsPath} — NOT PARSEABLE (setup will refuse to write)`)
  else if (state === 'absent') lines.push(`  settings: ${ctx.settingsPath} — absent (will be created)`)
  else {
    const allHooks = Object.values(settingsHooks(state)).flat().flatMap(m => m.hooks ?? [])
    const ours = allHooks.filter(h => isOurHookCommand(h.command)).length
    const stale = allHooks.filter(h => isStaleGeneration(h.command)).length
    lines.push(`  settings: ${ours} agentlens hook entr${ours === 1 ? 'y' : 'ies'} (${stale} stale generation(s))`)
  }
  lines.push(`  data:     ${ctx.dataDir} — ${fs.existsSync(ctx.dataDir) ? `${storeSpanCount(ctx.dataDir)} stored span(s)` : 'absent'}`)
  lines.push(`  ports:    ui:${ctx.uiPort} mcp:${ctx.mcpPort} otlp:${ctx.otlpPort}`)
  for (const l of lines) ctx.log(l)
}

// ── Runner ──────────────────────────────────────────────────────────────────────────────────

// stepOtel runs BEFORE hooks and skills: the telemetry verdict comes first, so a foreign setup stops the run
// before anything else is installed (owner order 2026-10-02; the same order as autoSetup.ensureInstalled).
const STEPS: StepDef[] = [stepEnvironment, stepData, stepSpoolMigration, stepOtel, stepHooks, stepSkill, stepOldPackage, stepServerGuarded, stepSelfTest, stepMemoryCheck]

/** The three steps the auto-launch path may run on their own (autoSetup.ts) — a partial repair must
 *  not start the server or run the self-test, which is what a full runSetup would do. */
export const REPAIR_STEPS = { hooks: stepHooks, skill: stepSkill, 'otel-env': stepOtel } as const

/** Full hook drift list, per event: what differs (timeout old→new, command form, missing). Read-only. */
export function hookDriftList(settingsPath: string): Array<{ event: string; problem: string }> {
  const s = readSettingsFresh(settingsPath)
  if (s === 'unparseable') return [{ event: '*', problem: 'settings.json is not parseable' }]
  const hooks = settingsHooks(s === 'absent' ? {} : s)
  const out: Array<{ event: string; problem: string }> = []
  const events = new Set([...Object.keys(hooks), ...INSTALLED_EVENTS])
  for (const ev of events) {
    const matchers = Array.isArray(hooks[ev]) ? hooks[ev] : []
    const r = rebuildEventMatchers(matchers, ev, false, HOOK_CMD, GATE_CMD, REVIEW_CMD)
    if (JSON.stringify(r.rebuilt) === JSON.stringify(matchers)) continue
    const ours = matchers.flatMap(m => m.hooks ?? []).filter(h => isOurHookCommand(h.command))
    if (ours.length === 0) { out.push({ event: ev, problem: 'missing: no agentlenspro registration' }); continue }
    let any = false
    for (const h of ours) {
      if (h.timeout !== undefined && h.timeout !== HOOK_TIMEOUT_SEC) { out.push({ event: ev, problem: `timeout ${h.timeout} → ${HOOK_TIMEOUT_SEC} (${h.command})` }); any = true }
    }
    for (const c of r.removedCommands) if (isStaleGeneration(c)) { out.push({ event: ev, problem: `command form: ${c} → current` }); any = true }
    if (!any) out.push({ event: ev, problem: 'registration shape differs (matcher / duplicates / ordering)' })
  }
  return out
}

/** The `--json` document piece for otel-env: per-key verdict with redacted file/env values and would-write. */
function verdictDocument(ctx: Ctx): unknown {
  const d = otelDrift(ctx)
  if (d === 'unparseable') return { error: 'settings.json unparseable' }
  const s = readSettingsFresh(ctx.settingsPath)
  const fileEnv = (s !== 'absent' && s !== 'unparseable' && s.env && typeof s.env === 'object' ? s.env : {}) as Record<string, unknown>
  const procEnv = ctx.telemetryProbe.processEnv ?? process.env
  const val = (v: unknown, key: string): string | null => (v === undefined ? null : shownValue(key, String(v)))
  return d.rows.map(r => ({
    key: r.key, verdict: r.state, scope: r.scope, source: r.source, detail: r.detail,
    fileValue: val(fileEnv[r.key], r.key), envValue: val(procEnv[r.key], r.key),
    wouldWrite: r.scope === 'user' && (r.state === 'ABSENT' || r.state === 'CONVERGE') ? shownValue(r.key, d.expected[r.key] ?? '') : null,
  }))
}

export async function runSetup(opts: SetupOptions = {}): Promise<SetupOutcome> {
  if (opts.json) opts = { ...opts, log: () => { /* --json: stdout carries ONE document only */ } }
  const ctx = resolveCtx(opts)
  // The documents describe what was FOUND, so they are computed before any step can change it.
  const found = opts.json ? { verdict: verdictDocument(ctx), hooks: hookDriftList(ctx.settingsPath) } : null
  if (!opts.json) printDetection(ctx)

  const rows: StepResult[] = []
  let actions = 0
  let failed = false
  for (const step of STEPS) {
    if (failed) {
      rows.push({ step: step.name, found: '—', action: 'not run', verify: 'SKIP', detail: 'earlier step failed (fail-fast)' })
      continue
    }
    let r: { result: StepResult; acted: boolean }
    try {
      r = await step.run(ctx)
    } catch (e) {
      // An ACT/VERIFY exception is a step failure, never a silent continue.
      r = { result: { step: step.name, found: 'error', action: 'aborted', verify: 'FAIL', detail: (e as Error).message.slice(0, 160) }, acted: true }
    }
    rows.push(r.result)
    if (r.acted) actions++
    if (r.result.verify === 'FAIL') failed = true
  }

  ctx.log('')
  ctx.log(renderTable(rows))
  ctx.log(ctx.dryRun
    ? `dry-run: ${rows.filter(r => r.action.startsWith('would:')).length} step(s) would act — nothing was changed`
    : `${actions} step(s) acted, ${rows.filter(r => r.verify === 'PASS').length} verified PASS${failed ? ' — SETUP FAILED' : ''}`)
  // A dry-run that would refuse on a FOREIGN telemetry verdict must not read as a pass to a scripted deploy gate:
  // it still mutates nothing, but exits EXIT.CONFIG (STALE-ENV alone stays 0).
  const dryForeign = ctx.dryRun && rows.some(r => r.step === 'otel-env' && r.action.startsWith('would: refuse'))
  const exitCode = failed ? 1 : dryForeign ? EXIT.CONFIG : 0
  const json = found ? { dryRun: ctx.dryRun, exitCode, steps: rows, telemetryVerdict: found.verdict, hookDrift: found.hooks } : undefined
  return { exitCode, steps: rows, actions, serverPid: ctx.serverPid, json }
}

/** argv entry for `agentlenspro setup [--dry-run] [--yes]`. */
export async function runSetupCli(argv: string[], forceInstall = false): Promise<number> {
  const known = new Set(['--dry-run', '--yes', '--json'])
  const unknown = argv.filter(a => !known.has(a))
  // UsageError, not Error: a plain Error maps to exit 1 (the watchers' ABORT signal), and a typo'd
  // flag must read as 64 (bad command line) like every other management verb — TRDD-PIB6T4RU.
  if (unknown.length) throw new UsageError(`setup does not understand: ${unknown.join(' ')} (flags: --dry-run --yes --json)`)
  const json = argv.includes('--json')
  const outcome = await runSetup({ dryRun: argv.includes('--dry-run'), yes: argv.includes('--yes'), forceInstall, json })
  if (json) console.log(JSON.stringify(outcome.json, null, 2))
  return outcome.exitCode
}
