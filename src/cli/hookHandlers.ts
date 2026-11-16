// src/cli/hookHandlers.ts — the `agentlenspro hook` / `agentlenspro gate` stdin handlers
// (TRDD-7284WCW7). These absorb scripts/spy-agentlens*.{sh,mjs} and their PATH-bin wrappers
// into the single executable: hooks are now registered as `agentlenspro hook|gate` command
// strings, and this module IS the handler — no wrapper chain, no sibling-script resolution.
//
// Contracts (inherited verbatim from the spy scripts — the tests in cliHookHandlers.test.ts
// pin them):
//   hook — POST the raw stdin payload to $AGENTLENS_UI_URL/api/hook-events. Print NOTHING
//          (hook stdout is captured by the runner). ALWAYS exit 0, even server-down — a
//          telemetry hook that can fail a tool call is worse than no telemetry.
//   gate — AGENTLENS_GATE=off ⇒ exit 0, no output, BEFORE any network. Else POST stdin to
//          /api/agent-gate and print the response body VERBATIM (the body IS the hook's
//          stdout: empty = allow, deny/advisory JSON flows to the model untouched). ANY
//          failure ⇒ silent exit 0 (fail-open): a gate that can block a launch because
//          AgentlensPro is down would be worse than no gate.

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { isImageReadPath } from '../shared/imageReads'
import { uiBaseUrl, dataDir } from './cliCore'
import { alcoreBin, cliJsPath, resolveBinNativeDir } from './serverControl'
import { agentlensDisabled, reviveBraked } from './killSwitch'
import { atomicWriteFileSync, lockTakeoverVerdict, parsePidLock, processStartRef } from '../serverRuntime'

// D3K7QM2P/1a — hook durability. When the server can't take a hook event (down, or shedding under
// load), we must NOT lose it: durably spool the payload to disk (the server's boot/periodic drain
// reingests it) and fire a DETACHED, stampede-locked revive so the always-on ingestion comes back.
// Every fs/spawn op here is best-effort and guarded — the hook contract is "always exit 0 fast,
// never fail a tool call", so nothing in this file may throw or block.
const REVIVE_LOCK_TTL_MS = Math.max(2_000, Number(process.env.AGENTLENS_REVIVE_LOCK_TTL_MS) || 15_000)
// A lock written THIS millisecond can read as slightly-negative age: fs.statSync().mtimeMs carries
// sub-ms precision while Date.now() truncates to integer ms, so (Date.now() - mtimeMs) is often a
// small NEGATIVE fraction when the write + the check land in the same ms (measured ~97% of the time
// on a fast machine). A short tolerance treats such a lock as "just written" (fresh), not stale —
// see reviveDaemonDetached. Also absorbs minor NTP skew between the FS clock and the JS clock.
const REVIVE_LOCK_SKEW_MS = 2_000
// Read per-call (not a module const) so a live AGENTLENS_HOOK_SPOOL_MAX change is honored — each
// hook is a short-lived process, so the env read is negligible. Floor of 1: a user may set a small
// cap deliberately; the default 20k is the real safety bound.
function spoolMaxFiles(): number { return Math.max(1, Number(process.env.AGENTLENS_HOOK_SPOOL_MAX) || 20_000) }

/** The gate kill-switch (AGENTLENS_GATE=off disarms the burn-gate; default on). One definition,
 *  read per-call so a live env change is honored — used by both runGateCheck and runHookCommand. */
function gateDisabled(): boolean { return (process.env.AGENTLENS_GATE || 'on') === 'off' }

/** The image cache-guard's OWN kill-switch. Deliberately separate from AGENTLENS_GATE: the guard
 *  rides the same PreToolUse hook but matches `Read`, so someone who finds it chatty must be able
 *  to silence it WITHOUT also disarming the agent-launch disaster gate — one shared switch would
 *  make "the image warning annoys me" cost you the fork-storm protection too. */
function cacheGuardDisabled(): boolean { return (process.env.AGENTLENS_CACHE_GUARD || 'on') === 'off' }

