// src/cli/serverControl.ts — `agentlenspro server start|stop|restart|status [--supervise]`
// and `agentlenspro dashboard` (TRDD-7284WCW7). Absorbs scripts/agentlens-up.sh,
// scripts/agentlens-supervise.js and the --start-server/--stop-server/--status/--dashboard
// flag paths of the old agentlens-cli.js into the single executable.

import { spawn, execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { apiRequest, ApiRequestError, dataDir, dashboardUrl, envPort, fmtGb, fmtMb, init, mcpEndpoint, sleep, CONNECT_TIMEOUT_MS, PROBE_TIMEOUT_MS, STATUS_TIMEOUT_MS } from './cliCore'
import { dataDirSource, dataPath } from '../dataDir'
import { agentlensDisabled, noRevivePath, reviveBraked, STARTED_BY_ENV } from './killSwitch'
// resetReviveBackoff/reviveBackoffStatus (TRDD-JJLI6GEH) — a deliberate `server start`/`restart`
// must clear the hook-reviver's crash-loop backoff, or a counter from a past incident silently
// throttles an unrelated future one; `server status` surfaces an ACTIVE hold (FIX b2) — the gate's
// own hold message only ever reaches stderr from a hook Claude Code does not show the user, so
// without this a stalled revive was invisible short of reading server.log by hand. hookHandlers.ts
// imports alcoreBin/alcoreServeArgs/resolveBinNativeDir from THIS module, so this creates a cycle
// back to it — safe here because both are only ever CALLED at runtime (inside serverCommand /
// showStatus, below), never referenced at module-load time.
import { resetReviveBackoff, reviveBackoffStatus } from './hookHandlers'
import { UsageError } from './cliErrors'
import { assertKnownFlags } from './argHelpers'
import { parsePidLock } from '../serverRuntime'
import { chooseServerPorts, isPortFree, liveLockPid, portHolder, processAlive, readChosenPort, removePortsFile, writePortsFile } from './portSelect'
import { aldigestBin, ingestManifestPath, npmPlatformBin } from '../rustBinResolve'

/** Count of hook events durably spooled to disk but not yet reingested (server was down / shedding).
 *  Zero in the healthy case; a non-zero, non-shrinking value means the daemon isn't draining. */
export function hookSpoolDepth(): number {
  try {
    return fs.readdirSync(hookSpoolDirPath()).filter((n) => n.endsWith('.json')).length
  } catch (e) {
    // "No spool directory" genuinely means zero. Anything else — a permission denial, an I/O
    // error — is NOT zero, and reporting it as zero tells the operator "healthy, nothing pending"
    // while undelivered hooks pile up unread. Only ENOENT may answer 0.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw new Error(`cannot read the hook spool (${hookSpoolDirPath()}): ${(e as Error).message}`)
  }
}

/** Throws with a platform-specific, actionable message when `alcoreBin()` returned null because
 *  this platform has no prebuilt binary (bin-native/ exists but does not cover it — today only
 *  Windows, because rust-core does not build for windows-msvc: `pid_lock.rs` calls `libc::kill`
 *  with no `#[cfg(unix)]` guard). AgentlensPro no longer ships a TypeScript fallback (TRDD-1B98LCVR
 *  box 4), so a missing binary here is a hard stop, not a degraded mode. */
function noServerAvailableError(): Error {
  const platform = `${process.platform}-${process.arch}`
  return new Error(
    `No server available for ${platform}. AgentlensPro ships a Rust backend only ` +
    `(bin-native/<platform>-<arch>/alcore); ${platform} has no prebuilt binary. ` +
    `Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64. ` +
    'Set AGENTLENS_ALCORE to a binary you built yourself, or build one from a git checkout ' +
    '(`cargo build --release --manifest-path rust-core/Cargo.toml -p agentlens-core --bin alcore`).',
  )
}

/** The dashboard's built assets (`media/`), the dir alcore serves `/` from (TRDD-VHH7FXGC). Same
 *  layout walk as `cliJsPath`: the package root is one level up from the bundled cli.js but two
 *  up from out/cli/. Keyed on index.html, the one asset that is tracked source rather than a build
 *  output, so a checkout that has not run esbuild still resolves (and alcore then 404s the bundles
 *  loudly instead of refusing to boot). */
export function findMediaDir(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'media'),             // bundled: standalone/ · src/cli/ in-place
    path.resolve(__dirname, '..', '..', 'media'),       // out/cli/
    path.resolve(__dirname, '..', '..', '..', 'media'), // out/test/cli/
  ]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c
  }
  throw new Error(`media/index.html missing (looked near ${__dirname}) — the dashboard shell is tracked source; is this a complete checkout or install?`)
}

/** The `alcore` (Rust core) binary — the ONLY server this package ships (TRDD-1B98LCVR box 4;
 *  standalone/server.ts is deleted). Returns null only for a documented, non-fault gap: an
 *  unsupported `platformArch` (e.g. win32-x64, which rust-core does not build for) or a dev
 *  checkout / pruned install where `bin-native/` was never staged — a caller must treat either
 *  as "no server available here", never silently proceed.
 *
 *  Resolution order: `AGENTLENS_ALCORE` names the binary per-process and wins; otherwise
 *  `<dataDir>/bin/alcore` merely EXISTING is the opt-in for a locally-copied dev binary (presence
 *  is the only channel that survives a hook-revived daemon, which inherits no operator env — and
 *  the file is only there because someone copied it there, so presence cannot be an accident);
 *  otherwise the packaged `bin-native/<platform>-<arch>/alcore` this package ships (TRDD-EAK9R8IY),
 *  resolved via `npmPlatformBin`.
 *
 *  A THIRD case looks like the unsupported-platform gap but is not: `bin-native/` exists — this
 *  package DID ship binaries — yet this platform's file is missing or lost its exec bit in
 *  transit. That is a corrupt install, and folding it into the silent-null case is exactly how
 *  the live backend regressed to the (now-deleted) TS server with nobody noticing (the incident
 *  this three-way split exists to stop). So that case THROWS instead. `platformArch`/`baseDir`
 *  are injectable so tests can drive every branch without a real cross-platform install or a real
 *  corrupt one. */
/** `bin-native/` sits at the package root, one level up from `__dirname` in a bundled install
 *  (`standalone/cli.js`) or `src/cli/` compiled in-place — the layout `alcoreBin`'s default
 *  `baseDir` assumes. A REAL functional test that spawns a real server through `alcoreBin()`'s own
 *  default (rather than the unit-test injected `baseDir`) compiles several directories deeper
 *  (`out/test/cli/`), where that single-level default silently resolves to nowhere — callers doing
 *  that (setup.ts's real-server step) pass this instead. Deliberately NOT folded into `alcoreBin`'s
 *  own default: `alcoreCutover.test.ts`'s unit tests rely on the default staying "not found" under
 *  mocha so `baseDir` overrides are what makes each branch reachable — widening the default here
 *  would make it find the REAL project `bin-native/` and break that isolation. */
export function resolveBinNativeDir(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'bin-native'),
    path.resolve(__dirname, '..', '..', 'bin-native'),
    path.resolve(__dirname, '..', '..', '..', 'bin-native'),
  ]
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0]
}

export function alcoreBin(
  env: NodeJS.ProcessEnv = process.env,
  installed = dataPath('bin', 'alcore'),
  platformArch: string = `${process.platform}-${process.arch}`,
  baseDir: string = path.join(__dirname, '..', 'bin-native'),
): string | null {
  const v = env.AGENTLENS_ALCORE?.trim()
  if (v) return v
  try {
    if (fs.statSync(installed).isFile()) return installed
  } catch {
    // fall through to the npm platform package
  }
  const found = npmPlatformBin('alcore', platformArch, undefined, baseDir)
  if (found) return found
  // `found` is null — figure out WHY, without duplicating rustBinResolve's SHIPPED_TARGETS set
  // (which is not exported): probing with an `exists` that always answers "yes" makes
  // `npmPlatformBin` return null for ONE reason only — an unsupported platformArch.
  const platformShipped = npmPlatformBin('alcore', platformArch, () => true, baseDir) !== null
  if (!platformShipped) return null // documented gap — this platform has no server at all
  if (!fs.existsSync(baseDir)) return null // dev checkout / pruned install — nothing staged yet
  // bin-native/ EXISTS and this platform IS shipped, yet the real check still failed: the file is
  // missing or not executable. That is a corrupt/half-unpacked install, not a deliberate absence
  // — throw instead of silently returning null.
  throw new Error(
    `alcore binary for ${platformArch} is missing or not executable at ${path.join(baseDir, platformArch, 'alcore')}. ` +
    'bin-native/ exists, so this package DID ship binaries — this install is incomplete (a lost ' +
    'exec bit survives npm install and fails only at spawn). Repair: reinstall agentlenspro, or ' +
    'chmod +x the file, or set AGENTLENS_ALCORE to a working binary you built yourself.',
  )
}

const INGEST_SOURCE_NAMES = ['hooks', 'statusline', 'events', 'spans', 'bodies']
const warnedOnce = new Set<string>()
/** Test-only: forget which warnings were already printed. */
export function resetIngestWarnings(): void { warnedOnce.clear() }
/** alcoreServeArgs runs several times per command; print each distinct warning once per process. */
function warnOnce(msg: string): void {
  if (warnedOnce.has(msg)) return
  warnedOnce.add(msg)
  process.stderr.write(msg)
}

/** The alcore the server will start, or null. `alcoreBin` throws on a corrupt install (line ~137);
 *  this ONE catch exists because the caller resolves alcore itself right after and reports the real
 *  error, so the optional ingest path must neither change which error the user sees nor add one. */
function alcoreForIngest(env: NodeJS.ProcessEnv, installed: string): string | null {
  try { return alcoreBin(env, installed) } catch { return null }
}

/** The ingest flags for `alcore serve`, or [] (with a once-only stderr warning) when the opt-in
 *  cannot be honoured. Never throws. */
