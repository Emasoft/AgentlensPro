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
import { UsageError } from './cliErrors'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { loadSqlJs } from '../forensicsDb'
import { countNdjsonLinesAuto } from '../ndjsonLines'
import { readFsMarkers } from '../environment/runtime'
import { ensureTelemetryConfig, ownedTelemetryKeys } from '../telemetryConfig'
import { rawBodyCaptureEnabled, effectiveBodiesDir, RAW_BODIES_KEY } from '../captureConfig'
import { sleep } from './cliCore'
import {
  CLI_BIN, GATE_CMD, GATE_EVENTS, GATE_MATCHER, HOOK_CMD, HOOK_EVENTS, HookMatcher,
  installHooks, installSkill, isOurHookCommand, rebuildEventMatchers, resolveOnPath,
  sha256File, SKILL_NAMES, findPackageRoot, skillTreeHash, installAgents, AGENT_NAMES,
} from './hookInstall'
import { findServerJs } from './serverControl'
import { parsePidLock } from '../serverRuntime'

export interface SetupOptions {
  dryRun?: boolean
  yes?: boolean
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
}

interface Ctx {
  dryRun: boolean
  yes: boolean
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

function resolveCtx(opts: SetupOptions): Ctx {
  const home = opts.home ?? os.homedir()
  const repoRoot = opts.repoRoot ?? findPackageRoot(__dirname)
  if (!repoRoot) throw new Error(`cannot locate the agentlenspro package root above ${__dirname}`)
  return {
    dryRun: !!opts.dryRun,
    yes: !!opts.yes,
    home,
    dataDir: opts.dataDir ?? process.env.DATA_DIR ?? path.join(home, '.agentlens'),
    settingsPath: opts.settingsPath ?? process.env.AGENTLENS_CLAUDE_SETTINGS ?? path.join(home, '.claude', 'settings.json'),
    skillsDir: opts.skillsDir ?? path.join(home, '.claude', 'skills'),
    agentsDir: opts.agentsDir ?? path.join(home, '.claude', 'agents'),
    repoRoot,
    uiPort: opts.uiPort ?? Number(process.env.UI_PORT ?? 3000),
    mcpPort: opts.mcpPort ?? Number(process.env.MCP_PORT ?? 4316),
    otlpPort: opts.otlpPort ?? Number(process.env.OTLP_PORT ?? 4318),
    pathEnv: opts.pathEnv ?? process.env.PATH ?? '',
    log: opts.log ?? ((line: string) => console.log(line)),
    serverPid: null,
  }
}

// ── Local transport bound to the ctx ports (cliCore reads env — setup must not) ────────────

function httpJson(port: number, method: string, p: string, payload?: unknown): Promise<{ status: number; json: unknown }> {
  const body = payload === undefined ? null : JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, res => {
      let raw = ''
      res.on('data', (c: Buffer) => { raw += c })
      res.on('end', () => {
        let json: unknown = null
        try { json = JSON.parse(raw) } catch { /* non-JSON body (e.g. the dashboard HTML) */ }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('timeout')))
    if (body) req.write(body)
    req.end()
  })
}