/** Decide LOCALLY whether a gate payload is worth a round-trip to the server.
 *
 *  `Read` is in GATE_MATCHER solely for the image cache-guard, and a session reads far more files
 *  than it launches agents — so answering "this Read is a .ts file, the guard has nothing to say"
 *  here costs one JSON parse instead of an HTTP call with a 2s timeout on every single read.
 *  Unparseable payloads fall through to the server: that is the fail-open direction, and a payload
 *  shape we do not recognise is exactly when we should not be the one deciding. */
function skipGateRoundTrip(payload: Buffer): boolean {
  let p: { tool_name?: unknown; tool_input?: { file_path?: unknown } | null }
  try {
    p = JSON.parse(payload.toString('utf-8')) as typeof p
  } catch {
    return false
  }
  if (p?.tool_name !== 'Read') return false
  return cacheGuardDisabled() || !isImageReadPath(p.tool_input?.file_path)
}

/** Durably record an undeliverable hook payload for the server's boot/periodic drain. Bounded so a
 *  permanently-down server can't fill the disk: over the cap, the OLDEST spooled events are dropped
 *  (loudly) — losing the stalest beats an unbounded spool. Never throws. */
function spoolHookEvent(payload: Buffer): void {
  try {
    const dir = path.join(dataDir(), 'hook-spool')
    fs.mkdirSync(dir, { recursive: true })
    let names: string[] = []
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort() } catch { /* none yet */ }
    const cap = spoolMaxFiles()
    if (names.length >= cap) {
      const over = names.length - cap + 1
      for (let i = 0; i < over; i++) { try { fs.unlinkSync(path.join(dir, names[i])) } catch { /* raced */ } }
      process.stderr.write(`[agentlenspro] hook-spool full (${cap}) — dropped ${over} oldest event(s)\n`)
    }
    // ts-pid-rand keeps names sortable-by-time AND collision-free across concurrent hook processes.
    const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`
    fs.writeFileSync(path.join(dir, name), payload)
  } catch { /* best effort — a hook must never throw */ }
}

/** The out-of-band brake: `<dataDir>/NO_REVIVE` on disk stops every future hook from resurrecting the
 *  server. Needed because AGENTLENS_NO_REVIVE only reaches a hook that the agent spawned with it
 *  already in its env — an operator facing a runaway server cannot retrofit env onto a running agent,
 *  and `kill` alone is futile when the very next hook spawns it again. A file any shell can touch is
 *  the only brake that actually reaches the hook. The brake predicate is reviveBraked() — the ONE
 *  definition, fail-CLOSED on an unreadable file: this function guards a SPAWN, and a spawn during
 *  a store swap corrupts the store, while a skipped revive costs one hook's worth of latency. (An
 *  earlier fail-open existsSync here was the second, opposite-direction copy of the predicate.) */
export function reviveDisabledOnDisk(): boolean {
  // Either brake stops a revive: the NARROW one (NO_REVIVE — keep ingesting, just don't spawn a
  // server) or the GLOBAL one (DISABLED — stop everything). Checked here as well as at the hook
  // entry point on purpose: reviveDaemonDetached() spawns a detached process, and that is the one
  // side-effect that must never slip through a missed guard.
  return agentlensDisabled() || reviveBraked()
}

/** True when `<dataDir>/server.pid` names a process that is genuinely alive right now — the SAME
 *  lock-parsing + takeover verdict `findServerPid()` (serverControl.ts) uses, so a hook and the CLI
 *  can never disagree about who owns this data dir. Deliberately pidfile-only (no REST fallback):
 *  a hook must never make a network round trip just to decide whether to skip a revive.
 *
 *  TRDD-L6V1UUW0/2 — measured 2026-09-02: 781 lines in server.log read "Refusing to start: another
 *  AgentlensPro server (pid N) already owns this data directory". Every one of those was a revive
 *  spawned by a timed-out hook while the real server was alive and merely slow/shedding under load —
 *  a wasted process spawn landing exactly when the machine was already stalling. That refusal line
 *  IS the proof the spawn was pointless, so this check short-circuits it before the spawn happens. */
export function pidfileOwnerAlive(): boolean {
  try {
    const lock = parsePidLock(fs.readFileSync(path.join(dataDir(), 'server.pid'), 'utf-8'))
    if (lock === null) return false
    const alive = (() => { try { process.kill(lock.pid, 0); return true } catch { return false } })()
    const verdict = lockTakeoverVerdict({
      lockPid: lock.pid,
      lockStartRef: lock.start,
      pidAlive: alive,
      currentStartRef: lock.start === null ? null : processStartRef(lock.pid),
    })
    return verdict === 'live-owner' || verdict === 'legacy-kill0-only'
  } catch {
    return false // no/unreadable pidfile — cannot prove an owner is alive, so proceed as before
  }
}

// ── Crash-loop backoff (TRDD-JJLI6GEH) ───────────────────────────────────────────────────────────
// The 15s stampede lock above only collapses a BURST of hooks into one spawn; it does nothing once a
// server crashes moments after every boot (a boot-time OOM measured ~40k spawns in one incident: the
// only thing that ever stopped it was the crashing DuckDB restore finally fitting in memory again).
// This tracks how many CONSECUTIVE spawns died quickly and backs off exponentially, so a broken
// install fails LOUDLY and SLOWLY instead of pegging the CPU/disk forever.

// "Quick death" window, keyed on TIME-SINCE-SPAWN, not "died before listening": TWDGR75R's OOM panics
// moments AFTER the store starts serving, so a probe that only watches for "never listened" would
// miss it. A legitimate large-store boot never even reaches this check — pidfileOwnerAlive() (below)
// stays true for the whole readyTimeoutMs() budget, so reviveDaemonDetached() returns before this
// runs at all. Reaching here at all already means the previous owner is confirmed NOT alive.
//
// FIX b1 (TRDD-JJLI6GEH, 2026-09-25): the lifetime is classified ONCE, at the FIRST hook that finds
// the previous owner dead (see the `deathClassified` field below) — BEFORE any hold from that
// classification is applied. A hold-driven gap can therefore never leak into a later "now -
// lastSpawnMs" measurement, so this window is a genuine "died within N minutes of starting"
// threshold and does not need to exceed REVIVE_BACKOFF_MAX_MS (the earlier 40-minute window, sized
// only to dodge that leak, made a healthy 30-50-minute run under the 2GB RSS cap — TRDD-WKLD508O —
// look like a crash and cost it up to 30 minutes of downtime).
//
// Caveat: lifetime is measured to the first hook that notices the death, so idle time between the
// death and that hook inflates it; this errs toward not throttling (safe: spawns only come from
// hooks, so sparse hooks mean sparse spawns).
const REVIVE_CRASH_WINDOW_MS = Math.max(5_000, Number(process.env.AGENTLENS_REVIVE_CRASH_WINDOW_MS) || 5 * 60_000)
// Doubling from a 30s base reaches the 30-minute cap after 6 consecutive quick deaths (30s, 60s,
// 120s, 240s, 480s, 960s -> capped), throttling a genuine crash loop to ~2 spawns/hour instead of
// several per second, while a single flake (1-2 quick deaths) barely slows anything down.
const REVIVE_BACKOFF_BASE_MS = 30_000
const REVIVE_BACKOFF_MAX_MS = 30 * 60_000

function reviveBackoffStatePath(): string { return path.join(dataDir(), '.revive-backoff.json') }

interface ReviveBackoffState {
  consecutiveQuickDeaths: number
  lastSpawnMs: number
  backoffUntilMs: number
  // FIX b1 (TRDD-JJLI6GEH): true once the death that followed `lastSpawnMs` has already been
  // classified (quick-or-not) and its verdict saved. A hook that fires WHILE a hold is active reads
  // this as true and skips classification entirely — the classification always happened at the
  // FIRST hook to find the owner dead, before that hold existed, so re-checking later can never
  // fold the hold's own duration into the lifetime measurement. Cleared back to false the moment a
  // new spawn actually happens (see the "proceed" branch of reviveBackoffGate below).
  deathClassified: boolean
}

/** Fail-OPEN (zero state) on anything missing/unreadable/malformed — a torn read must never
 *  PERMANENTLY wedge the reviver; the worst case of guessing wrong here is one extra spawn, not a
 *  stuck outage. Never a partial merge of a corrupt object: any missing/wrong-typed field discards
 *  the whole record, so a half-written state (see the atomic-write comment below) can't be read as
 *  a plausible-looking but wrong count.
 *
 *  FIX b3 (TRDD-JJLI6GEH): a MISSING file (ENOENT — no crash has ever happened here) is the common,
 *  silent case and stays silent. A PRESENT-but-unreadable-or-malformed file is different: something
 *  wrote garbage where a real state lived, and that is worth one stderr line naming the file, even
 *  though we still fail open and carry on with a clean slate — "fails open" must not mean "fails
 *  open silently" once there was something on disk to lose. Reused by `reviveBackoffStatus()` below
 *  so `agentlenspro server status` reads the exact same state the gate itself acts on. */
function loadReviveBackoffState(): ReviveBackoffState {
  // A FRESH OBJECT every call, never the ZERO_BACKOFF_STATE constant itself: the gate mutates
  // the returned state in place, so returning the shared constant let one real-time call
  // poison every later reader in the same process — measured in a full-suite run, where a
  // test calling gate() with the default Date.now() stamped the shared object with a
  // real-now backoffUntilMs and every subsequent synthetic-now call observed a phantom hold.
  const zero = (): ReviveBackoffState => ({ consecutiveQuickDeaths: 0, lastSpawnMs: 0, backoffUntilMs: 0, deathClassified: false })
  const statePath = reviveBackoffStatePath()
  let text: string
  try {
    text = fs.readFileSync(statePath, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[agentlenspro] revive backoff: could not read ${statePath} (${(e as Error).message}) — starting from a clean state.\n`)
    }
    return zero()
  }
  try {
    const raw = JSON.parse(text) as Partial<ReviveBackoffState>
    if (
      typeof raw.consecutiveQuickDeaths === 'number' &&
      typeof raw.lastSpawnMs === 'number' &&
      typeof raw.backoffUntilMs === 'number' &&
      typeof raw.deathClassified === 'boolean'
    ) {
      return raw as ReviveBackoffState
    }
    process.stderr.write(`[agentlenspro] revive backoff: ${statePath} has an unexpected shape — discarding it and starting from a clean state.\n`)
  } catch (e) {
    process.stderr.write(`[agentlenspro] revive backoff: ${statePath} is not valid JSON (${(e as Error).message}) — discarding it and starting from a clean state.\n`)
  }
  return zero()
}