export function ingestArgs(env: NodeJS.ProcessEnv, alcore: string | null): string[] {
  const aldigest = alcore ? aldigestBin(env, alcore) : null
  const manifest = alcore ? ingestManifestPath(env, alcore) : null
  const missing = [alcore ? '' : 'alcore binary', alcore && !aldigest ? 'aldigest binary' : '', alcore && !manifest ? 'ingest schemas manifest' : ''].filter(Boolean)
  if (!alcore || !aldigest || !manifest) {
    warnOnce(`warning: AGENTLENS_INGEST=on but the ${missing.join(' and ')} could not be found; starting the server without the ingest path (set AGENTLENS_ALDIGEST_BIN / AGENTLENS_INGEST_MANIFEST)\n`)
    return []
  }
  const args = ['--ingest-manifest', manifest, '--aldigest-bin', aldigest]
  // Split, trim, drop empty items: " " or "hooks,,spans" must never reach alcore malformed; an empty list is unset.
  const names = (env.AGENTLENS_INGEST_SOURCES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (names.length) {
    if (names.every((n) => INGEST_SOURCE_NAMES.includes(n))) args.push('--ingest-sources', names.join(','))
    else warnOnce(`warning: AGENTLENS_INGEST_SOURCES=${JSON.stringify(env.AGENTLENS_INGEST_SOURCES)} is invalid; not passing --ingest-sources (valid names: ${INGEST_SOURCE_NAMES.join(', ')})\n`)
  }
  return args
}

/** `alcore serve` argv for the CUTOVER, which must bind the ports the rest of the product already
 *  assumes: with `MCP_PORT`/`UI_PORT` unset, `cliCore.mcpEndpoint` resolves :4316 and the dashboard
 *  :3000; every telemetry writer uses :4318. When they ARE set, both sides read them through the
 *  same `envPort` (TRDD-BSDR4TRM), so the CLI dials whatever this binds.
 *
 *  These are passed EXPLICITLY rather than by changing alcore's own defaults, and that is the
 *  point: alcore's own default ports (4319/3001/4317) are non-canonical by design, so it never
 *  collides with a caller who runs it unmanaged for local testing. The cutover is the caller's
 *  decision, so the cutover's ports are the caller's argument.
 *
 *  Empty-string env is treated as UNSET. `Number('')` is 0, so the `?? default` spelling in
 *  setup.ts:109-111 would bind port 0 (kernel-assigned, i.e. unreachable) for an exported-but-
 *  empty UI_PORT. Unifying those three spellings is worth doing, but it changes setup.ts's
 *  behaviour and belongs in its own diff, not in the cutover. */
export function alcoreServeArgs(env: NodeJS.ProcessEnv = process.env, dir: string = dataDir(), ports?: { otlp: number; ui: number; mcp: number }): string[] {
  // Unset env falls back to the ports the last `server start` bound (ports.json), so the spawn
  // paths that cannot probe (hook revive, setup) rebind what the clients already dial.
  const port = (raw: string | undefined, key: 'otlp' | 'ui' | 'mcp', fallback: number): string =>
    ports ? String(ports[key]) : envPort(raw, readChosenPort(dir, key) ?? fallback)
  const args = [
    'serve',
    '--data-dir', dir,
    // alcore refuses to boot without the dashboard assets (TRDD-VHH7FXGC).
    '--media-dir', findMediaDir(),
    '--otlp-port', port(env.OTLP_PORT, 'otlp', 4318),
    '--ui-port', port(env.UI_PORT, 'ui', 3000),
    '--mcp-port', port(env.MCP_PORT, 'mcp', 4316),
  ]
  // TRDD-RBBEX59R c2: the kill-switch is computed HERE, for `dir` — the exact dir this function passes as --data-dir —
  // and handed to alcore as --no-collection (the authoritative input; alcore's own read of <dir>/DISABLED is only a
  // backstop for an alcore started outside the CLI, and it never reads AGENTLENS_DISABLED). Every spawner (ensureServer,
  // the supervisor on every respawn, setup) builds its argv through this function, so a respawn after the switch is
  // lifted collects again. agentlensDisabled() honours the --force-install-telemetry env override (killSwitch.ts).
  if (agentlensDisabled(dir)) args.push('--no-collection')
  // The digest ingest path is OPT-IN (AGENTLENS_INGEST=on) and OFF by default: it is not yet the
  // system of record (the existing stores are), and its API-body capture is off by default because
  // of measured disk growth. When opted in but aldigest or the manifest cannot be resolved the
  // server still starts WITHOUT the ingest flags and warns on stderr: a missing optional binary
  // must never stop capture, which matches alcore booting with the tap disabled when
  // `aldigest register` fails.
  // AGENTLENS_INGEST_SOURCES is validated here (hooks, statusline, events, spans, bodies): alcore
  // exits with a usage error on a bad value and capture would stop, so a bad value is dropped with
  // a warning and the two ingest flags are still passed.
  // Each warning prints once per process: this function runs several times in one command.
  // The ingest branch looks next to the SAME alcore the server starts (alcoreBin), and a throw from
  // it (corrupt install) is swallowed in alcoreForIngest only, so this function adds no new throw.
  if (env.AGENTLENS_INGEST === 'on') args.push(...ingestArgs(env, alcoreForIngest(env, path.join(dir, 'bin', 'alcore'))))
  return args
}

/** Pick the ports for a fresh `alcore serve` (see chooseServerPorts) — a port held by OUR server
 *  (same data dir, per findServerPid) is kept. */
async function resolveServerPorts(env: NodeJS.ProcessEnv): Promise<{ otlp: number; ui: number; mcp: number }> {
  const ours = async (): Promise<boolean> => (await findServerPid().catch(() => null)) !== null
  // An explicitly set (valid) env port is PINNED: it never moves, a held one refuses the start.
  const pinned = (raw: string | undefined): boolean => envPort(raw, 0) !== '0'
  return chooseServerPorts(
    { otlp: Number(envPort(env.OTLP_PORT, 4318)), ui: Number(envPort(env.UI_PORT, 3000)), mcp: Number(envPort(env.MCP_PORT, 4316)) },
    { ui: pinned(env.UI_PORT), mcp: pinned(env.MCP_PORT) },
    ours,
  )
}

// Paths under the data dir, each named ONCE. They were built inline at several call sites, so a
// relocated store or a renamed file had to be found by grep rather than by following a symbol.
function serverLogPath(): string { return path.join(dataDir(), 'server.log') }
function pidfilePath(): string { return path.join(dataDir(), 'server.pid') }
// Renamed in TRDD-Z53IJFE9 step D: it is the HOOK-event spool's dir. The old name shared its
// "spool" prefix with the removed RAM-disk body spool, which muddied the spool-symbol sweep.
function hookSpoolDirPath(): string { return path.join(dataDir(), 'hook-spool') }

/** Heap cap for the server process. Named once: it appears in the direct spawn, the supervisor,
 *  and the launchd plist template, and three copies drift the moment one is tuned. */
export const DEFAULT_MAX_OLD_SPACE_MB = 6144

// TRDD-2JOIAH2G R1: alcore's mimalloc retains freed pages, so the heap plateaus (~3 GB) above the
// 2048 MB hard cap the guard kills on (mimalloc commit, since 2026-10-22). Spawn env is the ONLY reliable injection point:
// mimalloc reads options at its first allocation, which can run before main, so a
// std::env::set_var inside Rust main races and can be a no-op. Env name per the VENDORED allocator
// (libmimalloc-sys 0.1.49, no "v2" feature => mimalloc v3): the option is `mimalloc_purge_delay`
// — matched case-insensitively (prim/unix/prim.c _mi_prim_getenv), so MIMALLOC_PURGE_DELAY is
// read; there is no *_MSEC variant in v3 (that spelling predates the v2/v3 split). v3's default is
// already 1000 ms (options.c:140, arena_purge_mult=1) — the plateau was MEASURED at that default,
// so 1000 would be a no-op. 0ms = immediate purge; measured 100ms under-purges (kills at 9-42 min,
// mimalloc current 2.8-3.4GB at kill) while the 0ms control held 1.5GB for 22+ min; churn warning
// was hypothetical, no pathology measured at 0ms.
const ALCORE_MIMALLOC_PURGE_DELAY_MS = '0'
export { ALCORE_MIMALLOC_PURGE_DELAY_MS }

/** The started-by label of a hook revive. Log attribution greps it (TRDD-8VGQK9L9), so the OLD direct
 *  revive and the `server revive` chain must stamp the same string. */
export const REVIVE_STARTED_BY = 'hook-revive'

/** The env an alcore spawn gets — a pure function so a test can assert it. `baseEnv` carries whatever
 *  the caller was started with: a revive child inherits MIMALLOC_VERBOSE=1 from the hook
 *  (hookHandlers.reviveSpawnSpec), and it reaches alcore here through the spread, as it did when the
 *  hook spawned alcore directly. */
export function alcoreSpawnEnv(startedBy: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...baseEnv, [STARTED_BY_ENV]: startedBy, MIMALLOC_PURGE_DELAY: ALCORE_MIMALLOC_PURGE_DELAY_MS }
}

/** Start the standalone server if the MCP endpoint is unreachable; wait until it answers.
 *
 *  Under the GLOBAL kill-switch it STARTS the server, in no-collection mode (TRDD-RBBEX59R c2):
 *  alcoreServeArgs adds --no-collection, so the server stores no telemetry, no raw bodies and no
 *  hook-event log while the burn gate and the image cache-guard keep answering. It used to refuse
 *  (2026-07-14: a disabled install came back through the diagnostics path), which also left the
 *  guards off; the NO_REVIVE brake below is now what keeps a server from starting.
 *
 *  `startedBy` names the PATH that reached this function, for the server's boot-provenance line
 *  (TRDD-8VGQK9L9). This function cannot know it by itself — `server start`, `restart`, `dashboard`
 *  and the diagnostics `--start-server`/`--dashboard` globals all land here — so the caller says.
 *  The default is a truthful "unknown", never a guess: an unlabelled path in the log is a lead, a
 *  wrong label is a dead end. */