async function mcpCall(port: number, method: string, params: unknown): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  return new Promise((resolve, reject) => {
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
      res.on('end', () => {
        const line = raw.split('\n').find(l => l.startsWith('data:'))
        const payload = line ? line.slice(5).trim() : raw
        try {
          const j = JSON.parse(payload) as { error?: { message?: string }; result?: unknown }
          if (j.error) return reject(new Error(j.error.message || 'rpc error'))
          resolve(j.result)
        } catch { reject(new Error(`bad MCP response (${res.statusCode}): ${raw.slice(0, 200)}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')))
    req.write(body)
    req.end()
  })
}

interface StatsShape {
  pid: number
  dataDir: string
  ports: { ui: number; mcp: number; otlp: number }
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

function readSettingsFresh(file: string): Settings | 'absent' | 'unparseable' {
  if (!fs.existsSync(file)) return 'absent'
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Settings } catch { return 'unparseable' }
}

function settingsHooks(s: Settings): Record<string, HookMatcher[]> {
  return (s.hooks && typeof s.hooks === 'object' ? s.hooks : {}) as Record<string, HookMatcher[]>
}

/** Would installHooks change anything? Mirrors the installer's change detection without writing. */
function hooksConverged(s: Settings): boolean {
  const hooks = settingsHooks(s)
  const events = new Set([...Object.keys(hooks), ...HOOK_EVENTS, ...GATE_EVENTS])
  for (const ev of events) {
    const matchers = Array.isArray(hooks[ev]) ? hooks[ev] : []
    const r = rebuildEventMatchers(matchers, ev, false, HOOK_CMD, GATE_CMD)
    if (JSON.stringify(r.rebuilt) !== JSON.stringify(matchers)) return false
  }
  const env = s.env as Record<string, unknown> | undefined
  if (env && env.SPYGLASS_DIR !== undefined) return false
  return true
}

/** Independent post-install assertion: exactly one v2 entry per event, zero stale entries. */
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
  for (const [ev, matchers] of Object.entries(hooks)) {
    for (const m of matchers ?? []) {
      for (const h of m.hooks ?? []) {
        if (isOurHookCommand(h.command) && h.command !== HOOK_CMD && h.command !== GATE_CMD) {
          return `${ev}: stale previous-generation registration survived: ${h.command}`
        }
      }
    }
  }
  return null
}

/** Execute a registered hook command string with a synthetic stdin payload — the strongest
 *  possible verify: the EXACT string the hook runner will exec, resolved through the same
 *  PATH. Returns null on contract compliance (exit 0), else the violation. */
function execRegisteredCommand(ctx: Ctx, command: string, payload: string, expectSilent: boolean): string | null {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: ctx.pathEnv,
    AGENTLENS_UI_URL: `http://127.0.0.1:${ctx.uiPort}`,
    AGENTLENS_HOOK_TIMEOUT: '2',
    AGENTLENS_GATE_TIMEOUT: '2',
  }
  delete env.AGENTLENS_GATE // an ambient kill-switch would make the gate exec vacuous
  const r = spawnSync('/bin/sh', ['-c', command], { input: payload, env, encoding: 'utf8', timeout: 15_000 })
  if (r.error) return `spawn failed: ${r.error.message}`
  if (r.status !== 0) return `exit ${r.status} (must always exit 0): ${(r.stderr || '').slice(0, 120)}`
  if (expectSilent && r.stdout !== '') return `must print nothing, got: ${r.stdout.slice(0, 120)}`
  return null
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
  // Foreign-process heuristic: OTLP port answers ⇒ occupied; ours iff the paired UI port serves
  // /api/server-stats. A foreign OTLP squatter would silently eat every span the hooks emit.
  let otlpBusy = false
  try { await httpJson(ctx.otlpPort, 'GET', '/'); otlpBusy = true } catch { otlpBusy = false }
  let uiIsOurs = false
  if (otlpBusy) {
    try { uiIsOurs = (await httpJson(ctx.uiPort, 'GET', '/api/server-stats')).status === 200 } catch { uiIsOurs = false }
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
  if (facts.otlpPortBusyForeign) warns.push('OTLP port answers but the UI port is not our server — a foreign process may be squatting the collector port')
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
      .filter(h => isOurHookCommand(h.command) && h.command !== HOOK_CMD && h.command !== GATE_CMD).length
    const found = state === 'absent'
      ? 'no settings.json'
      : converged ? 'registrations current' : `needs converge (${staleCount} stale/legacy entr${staleCount === 1 ? 'y' : 'ies'})`

    if (ctx.dryRun) {
      return {
        result: {
          step: this.name, found,
          action: converged ? 'none' : `would: register '${HOOK_CMD}' + '${GATE_CMD}' via safeConfigEdit`,
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
      return {
        name, src: path.join(src, 'SKILL.md'), dst, srcExists: srcHash !== null,
        srcHash,
        dstHash: skillTreeHash(dst),
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
    const bad = skills.filter(s => skillTreeHash(s.dst) !== s.srcHash)
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

const stepOtel: StepDef = {
  name: 'otel-env',
  async run(ctx) {
    const markerPath = path.join(ctx.dataDir, 'telemetry-managed.json')
    // Raw-body capture is opt-in (TRDD-BKF5NZD3). Resolve it ONCE and feed the SAME value to both
    // the expected-table and ensure(), or setup's verify would demand a key ensure deliberately
    // deleted (or vice-versa) and the repairer would fight itself on every run.
    const captureRawBodies = rawBodyCaptureEnabled(ctx.dataDir, process.env)
    // Same ONE bodies-dir resolution as ensure()'s default (spool when capture is on) — a
    // hard-coded legacy path here made setup's verify/repair fight the spool-aware CLI writer.
    const bodiesDir = effectiveBodiesDir(ctx.dataDir, captureRawBodies)
    const expected = ownedTelemetryKeys(bodiesDir, ctx.otlpPort, captureRawBodies)
    const state = readSettingsFresh(ctx.settingsPath)
    if (state === 'unparseable') {
      return { result: { step: this.name, found: 'settings.json unparseable', action: 'refused', verify: 'FAIL', detail: 'fix the file manually, then re-run setup' }, acted: false }
    }
    const env = (state !== 'absent' && state.env && typeof state.env === 'object' ? state.env : {}) as Record<string, unknown>
    const missing = Object.keys(expected).filter(k => env[k] === undefined)
    const wrong = Object.keys(expected).filter(k => env[k] !== undefined && env[k] !== expected[k])
    // A LEFTOVER capture key is drift too — and the kind that costs ~35 GB/day. Without this,
    // `converged` would be true (the key simply isn't in `expected`), setup would skip ensure(), and
    // the repairer would happily report a healthy install while the burn kept running.
    // PRESENCE, not a value match. When capture is off the key must be ABSENT, so any value is
    // stale. Comparing against `file:${bodiesDir}` only caught the key when it happened to point
    // at today's resolved dir — a user who had capture on with a different bodies dir, then turned
    // it off, kept a live key Claude Code still honours: ~35 GB/day of raw bodies still being
    // written while setup reported converged/PASS. That is the exact burn the kill-switch exists
    // for, hidden by the tool meant to detect it.
    const staleCapture = !captureRawBodies && env[RAW_BODIES_KEY] !== undefined
    const converged = missing.length === 0 && wrong.length === 0 && !staleCapture
    const found = converged
      ? 'telemetry env current'
      : `${missing.length} missing, ${wrong.length} wrong key(s)${staleCapture ? ', raw-body capture to remove' : ''}`

    if (ctx.dryRun) {
      return { result: { step: this.name, found, action: converged ? 'none' : 'would: wire telemetry env (verified transaction)', verify: 'SKIP', detail: 'dry-run' }, acted: false }
    }
    let acted = false
    if (!converged) {
      await ensureTelemetryConfig({ settingsPath: ctx.settingsPath, markerPath, bodiesDir, otlpPort: ctx.otlpPort, dataDir: ctx.dataDir, captureRawBodies })
      acted = true
    }
    // VERIFY — independent re-parse; every owned key must hold exactly the expected value, and the
    // opted-out capture key must be GONE (verifying only what we wrote would miss what we failed to
    // delete — the whole defect this TRDD fixes).
    const after = readSettingsFresh(ctx.settingsPath)
    if (after === 'absent' || after === 'unparseable') {
      return { result: { step: this.name, found, action: acted ? 'wired' : 'none', verify: 'FAIL', detail: `post-state ${after}` }, acted }
    }
    const envAfter = (after.env && typeof after.env === 'object' ? after.env : {}) as Record<string, unknown>
    const bad = Object.keys(expected).find(k => envAfter[k] !== expected[k])
    // Same presence test as the detection above — a verify that is laxer than its detection can
    // confirm a repair that did not happen.
    const stillStale = !captureRawBodies && envAfter[RAW_BODIES_KEY] !== undefined
    const verifyFail = bad ?? (stillStale ? RAW_BODIES_KEY : undefined)
    return {
      result: {
        step: this.name, found, action: acted ? 'wired' : 'none',
        verify: verifyFail ? 'FAIL' : 'PASS',
        detail: bad
          ? `${bad} = ${JSON.stringify(envAfter[bad])} (expected ${JSON.stringify(expected[bad])})`
          : stillStale
            ? `${RAW_BODIES_KEY} still set (capture is off — it must be absent)`
            : `${Object.keys(expected).length} key(s) exact${captureRawBodies ? '' : '; raw-body capture off'}`,
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

const stepServer: StepDef = {
  name: 'server',
  async run(ctx) {
    const pre = await serverStats(ctx)
    // A failed stats probe is NOT proof the server is down — a busy server (GC-thrashing at
    // multi-GB rss) can miss the 5s HTTP window while very much owning the data directory.
    // Measured live: `setup --dry-run` printed "not running" against a server that `server
    // status` showed RUNNING, because its stats answer was slow. Collapsing that timeout into
    // "not running" is worse than cosmetic: the real-run remedy for "not running" is SPAWNING,
    // which slams into the single-owner data-dir guard and reports a confusing failure. So when
    // HTTP says nothing, consult the pidfile under ctx.dataDir (kill(pid, 0) = liveness): an
    // alive owner means "unresponsive — restart", never "absent — start".
    let stalePid: number | null = null
    if (pre === null) {
      try {
        // TRDD-PIDFILEAT: parsePidLock understands both the current JSON {pid,start} lock shape and
        // the legacy bare-numeric one — a plain Number(...) on the JSON shape reads NaN and would
        // silently misclassify every up-to-date install as "not running".
        const lock = parsePidLock(fs.readFileSync(path.join(ctx.dataDir, 'server.pid'), 'utf-8'))
        if (lock !== null) {
          const pid = lock.pid
          process.kill(pid, 0)
          // PID-REUSE GUARD (PR-15 review): kill(pid, 0) proves SOME process is alive, not that
          // it is OUR server — the OS reuses pids, and the real-run path SIGTERMs this number.
          // Only claim the pid when its command line looks like an AgentlensPro server; anything
          // else means the pidfile is stale and the honest classification is "not running" (a
          // wrongly-spared real server is still protected by its own single-owner boot guard,
          // which refuses the duplicate spawn cleanly — the safe failure direction).
          const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='],
            { encoding: 'utf-8', timeout: 5_000 }).trim()
          if (/standalone[/\\]server\.js|agentlenspro/.test(cmd)) stalePid = pid
        }
      } catch { /* no pidfile, a dead pid, or ps failed — genuinely not running */ }
    }
    const preSpanCount = pre?.spans?.store?.totalSpans ?? storeSpanCount(ctx.dataDir)
    const healthy = pre !== null
      && path.resolve(pre.dataDir) === path.resolve(ctx.dataDir)
      && pre.ports.ui === ctx.uiPort && pre.ports.mcp === ctx.mcpPort && pre.ports.otlp === ctx.otlpPort
    const found = pre
      ? `running pid=${pre.pid} (dataDir ${pre.dataDir === ctx.dataDir ? 'matches' : 'MISMATCH'})`
      : stalePid !== null
        ? `unresponsive (pid ${stalePid} alive, stats probe got no answer in 5s)`
        : 'not running'

    if (ctx.dryRun) {
      return { result: { step: this.name, found, action: healthy ? 'none' : (pre !== null || stalePid !== null ? 'would: graceful restart from this install' : 'would: start server'), verify: 'SKIP', detail: 'dry-run' }, acted: false }
    }
    if (healthy) {
      ctx.serverPid = pre.pid
      return { result: { step: this.name, found, action: 'none', verify: 'PASS', detail: `dashboard+MCP+OTLP already serving ${preSpanCount} span(s)` }, acted: false }
    }

    // ACT — graceful stop of a mismatched/old/unresponsive server (SIGTERM = span-flush), then
    // start from THIS install's bundle. The unresponsive case uses the pidfile pid: skipping the
    // stop and going straight to spawn would hit the single-owner guard.
    const stopPid = pre?.pid ?? stalePid
    if (stopPid !== null && stopPid !== undefined) {
      try { process.kill(stopPid, 'SIGTERM') } catch { /* already gone */ }
      const gone = async (): Promise<boolean> =>
        (await serverStats(ctx)) === null && (() => { try { process.kill(stopPid, 0); return false } catch { return true } })()
      for (let i = 0; i < 40 && !(await gone()); i++) await sleep(250)
      if (!(await gone())) {
        return { result: { step: this.name, found, action: 'stop old server', verify: 'FAIL', detail: `pid ${stopPid} did not stop within 10s` }, acted: true }
      }
    }
    // The kill-switch gates EVERY spawn path, including setup (TRDD-K3WDPR7M): this was the one
    // spawn site with no guard, discovered when a server booted minutes after `agentlenspro
    // disable`. The server now also refuses at its own boot — this check just makes setup report
    // the refusal honestly instead of spawning a child that immediately exits 78.
    if (agentlensDisabled()) {
      return { result: { step: this.name, found, action: 'start server', verify: 'FAIL', detail: 'AgentlensPro is DISABLED — run `agentlenspro enable` first' }, acted: false }
    }
    // The NO_REVIVE brake refuses this spawn too: `setup` is idempotent and re-run casually, so a
    // silent override here would resurrect a server mid store-swap exactly like the hook path did
    // (TRDD-8VGQK9L9). Reported, not skipped — a setup step that quietly does nothing looks healthy.
    // Sits BELOW the graceful stop of a mismatched/unresponsive server on purpose, beside the
    // DISABLED gate: the brake forbids a SPAWN, not a stop, and "braked ⇒ no server" is the state
    // an operator armed it for — leaving a stale server up would be the surprising outcome.
    if (reviveBraked()) {
      return { result: { step: this.name, found, action: 'start server', verify: 'FAIL', detail: `revive brake is set (${noRevivePath()}) — \`agentlenspro server start\` clears it` }, acted: false }
    }
    const serverJs = findServerJs()
    fs.mkdirSync(ctx.dataDir, { recursive: true })
    const logFile = path.join(ctx.dataDir, 'server.log')
    let outFd: number | 'ignore'
    try { outFd = fs.openSync(logFile, 'a') } catch { outFd = 'ignore' }
    const child = spawn(process.execPath, ['--max-old-space-size=6144', serverJs], {
      cwd: path.dirname(path.dirname(serverJs)),
      detached: true,
      stdio: ['ignore', outFd, outFd],
      env: {
        ...process.env,
        [STARTED_BY_ENV]: 'setup',  // boot-provenance stamp (TRDD-8VGQK9L9); found by sweep
        HOME: ctx.home,
        DATA_DIR: ctx.dataDir,
        UI_PORT: String(ctx.uiPort),
        MCP_PORT: String(ctx.mcpPort),
        OTLP_PORT: String(ctx.otlpPort),
        AGENTLENS_OPEN_BROWSER: '0', // setup verifies with HTTP probes; a browser popup is noise
      },
    })
    child.unref()
    if (typeof outFd === 'number') fs.closeSync(outFd)

    // VERIFY — through the network, never the child handle: dashboard 200, OTLP accepts,
    // pid is NEW, and the loaded span count did not shrink (data preservation assertion).
    let post: StatsShape | null = null
    for (let i = 0; i < 120; i++) { // up to 30s — DB open + first log scan can be slow
      await sleep(250)
      post = await serverStats(ctx)
      if (post) break
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
    for (let i = 0; i < 40 && !seen; i++) {
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
    const stale = allHooks.filter(h => isOurHookCommand(h.command) && h.command !== HOOK_CMD && h.command !== GATE_CMD).length
    lines.push(`  settings: ${ours} agentlens hook entr${ours === 1 ? 'y' : 'ies'} (${stale} stale generation(s))`)
  }
  lines.push(`  data:     ${ctx.dataDir} — ${fs.existsSync(ctx.dataDir) ? `${storeSpanCount(ctx.dataDir)} stored span(s)` : 'absent'}`)
  lines.push(`  ports:    ui:${ctx.uiPort} mcp:${ctx.mcpPort} otlp:${ctx.otlpPort}`)
  for (const l of lines) ctx.log(l)
}

// ── Runner ──────────────────────────────────────────────────────────────────────────────────

const STEPS: StepDef[] = [stepEnvironment, stepData, stepHooks, stepSkill, stepOtel, stepOldPackage, stepServer, stepSelfTest]

export async function runSetup(opts: SetupOptions = {}): Promise<SetupOutcome> {
  const ctx = resolveCtx(opts)
  printDetection(ctx)

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
  return { exitCode: failed ? 1 : 0, steps: rows, actions, serverPid: ctx.serverPid }
}

/** argv entry for `agentlenspro setup [--dry-run] [--yes]`. */
export async function runSetupCli(argv: string[]): Promise<number> {
  const known = new Set(['--dry-run', '--yes'])
  const unknown = argv.filter(a => !known.has(a))
  // UsageError, not Error: a plain Error maps to exit 1 (the watchers' ABORT signal), and a typo'd
  // flag must read as 64 (bad command line) like every other management verb — TRDD-PIB6T4RU.
  if (unknown.length) throw new UsageError(`setup does not understand: ${unknown.join(' ')} (flags: --dry-run --yes)`)
  const outcome = await runSetup({ dryRun: argv.includes('--dry-run'), yes: argv.includes('--yes') })
  return outcome.exitCode
}