/** Atomic (temp + rename, via serverRuntime's atomicWriteFileSync) so two racing hook processes can
 *  never leave a torn/half-written record — the old mtime-only debounce this backoff sits beside was
 *  measured to race on 2 of 20 sampled spawns; a plain writeFileSync here would reintroduce the same
 *  class of bug one layer up. */
function saveReviveBackoffState(state: ReviveBackoffState): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true })
    atomicWriteFileSync(reviveBackoffStatePath(), JSON.stringify(state))
  } catch { /* best effort — a failed persist costs one mis-tracked spawn, not a hook failure */ }
}

function computeBackoffMs(consecutiveQuickDeaths: number): number {
  return Math.min(REVIVE_BACKOFF_MAX_MS, REVIVE_BACKOFF_BASE_MS * 2 ** (consecutiveQuickDeaths - 1))
}

/** The crash-loop gate. Called on every hook that reaches a genuine spawn DECISION — after every
 *  earlier "don't spawn" gate (pidfileOwnerAlive, NO_REVIVE, the disk brake) has already passed, and
 *  after the alcore binary itself resolved, so this only ever counts attempts that WOULD have
 *  spawned a real process; a merely-checked-and-skipped hook must never inflate the death count.
 *
 *  FIX b1 (TRDD-JJLI6GEH): classification and holding are two SEPARATE steps, in that order.
 *  Classification (quick-death-or-not) happens exactly ONCE per death — at the FIRST hook call to
 *  see `deathClassified === false` — using `now - lastSpawnMs` measured BEFORE any hold this
 *  classification produces is applied. Every later hook call, while the resulting hold is still
 *  active, finds `deathClassified === true` and skips straight to the hold check: it neither
 *  re-measures the elapsed time (which would now include the hold itself) nor re-increments the
 *  streak. Only once the hold has elapsed does a call fall through to "proceed", which stamps a
 *  fresh `lastSpawnMs` for the spawn about to happen and clears `deathClassified` so the NEXT death
 *  is measured fresh.
 *
 *  Returns true when the caller must hold off (and has already printed why); false when the caller
 *  should proceed to spawn. Exported so the state transitions are testable directly against a real
 *  (temp) data dir, without spawning a real alcore process per case. */