export async function ensureServer(startedBy = 'ensureServer:unknown', opts: { overrideBrake?: boolean; attempt?: number } = {}): Promise<void> {
  // No kill-switch refusal here any more (TRDD-RBBEX59R c2): under the switch this spawns alcore in
  // no-collection mode (alcoreServeArgs adds --no-collection), which stores nothing and keeps the
  // spawn guards fed. Owner order 2026-11-03: «keep the guards».
  try { await init(); return } catch { /* not up — start it */ }
  // THE BRAKE REFUSES THE SPAWN, NOT THE SERVER — hence BELOW the probe. `server stop --stay-down` arms this brake so an operator can swap the store with
  // nothing writing into it, and its message promises "hooks and the supervisor will not resurrect
  // the server"; until TRDD-8VGQK9L9 that held only for the supervisor, because THIS function never
  // consulted the brake and is reachable from `dashboard` (main.ts) and from the
  // `--start-server`/`--dashboard` GLOBAL flags in diagnosticsCli — so any ordinary diagnostics
  // command carrying one silently revived a braked server (measured: up 1h53m on the default data
  // dir, brake file still present).
  //
  // PLACEMENT IS THE FIX, and it was wrong in the first cut of this gate (caught in review before
  // it shipped): sitting ABOVE the probe, it threw whenever the brake was set even though a healthy
  // server was already answering. That prevents nothing — the writer the store was being protected
  // from is already running — while breaking every diagnostics call against it. (It also inherited
  // the old DISABLED gate's "cost nothing, not even a socket" rationale, which did not transfer.)
  //
  // NO_REVIVE ONLY, never the global kill-switch: since TRDD-RBBEX59R c2 the switch does not refuse a
  // start at all — the spawn below runs alcore in no-collection mode (alcoreServeArgs adds the flag).
  //
  // `overrideBrake` is passed ONLY by the explicit operator commands `server start`/`restart`, the
  // two that then clearReviveBrake() on success. Without it this gate made the brake un-liftable:
  // `start` ran ensureServer() first (so the spawn refused here) and clearReviveBrake() second
  // (never reached), while three messages told the operator to run exactly that command — caught
  // in ai_review, verified live (exit 1, NO_REVIVE still on disk). Every implicit spawner
  // (diagnostics --start-server/--dashboard, hooks, the supervisor, setup) leaves it unset.
  if (reviveBraked() && !opts.overrideBrake) {
    throw new Error(
      `the server revive brake is set (${noRevivePath()}) — refusing to START a server.\n` +
      '(An already-running server is still used; the brake only blocks starting a new one.)\n' +
      'Clear it with:  agentlenspro server start',
    )
  }
  // alcore is the only server this package ships (TRDD-1B98LCVR box 4) — a missing binary is a
  // hard stop, not a fallback to a TS bundle that no longer exists.
  const alcore = alcoreBin(process.env, undefined, undefined, resolveBinNativeDir())
  if (!alcore) throw noServerAvailableError()
  // stdout/stderr go to a log file, NOT /dev/null — when the server dies at boot (port
  // conflict, corrupt store) the reason must be readable, or every failure looks like
  // "did not become ready".
  // If the log cannot be opened we still start — but we REMEMBER why, because the old code sent
  // the streams to /dev/null and then told the user to "check server.log". They would find an
  // empty file and no reason, which is the one outcome the log exists to prevent.
  let outFd: number | 'ignore'
  let logProblem = ''
  try {
    fs.mkdirSync(dataDir(), { recursive: true })
    outFd = fs.openSync(serverLogPath(), 'a')
  } catch (e) {
    outFd = 'ignore'
    logProblem = ` (server output is being DISCARDED — ${serverLogPath()} could not be opened: ${(e as Error).message})`
  }
  // Where the shared log ends RIGHT NOW, before our child can append a byte. Everything after this
  // offset is ours; everything before it belongs to other processes and other days, and the log has
  // no timestamps to tell the reader which is which.
  const logStart = logSizeNow()
  // The child inherits our env PLUS the provenance stamp; the server logs it at boot next to the
  // brake state it observes, so "who started this server, and was the brake set?" is answered by
  // one grep of server.log instead of a day of inference (TRDD-8VGQK9L9). The mimalloc purge delay
  // rides here too (TRDD-2JOIAH2G R1) — alcore-spawn only, never a global override.
  const env = alcoreSpawnEnv(startedBy)
  // Owner rule 2026-10-02: never bind (or talk to) a port another process holds. Probe-then-bind is
  // a race, so a bind failure at boot (see the 'died' branch) re-picks ports, up to 3 attempts.
  const ports = await resolveServerPorts(process.env)
  // The wait loop below dials the MCP/UI URLs through cliCore, which only honours ports.json for a
  // LIVE pidfile owner and ports.json is written only after success — so point THIS process's
  // explicit-URL overrides at the ports we chose for the duration, and restore them on every exit.
  const savedUrls = { mcp: process.env.AGENTLENS_MCP_URL, ui: process.env.AGENTLENS_UI_URL }
  if (savedUrls.mcp === undefined) process.env.AGENTLENS_MCP_URL = `http://localhost:${ports.mcp}/mcp`
  if (savedUrls.ui === undefined) process.env.AGENTLENS_UI_URL = `http://localhost:${ports.ui}`
  try {
    const child = spawn(alcore, alcoreServeArgs(process.env, dataDir(), ports), { cwd: dataDir(), env, detached: true, stdio: ['ignore', outFd, outFd] })
    // Without this, an async spawn failure (EMFILE, EAGAIN) emits an unhandled 'error' event and the
    // process dies with a raw stack trace instead of the actionable message below.
    let spawnError: Error | null = null
    child.on('error', (err) => { spawnError = err })
    // Startup is O(store): opening the DB and running the first scan takes longer on the machines that
    // have used AgentlensPro the most. A FIXED 20 s budget therefore failed precisely there — observed
    // 2026-08-01 on a store of 2.89M spans, where the server came up and served correctly and the CLI
    // still announced "did not become ready", which reads as a failure. The operator then re-runs
    // `server start`, the single-owner guard correctly refuses it, and now the machine looks wedged.
    // So the wait is bounded by LIVENESS rather than by a guessed constant: keep waiting while the
    // process we started is alive, and give up IMMEDIATELY when it is not.
    let childExited = false
    child.on('exit', () => { childExited = true })
    child.unref()
    if (typeof outFd === 'number') fs.closeSync(outFd)
    const deadline = Date.now() + readyTimeoutMs()
    while (Date.now() < deadline) {
      await sleep(250)
      if (spawnError) throw new Error(`failed to spawn the server: ${(spawnError as Error).message}`)
      let answered = true
      try { await init() } catch { answered = false }
      if (!answered) {
        // findServerPid() is only consulted when our child is GONE: our spawn also exits, correctly,
        // whenever another server won the single-instance race — and that case is a success, not a death.
        const anotherServing = childExited ? await findServerPid().catch(() => null) !== null : false
        // findServerPid alone is NOT enough to recognize a lost race (TRDD-861LC4VW, second half,
        // observed live 2026-08-13 19:23): it only sees a server that already SERVES, but a race
        // winner spends seconds-to-minutes BOOTING first (first DB open is O(store)), during which
        // it answers nothing — so the loser's exit was declared 'died' and restart printed FAIL
        // while the winner came up healthy moments later. Our own child's scoped log names the
        // winner ("Refusing to start: another ... server (pid N) already owns"); a LIVE pid there
        // means the race was lost to a booting server: keep waiting for it to answer.
        const winner = childExited ? raceWinnerPid(logStart) : null
        const raceWinnerAlive = winner !== null && processAlive(winner)
        const verdict = startupVerdict({ answered, childExited, anotherServing, raceWinnerAlive, deadlinePassed: Date.now() >= deadline })
        if (verdict === 'died') {
          const tail = logTail(8, logStart)
          // alcore reports a lost bind race as "…already in use…" (its own MCP line, or the OS error text).
          const attempt = opts.attempt ?? 0
          if (/in use/i.test(tail) && attempt < 2) return ensureServer(startedBy, { ...opts, attempt: attempt + 1 })
          throw new Error(`the server exited during startup — it never answered.${logProblem}\n${tail}`)
        }
        continue // 'keep-waiting' — alive and still starting; 'timed-out' falls out of the loop below
      }
      // Report the pid that is actually SERVING, not the child we spawned. The two differ whenever
      // another process (a hook's ensureServer, a concurrent CLI) wins the single-instance race: our
      // child refuses the data dir and exits, and init() then succeeds against THEIRS. Printing
      // child.pid there names a process that is already dead, with the authority of a status line —
      // it cost a real debugging session, where `ps eww` on the reported pid showed none of the
      // environment we had just started the server with, because that was not the server.
      const serving = await findServerPid().catch(() => null)
      const who = serving === null || serving === child.pid
        ? `pid ${serving ?? child.pid}`
        : `pid ${serving} — an already-running server won the single-instance race; our spawn (${child.pid}) exited`
      // Persist the choice only now, and only when OUR child is the server (a race winner wrote its own).
      if (serving === null || serving === child.pid) writePortsFile(dataDir(), ports)
      console.log(`server started (${who}) — logs: ${serverLogPath()}`)
      return
    }
    // The budget is spent and the process is still alive: say exactly that. "Did not become ready"
    // reads as "it failed"; the truthful claim is that it has not answered YET, and the difference
    // decides whether the operator re-runs a start that will be refused or simply waits.
    const still = childExited ? 'the process we started has exited' : 'the server process is still alive'
    throw new Error(
      `the server has not answered within ${Math.round(readyTimeoutMs() / 1000)}s — ${still}. ` +
      'A large span store makes the first open slow; raise AGENTLENS_SERVER_READY_TIMEOUT_MS, or run ' +
      `\`agentlenspro server status\` in a moment to see whether it came up on its own.${logProblem}\n${logTail(8, logStart)}`,
    )
  } finally {
    if (savedUrls.mcp === undefined) delete process.env.AGENTLENS_MCP_URL
    if (savedUrls.ui === undefined) delete process.env.AGENTLENS_UI_URL
  }
}

/** What a start attempt should DO next, as a pure decision over the four things we can observe.
 *
 *  It is a named function because the original defect was a DECISION, not a duration: the code
 *  treated "has not answered within a fixed 20 s" as "failed", and on a large store that sentence is
 *  simply false — the server was up and serving. Naming the verdict makes the four cases testable and
 *  keeps them from drifting back into an implicit `for` bound.
 *
 *  `died` deliberately outranks `keep-waiting`: when our child is gone, nothing is serving, AND no
 *  live race winner is booting, the remaining budget can only delay a diagnosis the log already
 *  contains. `raceWinnerAlive` exists because `anotherServing` cannot see a winner that is still
 *  BOOTING (it probes the endpoint, and a first DB open is O(store)) — without it, losing the
 *  single-owner race to a concurrent hook's spawn read as a death and restart printed FAIL on a
 *  restart that was succeeding (TRDD-861LC4VW, observed live 2026-08-13). */
export type StartupVerdict = 'ready' | 'died' | 'keep-waiting' | 'timed-out'
export function startupVerdict(o: {
  answered: boolean; childExited: boolean; anotherServing: boolean; raceWinnerAlive: boolean; deadlinePassed: boolean
}): StartupVerdict {
  if (o.answered) return 'ready'
  if (o.childExited && !o.anotherServing && !o.raceWinnerAlive) return 'died'
  return o.deadlinePassed ? 'timed-out' : 'keep-waiting'
}

/** The pid of the server that WON the single-owner race against our own spawn, read from the bytes
 *  OUR attempt appended to server.log (the guard's refusal line names the winner: "Refusing to
 *  start: another AgentlensPro server (pid N) already owns"). Scoped by `fromOffset` for the same
 *  reason logTail is — the shared, timestampless log holds refusals from other eras, and quoting a
 *  historical winner as this attempt's would resurrect the exact confusion TRDD-861LC4VW documents.
 *  Null when our attempt wrote no refusal (a genuine death stays a death). */
