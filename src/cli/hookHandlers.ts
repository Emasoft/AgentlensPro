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
import { uiBaseUrl, dataDir } from './cliCore'
import { findServerJs } from './serverControl'

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
 *  the only brake that actually reaches the hook. Fail-OPEN (a stat error ⇒ not disabled): a
 *  filesystem hiccup must not silently stop ingestion. */
export function reviveDisabledOnDisk(): boolean {
  try { return fs.existsSync(path.join(dataDir(), 'NO_REVIVE')) } catch { return false }
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
    let serverJs: string
    try { serverJs = findServerJs() } catch { return } // no bundle resolvable — cannot revive
    const child = spawn(process.execPath, ['--max-old-space-size=6144', serverJs], {
      cwd: path.dirname(path.dirname(serverJs)),
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch { /* best effort — a hook must never throw */ }
}

function readStdin(stream: NodeJS.ReadableStream): Promise<Buffer> {
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
export async function forwardHookEvent(payload: Buffer, opts: { baseUrl?: string; timeoutMs?: number } = {}): Promise<void> {
  const base = opts.baseUrl ?? uiBaseUrl()
  const timeoutMs = opts.timeoutMs ?? Math.max(200, Number(process.env.AGENTLENS_HOOK_TIMEOUT || 1) * 1000)
  try {
    const res = await fetch(`${base}/api/hook-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new Uint8Array(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.ok) return // delivered + ingested — nothing to spool
    // A non-2xx means NOT ingested (e.g. admission-control 503 under 20-instance load, or a
    // transient error). Fall through to spool + revive, exactly as for a connection failure.
  } catch { /* server down / timeout — fall through to spool + revive */ }
  spoolHookEvent(payload)
  reviveDaemonDetached()
}

/** Run one gate check. Returns the server's response body ('' = allow / any failure). */
export async function runGateCheck(payload: Buffer, opts: { baseUrl?: string; timeoutMs?: number } = {}): Promise<string> {
  if ((process.env.AGENTLENS_GATE || 'on') === 'off') return '' // kill-switch BEFORE any network
  const base = opts.baseUrl ?? uiBaseUrl()
  const timeoutMs = opts.timeoutMs ?? Math.max(200, Number(process.env.AGENTLENS_GATE_TIMEOUT || 2) * 1000)
  try {
    const res = await fetch(`${base}/api/agent-gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new Uint8Array(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return await res.text()
  } catch { return '' } // server down / timeout — allow silently
}

/** Process entry for `agentlenspro hook` / `agentlenspro gate`. Always resolves 0. */
export async function runHookCommand(kind: 'hook' | 'gate'): Promise<number> {
  // The gate kill-switch must short-circuit BEFORE stdin is read: the runner may hold the
  // pipe open, and a disabled gate must cost nothing (matches spy-agentlens-gate.sh).
  if (kind === 'gate' && (process.env.AGENTLENS_GATE || 'on') === 'off') return 0
  const payload = await readStdin(process.stdin)
  if (kind === 'hook') {
    await forwardHookEvent(payload)
  } else {
    const out = await runGateCheck(payload)
    if (out) process.stdout.write(out)
  }
  return 0
}