export function reviveBackoffGate(now: number = Date.now()): boolean {
  const state = loadReviveBackoffState()
  if (!state.deathClassified) {
    // Reset condition: the previous spawn (if any) is only "quick-died" when this — the FIRST hook
    // to notice — comes back sooner than REVIVE_CRASH_WINDOW_MS after it started. A run that
    // survived at least that long — however it eventually ended — proves the install works, so the
    // counter must not carry a stale grudge into an unrelated later failure.
    const quickDeath = state.lastSpawnMs > 0 && (now - state.lastSpawnMs) < REVIVE_CRASH_WINDOW_MS
    state.consecutiveQuickDeaths = quickDeath ? state.consecutiveQuickDeaths + 1 : 0
    const backoffMs = state.consecutiveQuickDeaths > 0 ? computeBackoffMs(state.consecutiveQuickDeaths) : 0
    state.backoffUntilMs = now + backoffMs
    state.deathClassified = true
    saveReviveBackoffState(state)
    if (state.consecutiveQuickDeaths > 0) {
      process.stderr.write(
        `[agentlenspro] reviving after ${state.consecutiveQuickDeaths} quick crash(es) in a row — will back off ` +
        `~${Math.round(backoffMs / 1000)}s longer if this one dies quickly too.\n`,
      )
    }
  }
  if (now < state.backoffUntilMs) {
    // VISIBLE, on purpose (card constraint): a silently-stopped reviver is an outage nobody can see.
    // stderr, not stdout — the hook's stdout contract (raw payload / gate verdict) must stay untouched.
    // (Also reported, non-silently, by `agentlenspro server status` — see reviveBackoffStatus below.)
    process.stderr.write(
      `[agentlenspro] revive backoff: ${state.consecutiveQuickDeaths} quick crash(es) in a row — holding off ` +
      `spawning a new server until ${new Date(state.backoffUntilMs).toISOString()}. ` +
      'Run `agentlenspro server start` to clear the backoff and try now.\n',
    )
    return true
  }
  // Not (or no longer) held: this call IS the next genuine spawn. Stamp when it happened and clear
  // the classification flag so the death that follows THIS spawn gets its own fresh verdict.
  // `backoffUntilMs` is deliberately left as-is here (now a PAST timestamp) rather than reset to
  // `now` — it is safe to leave stale: the only two readers are this same `now < state.backoffUntilMs`
  // check (which the very next classification overwrites before it is ever consulted again) and
  // `reviveBackoffStatus()` (which only ever observes a `backoffUntilMs` that is provably `<= now`
  // at read time, so it can never report a false "holding"). Leaving it saves a field we would
  // otherwise have to recompute for no observable benefit.
  saveReviveBackoffState({ ...state, lastSpawnMs: now, deathClassified: false })
  return false
}