export function raceWinnerPid(fromOffset: number): number | null {
  try {
    const fd = fs.openSync(serverLogPath(), 'r')
    try {
      const size = fs.fstatSync(fd).size
      if (fromOffset >= size) return null
      const len = size - fromOffset
      const buf = Buffer.allocUnsafe(len)
      fs.readSync(fd, buf, 0, len, fromOffset)
      const matches = [...buf.toString('utf8').matchAll(/Refusing to start: another AgentlensPro server \(pid (\d+)\) already owns/g)]
      if (matches.length === 0) return null
      const pid = Number(matches[matches.length - 1][1])
      return Number.isFinite(pid) && pid > 0 ? pid : null
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null // no log ⇒ no refusal evidence; the verdict falls back to the other signals
  }
}

/** How long to wait for a freshly-spawned server to answer. Generous by default because the wait is
 *  ALSO bounded by liveness (a dead child fails immediately), so a long ceiling costs nothing on the
 *  failure path — it only stops a slow-but-healthy start from being reported as a failure. */
export function readyTimeoutMs(): number {
  const raw = Number(process.env.AGENTLENS_SERVER_READY_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 180_000
}

/** Where the server log currently ends. Captured BEFORE a spawn so the tail we may print afterwards
 *  can be scoped to what THAT attempt wrote. A missing log yields 0, which is the correct floor:
 *  everything appended from then on is ours. */
export function logSizeNow(): number {
  try { return fs.statSync(serverLogPath()).size } catch { return 0 }
}

/** The tail of the server log — the reason a boot failure happened is already written there, and an
 *  error that says "check the log" without showing it makes the reader do the tool's job.
 *
 *  `fromOffset` is what keeps it HONEST, and it is not a micro-optimisation. server.log is ONE
 *  append-only file shared by every process that ever started a server for this data dir — every
 *  hook's ensureServer, every concurrent CLI — and it carries NO timestamps. So an unscoped tail
 *  quotes lines that are true, old, and someone else's, with the authority of a diagnosis of the
 *  command just run. Measured here: 29 accumulated "Refusing to start" blocks naming four different
 *  owner pids, where the last 8 lines straddle two unrelated eras. The inversion is the dangerous
 *  part — a refusal names the pid that WON ("another server (pid N) already owns this"), so a reader
 *  scanning the tail concludes N failed when N is the healthy server they are being protected by.
 *  Scoping to the bytes appended since our own spawn removes the entire class. */
export function logTail(lines = 8, fromOffset = 0): string {
  const p = serverLogPath()
  let fd: number | null = null
  try {
    fd = fs.openSync(p, 'r')
    const size = fs.fstatSync(fd).size
    // A log that SHRANK was rotated or truncated under us, so our offset now points into unrelated
    // bytes. Say that rather than quoting whatever happens to sit at that position.
    if (fromOffset > size) return `(${p} was rotated or truncated during startup — no tail for this attempt)`
    const nothing = fromOffset === 0 ? `(${p} is empty)` : `(this start attempt wrote nothing to ${p})`
    const len = size - fromOffset
    if (len === 0) return nothing
    const buf = Buffer.allocUnsafe(len)
    fs.readSync(fd, buf, 0, len, fromOffset)
    const tail = buf.toString('utf8').split('\n').filter(Boolean).slice(-lines)
    if (!tail.length) return nothing
    // Label the scope, because "last 8 lines" of a shared log and "last 8 lines this attempt wrote"
    // are different claims and the reader acts differently on each.
    const scope = fromOffset === 0 ? '' : ', this attempt only'
    return `--- ${p} (last ${tail.length} line(s)${scope}) ---\n${tail.join('\n')}`
  } catch (e) {
    return `(could not read ${p}: ${(e as Error).message})`
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* nothing left to close */ } }
  }
}

/** The pid of the server that owns THIS data dir — `dataDir()` — or null when none runs.
 *
 *  Data-dir FIRST (TRDD-BSDR4TRM). The old chain asked /api/server-stats before anything else, and
 *  that call dials the UI base URL, which has no relation to the data dir: from an isolated env
 *  (own DATA_DIR, overridden ports) it reached the LIVE server, so `server start` announced a lost
 *  race that never happened and `server stop` SIGTERMed the real collector. The lock the server
 *  writes at boot (`<dataDir>/server.pid`) is keyed on exactly the thing this function is asked
 *  about, so it is consulted first and decides whenever it names a live owner. The REST fallback
 *  (a build predating the pidfile, or a lock the server could not write) is accepted ONLY when the
 *  server it reaches reports the same data dir. There is no port-based rung any more: `lsof` on a
 *  port can never say whose data dir the listener owns, which is the question. */
export async function findServerPid(): Promise<number | null> {
  // The pidfile identity check lives in portSelect.liveLockPid (TRDD-PIDFILEAT: shares the server's own takeover rule).
  const owner = liveLockPid(dataDir())
  if (owner !== null) return owner
  try {
    // PROBE_TIMEOUT_MS: a foreign listener that accepts TCP but never answers HTTP must read as "not ours", not hang the port guard.
    const stats = await apiRequest('GET', '/api/server-stats', undefined, PROBE_TIMEOUT_MS) as { pid?: unknown; dataDir?: unknown }
    // Guard the conversion: a payload without `pid` yields NaN, and NaN is not null, so a downstream
    // `pid === null` check would pass it straight through to process.kill(NaN).
    const pid = Number(stats.pid)
    const sameDataDir = typeof stats.dataDir === 'string' && path.resolve(stats.dataDir) === path.resolve(dataDir())
    if (Number.isFinite(pid) && pid > 0 && sameDataDir) return pid
  } catch { /* down, or an older build — nothing owns this data dir that we can prove */ }
  return null
}

/** The lock holder `server stop` names in its "stuck behind" text: the FIRST line of `logText` that
 *  matches, or null. Reads the line alcore prints when its bounded stop wait expires —
 *  rust-core/crates/agentlens-core/src/bin/alcore.rs, format
 *  `<log_ts> alcore: stop timed out after <N> ms waiting on <holder> — skipping the flush, releasing the pid lock anyway`.
 *  The capture stops before the " — " tail, so the CLI prints only the holder (`<file>:<line> (holding for N ms)` or
 *  `unknown`; neither contains " — ", see shutdown.rs flush_with_deadline and the alcore.rs fallback).
 *  The `stop waiting on` alternative matches no line the current alcore emits; it is kept for an older deployed build.
 *  The CLI's "stuck behind" message depends on that line shape; keep alcore.rs and this regex in lockstep
 *  (TRDD-N60JUWU3). */
export function stopHolderFromLog(logText: string): string | null {
  const holderLine = logText.match(/alcore: stop (?:waiting on|timed out after \d+ ms waiting on) (.+?)(?: — .*)?$/m)
  return holderLine ? holderLine[1] : null
}

export async function stopServer(): Promise<void> {
  const pid = await findServerPid()
  if (pid === null) {
    console.log('server already stopped')
    return
  }
  // TRDD-N60JUWU3: the server's own stop budget defaults to 8s (AGENTLENS_STOP_LOCK_TIMEOUT_MS)
  // — this loop's 15s must stay comfortably above it, or a real timeout on the server side would
  // still read here as "did not stop", losing the holder name the server already logged.
  const logStart = logSizeNow()
  process.kill(pid, 'SIGTERM') // graceful — the server flushes every store on SIGTERM
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    // Confirm with the SAME data-dir-keyed resolver that chose the target. The old loop asked
    // `init()` — "is anything answering the MCP port?" — which is a different question: with a
    // foreign server on that port the CLI reported "did not stop within 10s" about a process it
    // had already killed, and with the port free but the target alive it would report success.
    if (await findServerPid() === null) {
      // ports.json describes THIS server's ports; once it is gone it must not outlive it.
      removePortsFile(dataDir())
      console.log(`server stopped (pid ${pid})`)
      return
    }
  }
  // Says PROCESS, deliberately. This loop now waits for the process to be gone, not for the MCP
  // port to stop accepting — the port closes early in shutdown, so the old wording could report
  // success while the server was still flushing. The honest consequence is that a big store
  // (the live collector's flush of ~1.8 GB) can legitimately outlast this budget: that is a slow
  // stop in progress, NOT the foreign-server bug this budget's message used to be confused with.
  // Name the lock holder if the server's own bounded-wait poll (TRDD-N60JUWU3) already logged
  // one for this attempt — scoped to bytes written since our own SIGTERM (logTail's fromOffset),
  // never a stale holder from an earlier, unrelated stop.
  const holder = stopHolderFromLog(logTail(40, logStart))
  const holderNote = holder !== null ? ` — stuck behind ${holder}` : ''
  throw new Error(`server (pid ${pid}) is still running 15s after SIGTERM${holderNote} — a large store can take longer to flush; watch it before escalating to SIGKILL (see server.log for "alcore: stop waiting on <holder>")`)
}

/** The capture-liveness line for `server status` (TRDD-0SA5QZTG).
 *
 *  Deliberately does NOT print "BROKEN" on age alone: a machine nobody is using captures nothing,
 *  and a status line that cries wolf on an idle host gets ignored on the day it matters. The one
 *  unambiguous case is a newest body OLDER THAN THIS PROCESS — the server has been up that entire
 *  time and captured nothing, which no amount of idleness explains.
 *
 *  `now` is a parameter so this is testable without waiting for wall-clock. */
/** `/api/server-stats` `bodies` — THE declaration (TRDD-FGN5TY7E). The emitter is the one `json!`
 *  block in `rust-core/.../server_stats.rs`; `tests/server_stats.rs` freezes the EMITTER's key set
 *  (a field dropped there goes red). It cannot see this interface, so a field added HERE without a
 *  producer is caught by nobody — keep the two in step by hand, and say so on the field (as the
 *  `reclaimedSinceBoot` comment does). */
export interface ServerStatsBodies {
  archive: { volumes: number; entries: number; bytes: number }
  lastPass: { removedFiles: number; keptBytes: number }
  // TRDD-C5L779YI: cumulative reclaim. Sent by alcore since TRDD-HDUETCU7; an older server omits
  // both, and absent is not zero, so the renderer still falls back to the legacy last-pass line,
  // never "0 since boot".
  reclaimedSinceBoot?: number
  lastNonZeroPassAt?: number
  // TRDD-5K0YLLEF: consecutive failed .pass-state.json saves (0 = healthy) and epoch ms of the last failed save (0 = never).
  // An older server omits both; absent is not zero, so stateSaveFailLine prints nothing for them.
  stateSaveFails?: number
  lastStateSaveFailAt?: number
  // TRDD-4FMHW124 / TRDD-U0L78B3Z: null = up. Absent is not "healthy", it is "not reported".
  captureDownSince?: number | null
  sinkProblem?: string | null
  // TRDD-0SA5QZTG: a server older than this omits it; the renderer must say "unknown", never "never".
  live?: { files: number; newestMs: number | null }
  // TRDD-8TM7I49X: null = pass state unreadable.
  parked?: { files: number; bytes: number; onDisk: number } | null
  // `spool` is also on the wire (TRDD-ZW4APOPI) but nothing here reads it — declare it when
  // something does; a half-typed unread field is the class this card exists to stop.
}

export function bodiesCaptureLine(
  // TRDD-FGN5TY7E: the ONE wire shape, not a second hand-copied subset — a subset here once
  // omitted `parked` while the interface omitted it too, and nothing noticed.
  s: { uptimeSec: number; bodies: Pick<ServerStatsBodies, 'live' | 'parked' | 'captureDownSince' | 'sinkProblem'> },
  now: number = Date.now(),
): string {
  // TRDD-4FMHW124: server-detected outage state. Rendered on every branch below — an empty live
  // dir with capture DOWN is precisely the pair that must not read as "idle".
  const down = s.bodies.captureDownSince
    ? ` | CAPTURE DOWN ${Math.max(1, Math.round((now - s.bodies.captureDownSince) / 60000))}m — sessions active, no bodies arriving (TRDD-4FMHW124)`
    : ''
  const sink = s.bodies.sinkProblem ? ` | SINK: ${s.bodies.sinkProblem}` : ''
  const live = s.bodies.live
  // A pre-TRDD-0SA5QZTG server omits the field entirely. Saying "never captured" there would be a
  // confident claim about something that was never measured.
  if (!live) return 'unknown (server predates capture reporting)'
  // TRDD-8TM7I49X: parked bodies are pinned FOREVER on a durable target, so this is a gauge and it
  // is appended to every branch below — including "NO BODIES", where an empty live dir alongside a
  // non-zero park is the single most diagnostic pair the line can print.
  const parked = parkedSuffix(s.bodies.parked)
  if (live.newestMs === null) return `NO BODIES on disk (${live.files} file(s)) — capture has never run, or the live dir was emptied${down}${sink}${parked}`
  const ageSec = Math.max(0, Math.round((now - live.newestMs) / 1000))
  const age = ageSec < 90 ? `${ageSec}s` : ageSec < 5400 ? `${Math.round(ageSec / 60)}m` : `${(ageSec / 3600).toFixed(1)}h`
  const stalled = ageSec > s.uptimeSec
  return `${live.files} live file(s), newest ${age} ago`
    + (stalled ? ` — STALLED: older than this server's ${Math.round(s.uptimeSec / 60)}m uptime, so nothing has been captured since boot` : '')
    + down + sink + parked
}

/** The parked-bodies clause. Silent at zero — a healthy server must not carry a permanent warning,
 *  or the warning is what gets filtered out on the day it matters. Silent when `undefined` too
 *  (an older server): absent is not zero. `null` is DIFFERENT and is reported, because it means
 *  the pass state could not be read at all, and "I could not look" must never render as "0". */
function parkedSuffix(parked: { files: number; bytes: number; onDisk: number } | null | undefined): string {
  if (parked === undefined) return ''
  if (parked === null) return ' | parked: unknown (pass state unreadable)'
  if (parked.files === 0) return ''
  const mb = (parked.bytes / 1048576).toFixed(1)
  // `onDisk < files` means a parked NAME outlived its file — harmless for disk, but it is state
  // that can never be cleared by a pass that only ever sees files, so it is worth surfacing.
  const ghosts = parked.onDisk < parked.files ? `, ${parked.files - parked.onDisk} name(s) with no file` : ''
  return ` | PARKED ${parked.files} file(s) ${mb}MB${ghosts} — ts-row mismatch, never reclaimed (TRDD-8TM7I49X)`
}

/** The save-failure line for `server status` (TRDD-LDWBRV9B). Silent at zero and when absent: an
 *  older server omits both, and absent is not zero, so nothing is rendered for it. The count is
 *  consecutive failed saves of `.pass-state.json`; a full disk that also loses the one-time log
 *  line is otherwise visible only through the API. `now` is a parameter so this is testable. */
export function stateSaveFailLine(
  bodies: Pick<ServerStatsBodies, 'stateSaveFails' | 'lastStateSaveFailAt'>,
  now: number = Date.now(),
): string | null {
  const fails = bodies.stateSaveFails
  if (fails === undefined || fails === 0) return null
  // lastStateSaveFailAt is 0 = never, and is absent on an older server. A count with no usable
  // timestamp must say so: `now - 0` would render as a failure about 57 years ago.
  const at = bodies.lastStateSaveFailAt
  const when = at ? `last failure ${Math.max(1, Math.round((now - at) / 60000))}m ago` : 'last failure time not reported'
  return `save:   ${fails} consecutive failed .pass-state.json save(s), ${when} — the last save failed; the pass state on disk is stale`
}

interface ServerStats {
  pid: number
  uptimeSec: number
  canonical: boolean
  ports: { ui: number; mcp: number; otlp: number }
  memory: { rssMb: number; heapUsedMb: number; heapLimitMb: number }
  spans: {
    inMemory: number; pendingAppends: number; retentionDays?: number; windowMs?: number
    cap?: number; fileLines?: number; fileBytes?: number
    store?: { totalBytes: number; totalSpans: number; segments: number }
  }
  logSessions: number
  persistence: {
    totalBytesWritten: number; spanAppendBytes: number; spanAppendWrites: number
    spanCompactions?: number; spanCompactBytes?: number
    offsetsBytes: number; offsetsWrites: number; cardsBytes: number; cardsWrites: number
    files: { spans: number; cards: number; offsets: number }
  }
  bodies: ServerStatsBodies
  hookEvents?: { receivedSinceBoot: number; files: number; bytes: number }
  // TRDD-AMEA4O4Z: gated-out OTEL log events persisted to the sink (absent on pre-sink servers).
  logEvents?: { persistedSinceBoot: number; files: number; bytes: number; retentionDays: number }
  gate?: { mode: string; checks: number; denies: number; warns: number; advisories: number }
  // Optional because the WIRE can omit it: a server predating 82d3776 (2026-07-10) answers this
  // route without it. Declaring it required made tsc bless `path.resolve(s.dataDir)`, which throws
  // on undefined — the type has to admit what the payload actually is.
  dataDir?: string
}

/** Whose data dir did the server that answered `/api/server-stats` actually serve?
 *
 *  THREE states, not two. The stats call is reached by a URL derived from ports, which says nothing
 *  about ownership — the whole point of TRDD-BSDR4TRM. So a server that does not report a data dir
 *  at all (a build predating 82d3776, 2026-07-10, verified by `git log -S`) is the case with the
 *  LEAST evidence that it is ours, and collapsing it into `ours` re-creates the defect. The
 *  `typeof` guard is load-bearing twice over: `path.resolve(undefined)` throws.
 *
 *  Extracted so it can be asserted without a server: the first cut of this verdict shipped with no
 *  test, and a revert of it left the whole suite green (ai_review round 2, NEW-2). */
export function statsOwnership(reported: string | undefined, mine: string): 'ours' | 'foreign' | 'unknown' {
  if (typeof reported !== 'string') return 'unknown'
  return path.resolve(reported) === path.resolve(mine) ? 'ours' : 'foreign'
}