/** Read-only snapshot for `agentlenspro server status` (serverControl.ts) — built on the SAME
 *  `loadReviveBackoffState()` read the gate itself uses (FIX b2, TRDD-JJLI6GEH), so status can
 *  never disagree with the gate about whether a hold is active. Without this, the gate's hold
 *  message only ever reached stderr from a hook Claude Code does not surface — an operator staring
 *  at a stalled revive had no way to discover WHY short of reading server.log by hand. */
export interface ReviveBackoffStatus { holding: boolean; consecutiveQuickDeaths: number; backoffUntilMs: number }
export function reviveBackoffStatus(now: number = Date.now()): ReviveBackoffStatus {
  const state = loadReviveBackoffState()
  return { holding: now < state.backoffUntilMs, consecutiveQuickDeaths: state.consecutiveQuickDeaths, backoffUntilMs: state.backoffUntilMs }
}

/** Lift the crash-loop backoff. Called on a deliberate `agentlenspro server start`/`restart`
 *  (serverControl.ts) — an operator who explicitly starts the server wants a clean slate, not a
 *  counter left over from a past incident silently throttling an unrelated future failure.
 *  Fail-open on a removal error, matching clearReviveBrake()'s sibling contract in serverControl.ts. */
export function resetReviveBackoff(): void {
  try { fs.rmSync(reviveBackoffStatePath(), { force: true }) } catch { /* best effort */ }
}