export async function showStatus(): Promise<void> {
  // FIX b2 (TRDD-JJLI6GEH): report an active crash-loop hold before anything else — it explains
  // why the probe below is likely to say NOT RUNNING, and it is the one piece of state a hook can
  // never surface to the user itself (its own message goes to stderr from a hook Claude Code does
  // not display). Read via the SAME exported state read the gate uses, so this can't disagree.
  const backoff = reviveBackoffStatus()
  if (backoff.holding) {
    console.log(
      `revive backoff: ${backoff.consecutiveQuickDeaths} quick crash(es) in a row — holding off spawning a ` +
      `new server until ${new Date(backoff.backoffUntilMs).toISOString()}. Run \`agentlenspro server start\` ` +
      'to clear the backoff and try now.',
    )
  }
  let s: ServerStats
  try { s = await apiRequest('GET', '/api/server-stats', undefined, STATUS_TIMEOUT_MS) as unknown as ServerStats } catch (e) {
    // Classified by the typed error code, never by message text (a connect TIMEOUT once slipped past a
    // substring test and was reported as RUNNING). Three distinct facts:
    //  - an answer that is not stats (plain Error): SOMETHING serves the port — an older build or a foreign process;
    //  - ERESPONSETIMEOUT: something ACCEPTED the connection but did not answer — busy server or a foreign squatter;
    //  - connect failure / connect timeout: nothing accepted the connection — falls through to "not running".
    if (!(e instanceof ApiRequestError)) {
      const pid = await findServerPid()
      console.log(`server: RUNNING but does not serve /api/server-stats (older build?)${pid ? ` pid=${pid}` : ''} — restart it: agentlenspro server restart`)
      return
    }
    if (e.code === 'ERESPONSETIMEOUT') {
      const owner = liveLockPid(dataDir())
      console.log(owner !== null
        ? `server: RUNNING (pid ${owner}) — did not answer within ${Math.round(STATUS_TIMEOUT_MS / 1000)}s (busy?)`
        : `server: a process on the UI port accepted the connection but is not answering within ${Math.round(STATUS_TIMEOUT_MS / 1000)}s — not an agentlens server for this data dir (${e.message})`)
      return
    }
    // The pidfile may still name a live process — and if it does, THAT outranks the probe timeout,
    // not the other way round. MEASURED false negative: `server status` printed "NOT RUNNING" while
    // the server was live and healthy on 3000/4316/4318, because the 800ms connect deadline
    // (CONNECT_TIMEOUT_MS, cliCore.ts) can expire against a server that is simply busy/GC-thrashing
    // and hasn't drained its TCP accept queue in time — that is not the same fact as a dead port, but
    // the old code folded both into the identical "unreachable" wrapper message. The tell was that the
    // very next line here read the pidfile and printed a LIVE pid right underneath "NOT RUNNING" —
    // two consecutive lines contradicting each other. A verdict that lies about what a caller can
    // trivially disprove one line later is worse than a slower, honest one, so the pid check now runs
    // FIRST and — proven alive — overrides the probe's guess instead of merely footnoting it.
    let livePid: number | null = null
    try {
      const lock = parsePidLock(fs.readFileSync(pidfilePath(), 'utf-8'))
      if (lock !== null && processAlive(lock.pid)) livePid = lock.pid
    } catch { /* no/unreadable pidfile — a genuinely dead server still falls through below */ }
    if (livePid !== null) {
      console.log(`server: RUNNING pid=${livePid} — busy / not responding within ${CONNECT_TIMEOUT_MS}ms (${(e as Error).message})`)
      return
    }
    console.log(`server: NOT RUNNING (${(e as Error).message})`)
    // A squatter on the OTLP port is why the next `server start` will refuse (it never switches
    // OTLP: exporters target a fixed endpoint), so say so here, where the operator looks first.
    const otlp = Number(envPort(process.env.OTLP_PORT, 4318))
    if (!(await isPortFree(otlp))) console.log(`server: WARNING OTLP port ${otlp} is held by ${portHolder(otlp)} — start will refuse until it is freed (or set OTLP_PORT and re-run agentlenspro --install-otel)`)
    return
  }
  const up = s.uptimeSec
  const uptime = up >= 3600 ? `${Math.floor(up / 3600)}h${Math.floor((up % 3600) / 60)}m` : `${Math.floor(up / 60)}m${up % 60}s`
  const per = s.persistence
  const saveFail = stateSaveFailLine(s.bodies)
  // The stats endpoint is reached by URL, which says nothing about WHOSE data dir answered. Without
  // this line status printed `RUNNING pid=…` for a data dir that has no server, and then printed
  // the two disagreeing `data:` lines below it without comment (TRDD-BSDR4TRM ai_review IMPORTANT-2).
  const ownership = statsOwnership(s.dataDir, dataDir())
  if (ownership !== 'ours') {
    // Everything below this point — memory, spans, disk writes, bodies, capture, hooks, gate — is
    // THAT server's, and printing it unlabelled under a data dir it does not serve invites the
    // reader to attribute another store's numbers to their own. The two lines here are the only
    // ones that are true of the caller's data dir.
    const owner = await findServerPid().catch(() => null)
    console.log([
      ownership === 'foreign'
        // Only what was measured. "Nothing serves this data dir" was an over-claim: it was derived
        // from a PORT answering, which is precisely the evidence this card established says nothing
        // about ownership — and `findServerPid()`, which does answer it, could contradict it in the
        // same process.
        ? `server: RUNNING pid=${s.pid} — but it serves ${s.dataDir}, NOT ${dataDir()}.`
        : `server: RUNNING pid=${s.pid} — it does not report its data dir (build predates 2026-07-10); cannot confirm it serves ${dataDir()}`,
      owner === null
        ? `        nothing holds this data dir's lock — no server for ${dataDir()}`
        : `        the server for ${dataDir()} is pid ${owner}`,
      `data:   ${dataDirSource()}`,
    ].join('\n'))
    return
  }
  console.log([
    `server: RUNNING pid=${s.pid} uptime=${uptime} canonical=${s.canonical} (ui:${s.ports.ui} mcp:${s.ports.mcp} otlp:${s.ports.otlp})`,
    // WHICH store, and which input chose it. A relocated data dir is invisible otherwise: every
    // reader just reports an empty result, and the generic $DATA_DIR can be set by unrelated
    // tooling, so "why is my history gone" needs an answer on the first line of status.
    `data:   ${dataDirSource()}`,
    `memory: rss=${s.memory.rssMb}MB heap=${s.memory.heapUsedMb}/${s.memory.heapLimitMb}MB`,
    // Segmented store (P4) exposes spans.store/windowMs; a pre-P4 server exposes cap/fileLines/
    // fileBytes instead — render whichever shape arrived, don't crash on the other.
    s.spans.store
      ? `spans:  ${s.spans.inMemory} in memory (${Math.round((s.spans.windowMs ?? 0) / 60000)}m window), ${s.spans.pendingAppends} pending, store ${fmtMb(s.spans.store.totalBytes)} (${s.spans.store.totalSpans} spans / ${s.spans.store.segments} segment(s), retention ${s.spans.retentionDays}d) | log sessions: ${s.logSessions}`
      : `spans:  ${s.spans.inMemory}/${s.spans.cap} in memory, ${s.spans.pendingAppends} pending, store ${fmtMb(s.spans.fileBytes ?? 0)} (${s.spans.fileLines} lines) | log sessions: ${s.logSessions}`,
    `disk writes since boot: ${fmtMb(per.totalBytesWritten)} total — spans ${fmtMb(per.spanAppendBytes)} in ${per.spanAppendWrites} appends${per.spanCompactions !== undefined ? ` + ${per.spanCompactions} compaction(s) ${fmtMb(per.spanCompactBytes ?? 0)}` : ''}; offsets ${fmtMb(per.offsetsBytes)}×${per.offsetsWrites}; cards ${fmtMb(per.cardsBytes)}×${per.cardsWrites}`,
    // TRDD-C5L779YI: the last-pass counter reads 0 for the whole interval between cap-valve
    // bursts, so alone it made a healthy burst drain look dead ("last pass archived 0"). Report
    // cumulative reclaim and the age of the last pass that reclaimed anything, beside the
    // backlog those passes declined to act on.
    `bodies: archive ${s.bodies.archive.volumes} volume(s), ${s.bodies.archive.entries} lumps, ${fmtGb(s.bodies.archive.bytes)}; ` +
      (s.bodies.reclaimedSinceBoot !== undefined
        ? `reclaimed ${s.bodies.reclaimedSinceBoot} file(s) since boot (last ${s.bodies.lastNonZeroPassAt ? `${Math.max(1, Math.round((Date.now() - s.bodies.lastNonZeroPassAt) / 60000))}m ago` : 'none yet'}); backlog ${fmtGb(s.bodies.lastPass.keptBytes)} not yet reclaimed`
        : `last pass archived ${s.bodies.lastPass.removedFiles} (live kept ${fmtGb(s.bodies.lastPass.keptBytes)})`),
    // TRDD-0SA5QZTG: the CAPTURE line. Everything above describes what was already collected;
    // this is the only line that says whether collection is still happening. It states the age
    // and lets the reader judge, rather than declaring "broken" — an idle machine legitimately
    // captures nothing — EXCEPT when the newest body predates the server's own boot, which is
    // not a judgement call: this process has run that whole time and captured nothing.
    `capture: ${bodiesCaptureLine(s)}`,
    ...(saveFail ? [saveFail] : []),
    // hookEvents/gate are absent when --status hits a server built before TRDD-Q6ZOUVK5/GOD0108C — skip, don't crash.
    ...(s.hookEvents ? [`hooks:  ${s.hookEvents.receivedSinceBoot} event(s) since boot, ${s.hookEvents.files} bucket(s) ${fmtMb(s.hookEvents.bytes)} on disk`] : []),
    // logEvents is absent when --status hits a server built before TRDD-AMEA4O4Z — skip, don't crash.
    ...(s.logEvents ? [`log-events sink: ${s.logEvents.persistedSinceBoot} persisted since boot, ${s.logEvents.files} bucket(s) ${fmtMb(s.logEvents.bytes)} on disk (retention ${s.logEvents.retentionDays}d)`] : []),
    ...(s.gate ? [`gate:   mode=${s.gate.mode} — ${s.gate.checks} check(s), ${s.gate.denies} deny, ${s.gate.warns} warn, ${s.gate.advisories} advisories since boot`] : []),
    `data:   ${s.dataDir ?? 'not reported by this server'} (spans ${fmtMb(per.files.spans)}, cards ${fmtMb(per.files.cards)}, offsets ${fmtMb(per.files.offsets)})`,
  ].join('\n'))
}

export function openDashboard(): void {
  if (process.platform === 'darwin') {
    spawn('open', [dashboardUrl()], { detached: true, stdio: 'ignore' }).unref()
    console.log(`dashboard -> ${dashboardUrl()}`)
  } else {
    console.log(`open ${dashboardUrl()} in your browser`)
  }
}

// ── Supervisor (absorbed from scripts/agentlens-supervise.js, TRDD-PJC8N1HO spec 1) ─────────
// Keeps the collector alive: on any non-clean exit (a V8 OOM abort exits 134, a signal kill,
// etc.) it restarts the collector with EXPONENTIAL BACKOFF and appends the crash reason to
// DATA_DIR/crash.log. Before this existed the collector died silently and every OTEL export
// in the dead window was lost. Runs in the FOREGROUND so a process manager (launchd via the
// embedded plist that `daemon install` writes, or a terminal) supervises the supervisor.

const HEALTHY_MS = 60_000       // a child that ran this long is "healthy" → reset backoff on its exit
const STDERR_TAIL_BYTES = 8 * 1024

/**
 * EX_CONFIG (78) is a DELIBERATE config refusal, not a crash: the standalone server exits 78 when
 * the shared embed-key is unusable (corrupt, or wider than 0600). (Under the DISABLED kill-switch it
 * no longer exits 78: since TRDD-RBBEX59R c1 it boots in no-collection mode.) The supervisor must NOT
 * respawn such an exit — respawning just re-refuses forever, a
 * perpetual backed-off loop that never converges and floods crash.log. Every other non-clean exit
 * (a signal kill, a V8 OOM abort code 134, a generic error) is a real crash and still earns the
 * backoff-respawn. Extracted as a named predicate so the policy is unit-testable without spawning a
 * real process (the live handler's terminal branch calls process.exit). (TRDD-F1VX3M7C.)
 */
export function isTerminalExit(code: number | null): boolean {
  return code === 78
}

/** crash.log note for an exit 64 (TRDD-RBBEX59R c2 round 4). NOT terminal: alcore's usage() also covers
 *  filesystem-state errors (a briefly absent --media-dir during an upgrade, alcore.rs:205/:207), so the supervisor
 *  keeps respawning. The version-skew note is given ONLY when the child's stderr proves it: usage() prints
 *  `unknown arg --no-collection` (alcore.rs:185) when an alcore older than c1 rejects the flag. Any other 64 is named
 *  generically — claiming version skew for a missing --media-dir would send the operator to the wrong fix. */
export function exitDiagnostic(code: number | null, stderrTail: string): string {
  if (code !== 64) return ''
  if (stderrTail.includes('unknown arg --no-collection')) return ' — alcore rejected its arguments (exit 64) — an alcore older than this CLI rejects --no-collection; deploy the matching alcore'
  return ' — alcore rejected an argument or a path (exit 64); see stderr-tail'
}

/** The supervisor's default maximum respawn backoff. ONE source: runSupervise and the enable verb's respawn wait
 *  (disableCli.ts restartIntoCollection) both read it; AGENTLENS_SUPERVISE_MAX_BACKOFF_MS overrides it in each process. */
export const SUPERVISE_MAX_BACKOFF_DEFAULT_MS = 30_000

export function runSupervise(): void {
  // No kill-switch refusal any more (TRDD-RBBEX59R c2). It used to refuse a disabled install so that
  // `agentlenspro disable` could not be undone by a launchd-respawned supervisor; now the switch means
  // "collect nothing", not "run nothing": every child is spawned through alcoreServeArgs(), which adds
  // --no-collection while the switch is armed for the data dir, so a supervised server keeps the spawn
  // guards fed and stores no telemetry. The NO_REVIVE brake (below) is what keeps the process down.
  const alcore = alcoreBin(process.env, undefined, undefined, resolveBinNativeDir())
  if (!alcore) throw noServerAvailableError()
  const crashLog = path.join(dataDir(), 'crash.log')
  const maxBackoffMs = Number(process.env.AGENTLENS_SUPERVISE_MAX_BACKOFF_MS) || SUPERVISE_MAX_BACKOFF_DEFAULT_MS

  try { fs.mkdirSync(dataDir(), { recursive: true }) } catch { /* best effort */ }

  let backoffMs = 1000
  let shuttingDown = false
  let child: ReturnType<typeof spawn> | null = null

  const logCrash = (reason: string): void => {
    const line = `[${new Date().toISOString()}] ${reason}\n`
    try { fs.appendFileSync(crashLog, line) } catch { /* best effort */ }
    process.stderr.write(`[supervisor] ${line}`)
  }

  /** Every scheduled restart goes through here, never straight to start().
   *
   *  WHY: `server stop --stay-down` arms the on-disk NO_REVIVE brake so nothing resurrects the
   *  collector during a staged store rewrite — and the supervisor was the one process class that
   *  ignored it. stopServer() SIGTERMs the child, `shuttingDown` is false (it is only set by the
   *  supervisor's OWN signal handler, not by an external stop), so the exit handler cheerfully
   *  respawned a collector straight into the store dir mid-swap. Worse, it was TIMING-dependent:
   *  a repair whose quiescence scan landed in the backoff gap saw a clean process table, staged,
   *  and then had a collector appear underneath it — silent divergence that looks intermittent.
   *
   *  Checks NO_REVIVE ONLY — never the global DISABLED switch. Under DISABLED the spawn PROCEEDS:
   *  since TRDD-RBBEX59R the child boots in no-collection mode (alcoreServeArgs adds --no-collection,
   *  recomputed on every respawn, so a respawn after the switch is lifted collects again) and keeps
   *  the spawn guards fed. Swallowing the spawn here would leave a DISABLED supervisor with no child.
   *  (Reading the brake from killSwitch.ts also keeps this module out of hookHandlers, which imports
   *  alcoreBin from HERE — importing a hookHandlers predicate back created a CJS cycle tsc reports
   *  as clean.)
   *
   *  RESCHEDULE rather than exit: a brake is a pause, not a shutdown. Exiting here would mean a
   *  stay-down stop permanently kills a launchd-supervised install, and clearing the brake would
   *  not bring it back. Re-checking on the same backoff timer resumes on its own.
   *
   *  The predicate itself now lives in killSwitch.ts so this loop and `ensureServer()` share ONE
   *  definition — they did not, and `ensureServer()` had none at all (TRDD-8VGQK9L9). Its comment
   *  there carries the ENOENT-only-false rationale and the pause-vs-kill split; the reschedule
   *  below is what makes the pause self-healing here. */
  const startUnlessBraked = (): void => {
    if (reviveBraked()) {
      logCrash(`revive brake (NO_REVIVE) is set — NOT restarting the collector; re-checking in ${backoffMs}ms. Clear it with \`agentlenspro server start\`.`)
      setTimeout(startUnlessBraked, backoffMs)
      return
    }
    start()
  }

  const start = (): void => {
    const started = Date.now()
    // Inherit env so isolated-port / no-telemetry overrides pass through. stdout inherits
    // (logs flow to the launchd/terminal sink); stderr is teed so we keep its tail for the
    // crash record. MIMALLOC_PURGE_DELAY: TRDD-2JOIAH2G R1, same rationale as the direct spawn.
    child = spawn(alcore, alcoreServeArgs(),
      { cwd: dataDir(), env: { ...process.env, [STARTED_BY_ENV]: 'supervisor', MIMALLOC_PURGE_DELAY: ALCORE_MIMALLOC_PURGE_DELAY_MS }, stdio: ['ignore', 'inherit', 'pipe'] })

    let stderrTail = Buffer.alloc(0)
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)                                   // keep live stderr visible
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES)  // retain only the tail
    })

    child.on('exit', (code, signal) => {
      const uptimeS = ((Date.now() - started) / 1000).toFixed(1)
      if (shuttingDown) return  // deliberate stop — don't restart
      // EX_CONFIG (78) is a DELIBERATE config refusal, not a crash: the server exits 78 when the
      // shared embed-key is unusable (corrupt, or wider than 0600). (It no longer exits 78 under the
      // DISABLED kill-switch: since TRDD-RBBEX59R c1 it boots in no-collection mode instead.)
      // Respawning it would just refuse again — a perpetual backed-off loop that never
      // converges and floods crash.log (TRDD-F1VX3M7C). Treat 78 as TERMINAL: log once, stop
      // supervising, and surface the non-zero exit so a launchd/terminal parent sees it. The
      // operator fixes the config (chmod 600) and restarts.
      if (isTerminalExit(code)) {
        const tail78 = stderrTail.toString('utf8').trim().split('\n').slice(-12).join(' | ')
        logCrash(`collector refused to start (EX_CONFIG 78) uptime=${uptimeS}s — a config refusal, not a crash; NOT restarting. Fix the config and restart. stderr-tail: ${tail78 || '(none)'}`)
        process.exit(78)
      }
      const tail = stderrTail.toString('utf8').trim().split('\n').slice(-12).join(' | ')
      logCrash(`collector exited code=${code} signal=${signal} uptime=${uptimeS}s${exitDiagnostic(code, tail)} — restarting in ${backoffMs}ms. stderr-tail: ${tail || '(none)'}`)
      // A child that ran healthily before dying gets a fresh backoff; a crash-loop backs off geometrically.
      if (Date.now() - started > HEALTHY_MS) backoffMs = 1000
      setTimeout(startUnlessBraked, backoffMs)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    })

    child.on('error', (err) => {
      logCrash(`failed to spawn collector: ${err.message} — retrying in ${backoffMs}ms`)
      setTimeout(startUnlessBraked, backoffMs)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    })
  }

  const shutdown = (sig: string): void => {
    shuttingDown = true
    process.stderr.write(`[supervisor] received ${sig} — stopping collector\n`)
    if (child) { try { child.kill('SIGTERM') } catch { /* ignore */ } }
    // Give the collector a moment to flush (atomic spans/offset save on SIGTERM), then exit.
    setTimeout(() => process.exit(0), 2000)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // ENTRY is refused outright when braked — unlike the restart loop, which waits. A launchd
  // KeepAlive respawn invokes the identical argv as a human start, so entry cannot assume an
  // operator meant "override the brake": arming the brake for a store rewrite and having launchd
  // bounce the supervisor would otherwise spawn a collector straight into the swap. Exit 75, not
  // 78: 78 is the TERMINAL config-refusal code launchd consumers treat as give-up. launchd does
  // NOT interpret 75 specially — KeepAlive just rethrottles at its fixed ThrottleInterval
  // (~10s default; doc-sourced, not measured on this machine), forever. That flat 10s
  // stat+exit spin is bounded and cheap, and the first
  // respawn after the brake clears succeeds on its own; do not expect escalating backoff here.
  // The human who really wants supervision back clears the brake first
  // (`agentlenspro server start`, or remove NO_REVIVE) and re-runs.
  if (reviveBraked()) {
    process.stderr.write(`[supervisor] revive brake (NO_REVIVE) is set — refusing to start. Clear it and re-run.\n`)
    process.exit(75)
  }
  process.stderr.write(`[supervisor] starting AgentlensPro collector (crash log ${crashLog})\n`)
  start()
}

/** Is anything answering the MCP endpoint right now? (the supervise refusal probe) */
async function mcpServed(): Promise<boolean> {
  try { await init(); return true } catch { return false }
}

/** Lift the stop-time revive brake. A deliberate start means the operator wants capture back —
 *  leaving the brake set would run the server now but never revive it after its first crash,
 *  silently ending capture. Fail-open on an unlink error: the brake READER already tolerates a
 *  stat failure, so a hiccup here must not become a permanent un-revivable state. */
function clearReviveBrake(): void {
  try { fs.rmSync(noRevivePath(), { force: true }) } catch { /* fail-open — see above */ }
}