/** What a revive spawns — a function so a test can assert it without launching anything. The
 *  executable is THIS process's own node (`process.execPath`, never a bare `node` off PATH) running
 *  the cli.js that THIS bundle ships beside (cliJsPath() walks from __dirname, never cwd), so a
 *  revive can only run the build that triggered it. The env is the hook's full environment, which
 *  carries every AGENTLENS_* / *_PORT pin the operator set. */
export function reviveSpawnSpec(baseEnv: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  return { file: process.execPath, args: [cliJsPath(), 'server', 'revive'], env: { ...baseEnv, MIMALLOC_VERBOSE: '1' } }
}

/** Fire a DETACHED server revive without waiting (the hook must exit 0 fast). A short-TTL mtime lock
 *  collapses a burst of N hooks into ONE spawn; the server's own pidfile guard rejects a second
 *  canonical instance if two race. Never throws, never blocks. */
function reviveDaemonDetached(): void {
  try {
    const lock = path.join(dataDir(), '.daemon-revive.lock')
    try {
      const age = Date.now() - fs.statSync(lock).mtimeMs
      // Fresh lock ⇒ another hook already triggered a revive within the burst window. A just-written
      // lock's age is often a tiny NEGATIVE fraction (sub-ms mtime precision vs truncated Date.now()),
      // so the freshness window is [−skew, TTL): treat a slightly-future mtime as fresh, and re-arm
      // only on a genuinely OLD lock (age ≥ TTL) or an absurdly-future one (clock jump beyond skew).
      // The previous `age >= 0` guard rejected the sub-ms-future case and re-armed a fresh lock ~97%
      // of the time — a spurious double-revive (harmless: the server pidfile rejects a second instance).
      if (age > -REVIVE_LOCK_SKEW_MS && age < REVIVE_LOCK_TTL_MS) return
    } catch { /* no lock — proceed to claim it */ }
    try { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(lock, String(Date.now())) } catch { /* best effort */ }
    // The pidfile already names a live owner ⇒ the delivery failure was a timeout/503 while the
    // server was up, not a dead server — spawning a doomed twin only adds a refusal line. See
    // pidfileOwnerAlive() above for the measured cost this guard removes.
    if (pidfileOwnerAlive()) return
    // Spool-only mode: record the event to disk for the drain but do NOT auto-spawn the server.
    // Used by tests, and by anyone who supervises the daemon externally (launchd) and doesn't want
    // hooks spawning it. The lock is still written above so the stampede semantics are unchanged.
    //
    // TWO switches, because the env var alone cannot stop a revive in practice: a hook is spawned by
    // the AGENT (Claude Code), so it inherits THAT process's env — an operator watching a runaway
    // server has no way to inject AGENTLENS_NO_REVIVE into an already-running agent, and killing the
    // server just makes the next hook resurrect it. The on-disk flag is the out-of-band brake that a
    // human (or `agentlenspro server stop --stay-down`) can set from any shell, and it is honored by
    // every future hook process because each one re-reads it from the filesystem.
    if (process.env.AGENTLENS_NO_REVIVE === '1') return
    if (reviveDisabledOnDisk()) return
    // alcore is the only server this package ships (TRDD-1B98LCVR box 4). A hook has no one to
    // report a corrupt/missing install to, so it simply cannot revive.
    let alcore: string | null = null
    try { alcore = alcoreBin(process.env, undefined, undefined, resolveBinNativeDir()) } catch { return } // corrupt install: startServer reports it; a hook cannot
    if (!alcore) return // no engine resolvable — cannot revive
    // Crash-loop backoff — AFTER the binary resolved, so only a genuine spawn attempt is counted
    // (a corrupt/missing install already returned above without touching the backoff state).
    if (reviveBackoffGate()) return
    // A REVIVED server logs, exactly like a `server start`ed one (TRDD-4FMHW124). This used to be
    // `stdio: 'ignore'`, and the cost was measured: on 2026-08-22 the server was replaced at
    // 21:51 while `server.log` still ended at the 20:57 generation's boot — so the death that
    // triggered the revive, its reason, and everything the replacement did afterwards were all
    // unrecorded, and a reader consulting the log saw a quiet file.
    //
    // The sibling spawn site (`cli/serverControl.ts`) already ruled on this ABOUT ITSELF: "when
    // the server dies at boot the reason must be readable, or every failure looks like 'did not
    // become ready'" and sending the streams to /dev/null is "the one outcome the log exists to
    // prevent". Two spawn sites with opposite policies is the bug; the silent one was the path
    // taken PRECISELY when the server had just died, which is when the reason is worth most.
    //
    // Same fallback as there: if the log cannot be opened we still revive, silently, because a
    // resurrected-but-unlogged server beats no server. Unlike there we cannot report why — a hook
    // has no one to report to — so failing to open is simply not allowed to block the spawn.
    let outFd: number | 'ignore' = 'ignore'
    try {
      fs.mkdirSync(dataDir(), { recursive: true })
      outFd = fs.openSync(path.join(dataDir(), 'server.log'), 'a')
    } catch { /* keep 'ignore' — reviving matters more than logging it */ }
    try {
      // ONE start path (owner rule 2026-10-02, port guard): revive runs the CLI's own `server revive`
      // — the same ensureServer as `server start`, so it probes the ports, refuses a squatted pinned
      // port, and re-picks on a lost bind race — detached so the hook still exits at once. Spawning
      // alcore directly here bypassed all of that: a squatted port made every revive exit(1)
      // silently while the hook spool dropped its oldest events. The child's output goes to
      // server.log, so a refusal is readable. ensureServer stamps the provenance ('hook-revive',
      // TRDD-8VGQK9L9) and MIMALLOC_PURGE_DELAY (TRDD-2JOIAH2G R1); MIMALLOC_VERBOSE (rounds 58-60
      // probe: option dump at boot, exit stats at an rss_guard kill) rides through its inherited env.
      const spec = reviveSpawnSpec()
      const child = spawn(spec.file, spec.args, { cwd: dataDir(), env: spec.env, detached: true, stdio: ['ignore', outFd, outFd] })
      child.unref()
    } finally {
      // The CHILD holds its own duplicate of the descriptor, so the parent must drop its copy or
      // every hook invocation leaks one — and hooks run on every tool call, which turns a leak into
      // EMFILE rather than a slow drip.
      //
      // `finally`, NOT a sequential statement: `spawn` can throw synchronously (EMFILE, EAGAIN,
      // ENOENT on the interpreter), and the outer `catch` swallows it under the hook's
      // never-throw contract — so a plain next-line close is skipped SILENTLY on exactly the
      // failure that is already about descriptor exhaustion. The close deserves the guarantee the
      // comment above claims for it.
      if (typeof outFd === 'number') { try { fs.closeSync(outFd) } catch { /* already gone */ } }
    }
  } catch { /* best effort — a hook must never throw */ }
}