/** Dispatcher for `agentlenspro server <start|stop|restart|status> [--supervise]`. */
export async function serverCommand(argv: string[]): Promise<void> {
  const verb = argv[0]
  // `server status --x` used to be silently ignored and exit 0 (TRDD-PIB6T4RU) — the only flag any
  // verb here understands is --supervise (start-only, but harmless to accept everywhere), so anything
  // else flag-shaped is a typo, not a no-op.
  assertKnownFlags(argv.slice(1), new Set(['--supervise', '--stay-down']), new Set(), 'agentlenspro server start|stop|restart|status [--supervise] [--stay-down]')
  const supervise = argv.includes('--supervise')
  const stayDown = argv.includes('--stay-down')
  if (stayDown && verb !== 'stop') {
    throw new UsageError('--stay-down only applies to `server stop` — it sets the on-disk revive brake so no hook resurrects the server until the next `server start`.')
  }
  switch (verb) {
    case 'start':
      if (supervise) {
        // Refuse a second collector: both would bind the same ports and the second EADDRINUSEs.
        if (await mcpServed()) {
          console.log(`server: MCP endpoint ${mcpEndpoint()} already served — refusing to start a second collector.`)
          return
        }
        // Deliberately does NOT clear the brake: a launchd KeepAlive respawn runs this exact
        // argv, so clearing here would let a supervisor bounce wipe a brake an operator armed
        // for a store rewrite — then spawn into the swap. runSupervise itself refuses (exit 75)
        // while braked; lift the brake with a plain `server start` first.
        runSupervise() // foreground; never returns until signalled
        return
      }
      // Clear AFTER the server is actually up, so the invariant reads "brake cleared ⟺ a server
      // is running". Clearing first meant a FAILED start left no server AND no brake — the one
      // state where anything may freely spawn a collector — and a stray failed `start` in another
      // shell would silently disarm a brake an operator had armed for a store rewrite.
      // overrideBrake: this is the one command documented to lift the brake, so it must be allowed
      // to spawn through it — see the gate in ensureServer() for the regression this avoids.
      await ensureServer('server start', { overrideBrake: true })
      clearReviveBrake()
      resetReviveBackoff() // a deliberate start wants a clean slate, not yesterday's crash-loop counter
      return
    case 'stop':
      // Brake BEFORE the SIGTERM: a hook landing in the stop window must already see the flag,
      // or it revives the server the instant it dies (the exact race the brake exists for).
      if (stayDown) {
        fs.writeFileSync(noRevivePath(), `server stop --stay-down ${new Date().toISOString()}\n`)
        // Report the brake the moment it is TRUE, not after the stop. stopServer() throws on its
        // 10s timeout (and process.kill can throw ESRCH/EPERM), and a confirmation printed after
        // it would be skipped on exactly those paths — leaving server up + brake armed + the
        // operator never told the brake exists, so the next crash is silently never revived.
        console.log('revive brake set (NO_REVIVE) — hooks and the supervisor will not resurrect the server; `agentlenspro server start` clears it.')
      }
      await stopServer()
      // A plain stop against a SUPERVISED install is a trap: the supervisor sees the child exit
      // (its shuttingDown is false — that flag is set only by its own signal handler) and
      // respawns in ~1s, right after we printed "server stopped". Warn instead of silently
      // losing the fight; --stay-down is the stop that actually holds. Snapshot-then-scan so
      // the scanner cannot match itself.
      if (!stayDown) {
        try {
          const table = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
          // Anchored to this product's argv shapes — a bare `server start --supervise` pattern
          // would fire the warning on a stranger's process, and a warning that can lie erodes
          // the trust it exists to build.
          if (table.split('\n').some((l) => /(standalone\/cli\.js|agentlenspro)\s+server\s+start\b.*--supervise/.test(l) && Number(l.trim().split(/\s+/)[0]) !== process.pid)) {
            console.error('WARNING: a supervisor is running — it will respawn the collector in seconds. Use `server stop --stay-down` to hold it down, or stop the supervisor itself.')
          }
        } catch { /* advisory only — a failed scan must not fail the stop */ }
      }
      return
    case 'restart':
      await stopServer()
      await ensureServer('server restart', { overrideBrake: true })  // same contract as `start`
      clearReviveBrake()
      resetReviveBackoff() // same contract as `start` — see its own comment
      return
    case 'revive':
      // Hook-revive entry (hookHandlers.reviveDaemonDetached): the SAME guarded start as `start`, run
      // detached. Unlike `start` it must NOT lift the revive brake or reset the crash-loop backoff —
      // the hook already honoured both, and a revive is not an operator's deliberate start.
      // Refuse HERE too, not only in the hook's pre-check: this verb is runnable by hand and by any
      // stale hook build. AGENTLENS_NO_REVIVE is the env half of the brake (reviveBraked() reads the
      // on-disk NO_REVIVE flag); ensureServer re-checks the brake as a backstop. The global kill-switch is NOT
      // a refusal any more (TRDD-RBBEX59R c2): under it the revive starts a no-collection server
      // (alcoreServeArgs adds --no-collection), so the spawn guards stay fed.
      if (reviveBraked() || process.env.AGENTLENS_NO_REVIVE === '1') {
        throw new Error('server revive refused: the NO_REVIVE brake is armed (`agentlenspro server start` is the deliberate override for the brake).')
      }
      await ensureServer(REVIVE_STARTED_BY)
      return
    case 'status':
      await showStatus()
      return
    default:
      // UsageError, not Error: standalone/cli.ts maps the type to the exit code, and cliErrors.ts
      // reserves 1 for the watchers' ABORT signal. A plain Error here made `agentlenspro server`
      // (subcommand forgotten) indistinguishable from "the server code threw" — while every
      // sibling verb with the identical missing-argument shape (budget, watch, ctxmap) already
      // returned 64. Found by RUNNING the verb matrix, not by review: each site reads fine alone.
      throw new UsageError(`server expects start|stop|restart|status (got "${verb ?? ''}") — e.g. agentlenspro server start [--supervise]`)
  }
}

// ── Daemon (D3K7QM2P/1b) — the always-on ingestion role ─────────────────────────────────────────
// In the hook-revive architecture the ingestion daemon IS the standalone server (it owns OTLP :4318
// + the JSONL scan + the hook-spool drain); `daemon` is the CLI surface that names that role for the
// user and reports the ingestion-specific health (the hook-spool depth). start/stop/restart share the
// server lifecycle verbatim (one process, one pidfile guard); `daemon start --supervise` is what
// launchd runs for true always-on (1d). This is a thin alias by design — a second lifecycle would be
// a second source of truth for "is ingestion up".
export async function daemonCommand(argv: string[]): Promise<void> {
  const verb = argv[0] ?? 'status'
  if (verb === 'status') {
    assertKnownFlags(argv.slice(1), new Set(), new Set(), 'agentlenspro daemon status')
    await showStatus()
    const spooled = hookSpoolDepth()
    console.log(`ingestion: always-on daemon = the standalone server (OTLP :4318 + JSONL scan + hook-spool drain).`)
    console.log(`hook-spool: ${spooled} event(s) awaiting drain${spooled > 0 ? ' — undelivered hooks are safe on disk and reingested on the next drain tick' : ''}`)
    return
  }
  if (verb === 'install') {
    assertKnownFlags(argv.slice(1), new Set(['--no-load']), new Set(), 'agentlenspro daemon install [--no-load]')
    daemonInstall({ load: !argv.includes('--no-load') }); return
  }
  if (verb === 'uninstall') {
    assertKnownFlags(argv.slice(1), new Set(), new Set(), 'agentlenspro daemon uninstall')
    daemonUninstall(); return
  }
  if (verb === 'start' || verb === 'stop' || verb === 'restart') {
    // The daemon and the server are one process — reuse the exact lifecycle (incl. --supervise).
    await serverCommand(argv)
    return
  }
  throw new Error(`daemon expects start|stop|restart|status|install|uninstall (got "${verb}") — e.g. agentlenspro daemon start --supervise`)
}

// ── Always-on supervision via launchd (D3K7QM2P/1d) ─────────────────────────────────────────────
// The hook-revive (1a) already keeps the daemon up whenever a Claude instance is active. `daemon
// install` goes further: a per-user launchd agent runs `daemon start --supervise` at login and
// KeepAlive-restarts the supervisor, so ingestion is up 24/7 even with zero Claude instances and
// across reboots. Opt-in (never forced by `setup`) because a standing background daemon is the
// user's choice. macOS only for now; linux gets a printed systemd-user recipe.
const LAUNCHD_LABEL = 'com.agentlens.collector'
// Embedded (not read from scripts/) so an npm-installed package can self-install without shipping the
// template file. @NODE@/@CLI@/@REPO@/@HOME@ are filled at install time (no username assumed — @HOME@
// is os.homedir(); commit 2088d7e removed the old @USER@ path).
const LAUNCHD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>@NODE@</string>
    <string>@CLI@</string>
    <string>daemon</string>
    <string>start</string>
    <string>--supervise</string>
  </array>
  <key>WorkingDirectory</key>
  <string>@REPO@</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>@HOME@/.agentlens/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>@HOME@/.agentlens/launchd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTLENS_MAX_OLD_SPACE_MB</key>
    <string>@MAXHEAP@</string>
  </dict>
</dict>
</plist>
`

function launchAgentsPath(overrideDir?: string): string {
  return path.join(overrideDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents'), `${LAUNCHD_LABEL}.plist`)
}

/** Install (or refresh) the launchd agent. Returns the plist path. `load:false` and a
 *  `launchAgentsDir` override make it testable without touching the real system. */
export function daemonInstall(opts: { launchAgentsDir?: string; load?: boolean } = {}): { path: string; installed: boolean } {
  if (process.platform !== 'darwin') {
    // THROW rather than print-and-return: nothing was installed, and exiting 0 makes a script
    // (or an agent) treat a no-op as a successful install. The recipe still reaches the operator
    // because it is in the error text.
    throw new Error(
      'daemon install: launchd is macOS-only — nothing was installed. On linux, run a systemd USER service:\n'
      + `  ~/.config/systemd/user/agentlens.service → ExecStart=${process.execPath} ${cliJsPath()} daemon start --supervise\n`
      + '  then: systemctl --user enable --now agentlens.service',
    )
  }
  const cli = cliJsPath()
  const plistPath = launchAgentsPath(opts.launchAgentsDir)
  const filled = LAUNCHD_PLIST
    .replace(/@NODE@/g, process.execPath)
    .replace(/@CLI@/g, cli)
    .replace(/@REPO@/g, path.dirname(path.dirname(cli)))
    .replace(/@HOME@/g, os.homedir())
    .replace(/@MAXHEAP@/g, String(DEFAULT_MAX_OLD_SPACE_MB))
  fs.mkdirSync(path.dirname(plistPath), { recursive: true })
  // temp + rename: an interrupted write would otherwise leave a truncated plist that launchd may
  // load malformed or refuse silently. Atomic on the same filesystem.
  const tmpPlist = `${plistPath}.tmp`
  fs.writeFileSync(tmpPlist, filled)
  fs.renameSync(tmpPlist, plistPath)
  let loaded = false
  if (opts.load !== false) {
    // `load -w` (re)loads and marks it enabled; a re-install first unloads so the new plist takes.
    try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }) } catch { /* not loaded yet */ }
    try {
      execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'ignore' })
      loaded = true
    } catch (e) {
      console.warn(`launchctl load failed: ${String(e)} — the plist is written; load it manually.`)
    }
  }
  // Report what HAPPENED, not what was requested. The old message printed "loaded" whenever load
  // was asked for, so a failed launchctl told the user the daemon was running while it was not —
  // and telemetry went missing with a success message on screen.
  const state = opts.load === false ? 'written, not loaded' : loaded ? 'loaded' : 'written, LOAD FAILED — load it manually'
  console.log(`daemon install: launchd agent → ${plistPath} (${state})`)
  return { path: plistPath, installed: opts.load === false ? true : loaded }
}

/** Remove the launchd agent (unload + delete the plist). Idempotent. */
export function daemonUninstall(opts: { launchAgentsDir?: string } = {}): { path: string; removed: boolean } {
  const plistPath = launchAgentsPath(opts.launchAgentsDir)
  if (process.platform === 'darwin') { try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }) } catch { /* not loaded */ } }
  let removed = false
  try { fs.unlinkSync(plistPath); removed = true } catch { /* already gone */ }
  console.log(`daemon uninstall: ${removed ? `removed ${plistPath}` : 'nothing to remove'}`)
  return { path: plistPath, removed }
}

/** The bundled CLI entry (standalone/cli.js). Same layout walk as `findMediaDir` — the package
 *  root is one level up from the bundled cli.js but two up from out/cli/. */
export function cliJsPath(): string {
  const candidates = [
    path.join(__dirname, 'cli.js'),                              // bundled: standalone/
    path.resolve(__dirname, '..', 'standalone', 'cli.js'),       // src/cli/ compiled in-place
    path.resolve(__dirname, '..', '..', 'standalone', 'cli.js'), // out/cli/
    path.resolve(__dirname, '..', '..', '..', 'standalone', 'cli.js'), // out/test/cli/
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error(`standalone/cli.js missing (looked near ${__dirname}) — run \`node esbuild.js\` first.`)
}