/** Exported so the status-line wrapper reads stdin through the SAME implementation — it needs the
 *  identical "a closed/absent stdin resolves rather than hangs" behavior, and two copies of that
 *  rule would be two places for it to rot. */
export function readStdin(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    // A closed/absent stdin must not hang the hook — resolve with whatever arrived.
    stream.on('error', () => resolve(Buffer.concat(chunks)))
  })
}

/** Forward one lifecycle payload. Never throws — the fire-and-forget contract. On ANY delivery
 *  failure (server down, timeout, or a non-2xx like a 503 shed under load) the event is durably
 *  SPOOLED and a detached daemon revive is fired, so no hook a live Claude instance emits is lost
 *  (D3K7QM2P/1a) — the previous behavior silently dropped it. */
export async function forwardHookEvent(
  payload: Buffer,
  opts: { baseUrl?: string; timeoutMs?: number; path?: string; spool?: boolean } = {},
): Promise<void> {
  const base = opts.baseUrl ?? uiBaseUrl()
  const apiPath = opts.path ?? '/api/hook-events'
  // Number(env)||default, NOT Number(env||default): a non-numeric value like "2s" must fall back to
  // the default, not become NaN → AbortSignal.timeout(NaN) throws → swallowed → silent spool-only.
  // Default 2s (1s before 2026-09-05, TRDD-GXKRBK1Q: doubled with the settings.json ceilings).
  const timeoutMs = opts.timeoutMs ?? Math.max(200, (Number(process.env.AGENTLENS_HOOK_TIMEOUT) || 2) * 1000)
  try {
    const res = await fetch(`${base}${apiPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new Uint8Array(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.ok) return // delivered + ingested — nothing to spool
    // A non-2xx means NOT ingested (e.g. admission-control 503 under 20-instance load, or a
    // transient error). Fall through to spool + revive, exactly as for a connection failure.
  } catch { /* server down / timeout — fall through to spool + revive */ }
  // opts.spool === false is for the status-line stream ONLY. Those arrive ~30/min PER SESSION (396/min
  // measured across 13), so spooling them would fill the shared 20k hook-spool in under an hour and
  // start dropping its OLDEST entries — which are the lifecycle events (StopFailure, PreCompact) that
  // exist precisely because nothing else records them. A few minutes of a 3-second sample series is a
  // cheap loss; a discarded rate-limit turn death is not. The revive still fires either way.
  if (opts.spool !== false) spoolHookEvent(payload)
  reviveDaemonDetached()
}

/** Run one gate check. Returns the server's response body ('' = allow / any failure). */
export async function runGateCheck(payload: Buffer, opts: { baseUrl?: string; timeoutMs?: number } = {}): Promise<string> {
  if (gateDisabled()) return '' // kill-switch BEFORE any network
  if (skipGateRoundTrip(payload)) return '' // non-image Read, or the guard is off — no network
  const base = opts.baseUrl ?? uiBaseUrl()
  // Number(env)||default (see forwardHookEvent): "2s" must fall back to 2, not NaN → throw → fail-open.
  // Default 4s (2s before 2026-09-05, TRDD-GXKRBK1Q) — still inside the 10s settings.json ceiling.
  const timeoutMs = opts.timeoutMs ?? Math.max(200, (Number(process.env.AGENTLENS_GATE_TIMEOUT) || 4) * 1000)
  try {
    const res = await fetch(`${base}/api/agent-gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new Uint8Array(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    // A non-2xx is a FAILURE, not a verdict — fail-open. Returning a 5xx error page here would write
    // "Internal Server Error" to the gate's stdout, which the model reads as a deny/advisory and could
    // block the tool call (the exact opposite of the fail-open contract). forwardHookEvent guards the
    // same way with its res.ok check.
    if (!res.ok) return ''
    return await res.text()
  } catch { return '' } // server down / timeout — allow silently
}

/** Process entry for `agentlenspro hook` / `agentlenspro gate`. Always resolves 0. */
export async function runHookCommand(kind: 'hook' | 'gate'): Promise<number> {
  // GLOBAL kill-switch, first thing and before stdin: `<dataDir>/DISABLED` disarms the lifecycle and gate hooks in
  // every RUNNING Claude session on the next fire — the only channel that reaches an agent whose
  // env and config were fixed at launch (see killSwitch.ts; 13 stale sessions kept writing through
  // a settings edit during the 2026-07-14 SSD incident). Returning 0 with no output is a no-op for
  // a hook and an ALLOW for the gate — a disabled AgentlensPro must never block the user's work.
  if (agentlensDisabled()) { return 0 }
  // The gate kill-switch must short-circuit BEFORE stdin is read: the runner may hold the
  // pipe open, and a disabled gate must cost nothing (matches spy-agentlens-gate.sh).
  if (kind === 'gate' && gateDisabled()) return 0
  const payload = await readStdin(process.stdin)
  if (kind === 'hook') {
    await forwardHookEvent(payload)
  } else {
    const out = await runGateCheck(payload)
    if (out) process.stdout.write(out)
  }
  return 0
}
