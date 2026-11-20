// src/cli/statuslineCapture.ts — `agentlenspro statusline --inner '<real command>'`
//
// WHY A WRAPPER AND NOT A SECOND HOOK. `statusLine` is NOT a hook event. `hooks` is a map of
// event name → array of matchers, so any number of tools can register on the same event; the
// status line is a SINGLE top-level object with one `command` string, and settings scopes
// OVERRIDE rather than merge. There is therefore no way to add a second status-line entry beside
// an existing one — a capture can only exist by wrapping the command that is already there and
// passing its stdout through untouched.
//
// WHAT THE PAYLOAD IS WORTH. Claude Code pipes the status line a JSON blob carrying signals
// nothing else on this machine exposes together: the subscription rate-limit windows
// (rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}) attributed by construction to
// the account THIS session bills to; the live context window split into
// input/output/cache_creation/cache_read; the harness's own tier-aware cost.total_cost_usd; and
// `prompt_id`, which the docs specify matches the `prompt.id` attribute on the OpenTelemetry
// events — a real join key between this sample and the span store. The payload is forwarded
// VERBATIM, never an allowlist of fields: an allowlist silently drops whatever the next Claude
// Code version adds, and the store's whole value is being able to ask questions later that
// nobody thought to ask when the capture was written.
//
// THE SCRIPT IS A DUMB PIPE. Read stdin, POST it, exit. When no server takes the sample it is appended
// to the store's own write-ahead file instead (TRDD-VS1FCUMU). No digest, no client-side
// filtering — the same contract standalone/server.ts states for the lifecycle hooks. Any thinning
// of the sample stream belongs on the SERVER, which is the only place that can see every session
// at once; a filter here would be N independent filters that each guess.
//
// THE THREE CONTRACTS, each of which is a way to break the user's status line:
//   1. PASS-THROUGH IS SACRED. The inner command's stdout is inherited (it writes straight to our
//      fd — no copy, no buffering) and its exit code becomes ours. Claude Code blanks the status
//      line on a non-zero exit or empty stdout, so capture may never influence either.
//   2. CAPTURE IS FIRE-AND-FORGET. It runs CONCURRENTLY with the child, never before it, and
//      cannot throw. The child costs 140-530ms here; a localhost POST costs ~5ms, so the capture
//      hides entirely behind it and adds nothing measurable to the render.
//   3. NOTHING OF OURS REACHES STDOUT. Only the real status-line script writes to the context.
//
// CANCELLATION. Claude Code debounces at 300ms and CANCELS an in-flight script when a new update
// triggers, so a killed capture must be harmless — it is: a lost sample, with the next tick
// ~3s away. The only local write is one O_APPEND line to the write-ahead file, made after the POST
// failed or at the render deadline: a kill before it loses that one sample, never half a line.

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { dataDir } from './cliCore'
import { forwardHookEvent, pidfileOwnerAlive, readStdin } from './hookHandlers'
import { alcoreBin, resolveBinNativeDir } from './serverControl'
import { dayKey, flattenSample } from '../statuslineStore'

/** The `ev` these samples are stored under. Deliberately NOT a real Claude Code hook event name:
 *  the server accepts any non-empty `hook_event_name`, so reusing the hook-event store gives us
 *  daily buckets, retention/purge, disk accounting, the in-memory ring and
 *  `GET /api/hook-events?ev=…` for free — but a consumer enumerating genuine lifecycle events
 *  must not mistake a status-line sample for one. */
export const STATUSLINE_EV = 'StatusLineSample'

/** The SECOND status-line surface: `subagentStatusLine` is its own settings key with its own
 *  command, and its payload is the one place Claude Code publishes PER-SUBAGENT context cost —
 *  a `tasks[]` array of {id, name, type, status, description, label, startTime, model, effort,
 *  contextWindowSize, tokenCount, tokenSamples, cwd}. `tokenCount` against `contextWindowSize`
 *  gives each live subagent's context fill, `effort` gives the reasoning tier it actually runs at,
 *  and `cwd` distinguishes worktree-isolated agents. Nothing else on this machine exposes any of
 *  it: the JSONL transcripts do not record a subagent's context size, and a subagent's own
 *  requests cannot be reliably paired back to the parent that launched them.
 *
 *  Capture here is safer than on the main line: the docs specify that omitting a task's `id` from
 *  the output keeps that row's DEFAULT rendering, so a wrapper that prints nothing changes nothing
 *  — whereas empty output on the main status line blanks it. */
export const SUBAGENT_STATUSLINE_EV = 'SubagentStatusLineSample'

/** Samples go to their OWN endpoint, never /api/hook-events. Sharing the lifecycle bucket was
 *  measurably destructive: at 396 samples/min they evicted the server's 600-slot lifecycle ring down
 *  to an ~87 s span (blinding check_burn_risk's 5- and 10-minute windows) and consumed the unfiltered
 *  1000-record budget that GET /api/lifecycle-events reads, silently truncating the timeline. */
export const STATUSLINE_ENDPOINT = '/api/statusline-samples'

/** Tight by design: this runs on the render path. The child dominates it, but a hung socket must
 *  not hold the status line hostage — a dropped sample is invisible, a frozen status line is not. */
function captureTimeoutMs(): number {
  return Math.max(100, Number(process.env.AGENTLENS_STATUSLINE_TIMEOUT_MS) || 700)
}

/** How long the wrapper will wait for the capture AFTER the inner command has finished.
 *
 *  The capture already had the child's entire runtime (140-530ms) to complete, and a localhost POST
 *  costs ~5ms — so in the healthy case it is long done and this budget is never spent. It exists for
 *  the case contract 2 is written about: a server that ACCEPTS the connection and never answers.
 *  There the capture runs to its full timeout, and awaiting it unconditionally is what turns a wedged
 *  server into a frozen status line.
 *
 *  MEASURED: `statusline --inner 'echo hi'` took 102ms against a healthy server and **787ms** against
 *  an endpoint that drops — past Claude Code's own 300ms debounce, on every render. Tonight's server
 *  OOM produced exactly that state (accepting, not answering) before the process died.
 *
 *  At the deadline the sample is appended locally (storeLocally), so cutting the wait loses nothing. */
function residualCaptureMs(): number {
  return Math.max(0, Number(process.env.AGENTLENS_STATUSLINE_RESIDUAL_MS) || 50)
}

/** Local, not cliCore's: this file runs on the render path and has deliberately narrow imports. */
const delay = (ms: number): Promise<void> => new Promise(r => { const t = setTimeout(r, ms); t.unref?.() })

/** Stamp the payload with which stream it came from, leaving every other field verbatim.
 *  Exported so a test can pin that no field is dropped or rewritten on the way through.
 *
 *  `hook_event_name` is still stamped even though these no longer go to /api/hook-events: a NEW CLI
 *  talking to an OLD server must still be ingestible, and the old server requires that field. The new
 *  server reads `statusline_stream` and routes on it. Both stamps are two extra keys on a 1.5 KB
 *  payload and they make the version skew a non-event in both directions. */
export function toStatuslineRecord(payload: Buffer, ev: string = STATUSLINE_EV): Buffer | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload.toString('utf-8'))
  } catch {
    return null // a payload shape we cannot read is not one we should be storing
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  // Ours last: a status-line blob that somehow carried either key must not win over what this
  // module is asserting about where the sample came from.
  return Buffer.from(JSON.stringify({
    ...(parsed as Record<string, unknown>),
    hook_event_name: ev,
    statusline_stream: ev === SUBAGENT_STATUSLINE_EV ? 'subagent' : 'main',
  }))
}

// ── TRDD-VS1FCUMU: the sample is stored with or without a server ─────────────────────────────────
// Owner order 2026-11-18: "status line hook must be digested at all times. disable must never disable
// the status line hook. just calling some fast binary to add the data to the duckdb. no need for the
// full server to be online."
// The hook APPENDS (one O_APPEND line, no child process on the render path); the binary only COMPACTS
// (`alcore statusline-seal`, started detached and rarely by maybeKickSeal).

/** Append one sample as the server's exact NDJSON line (`flattenSample` + `ts`; the server also keeps
 *  the `hook_event_name`/`statusline_stream` stamps) to
 *  `<dataDir>/statusline/<stream>/<UTC day>/wal-cli.ndjson`. Both store readers union every
 *  `wal-*.ndjson`, so the sample is queryable at once, with no server and no sealing.
 *  One appendFileSync = one O_APPEND write, no fsync. Throws on failure; the caller's catch is contract 2.
 *  `created` is true when this append made today's file (the day turned, or the sealer took the last one). */
export function appendSampleToDisk(record: Buffer): { file: string; created: boolean } {
  const flat = flattenSample(JSON.parse(record.toString('utf-8')) as Record<string, unknown>)
  const ts = Date.now()
  flat.ts = ts
  const stream = flat.statusline_stream === 'subagent' ? 'subagent' : 'main'
  const dir = path.join(dataDir(), 'statusline', stream, dayKey(ts))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'wal-cli.ndjson')
  const created = !fs.existsSync(file)
  fs.appendFileSync(file, JSON.stringify(flat) + '\n')
  return { file, created }
}

/** Bytes at which today's write-ahead file is worth sealing. The SAME variable and default as the
 *  sealer's `cli_seal_bytes` (rust-core statusline_store.rs), so a started sealer always finds work. */
function cliSealBytes(): number {
  const n = Number(process.env.AGENTLENS_STATUSLINE_CLI_SEAL_BYTES)
  return Number.isFinite(n) && n > 0 ? n : 16 * 1024 * 1024
}

/** No second sealer start within this window, whatever the first one did (lock busy, nothing to do,
 *  failed): without it a file sitting over the threshold would start a process on every render. */
export const SEAL_KICK_MIN_GAP_MS = 30_000

/** The detached sealer appends its output here (TRDD-RTHA7EWK item 5). Over this size the file is
 *  rotated to `<name>.1` (an older `.1` is replaced) before the next open, so the log stays bounded. */
const SEAL_LOG_MAX_BYTES = 1024 * 1024

/** Open `<dataDir>/statusline-seal.log` for append, rotating it first when it is over SEAL_LOG_MAX_BYTES.
 *  Returns undefined when the log cannot be opened: the sealer is then started with stdio ignored, because
 *  a log problem must never stop the seal, and never throws out of the hook. */
function openSealLog(): number | undefined {
  try {
    const log = path.join(dataDir(), 'statusline-seal.log')
    try {
      if (fs.statSync(log).size > SEAL_LOG_MAX_BYTES) fs.renameSync(log, `${log}.1`)
    } catch { /* no log yet, or it cannot be rotated: opening below decides */ }
    return fs.openSync(log, 'a')
  } catch {
    return undefined
  }
}

/** Start `alcore statusline-seal` detached, and only when all of these hold:
 *   - this append created today's file (yesterday's file is now complete) or the file reached the
 *     seal threshold. A size test and a "created" flag, not a timer: both are O(1) on the render path;
 *   - AGENTLENS_NO_REVIVE is not 1 (the one brake for every detached process a hook starts);
 *   - no start in the last SEAL_KICK_MIN_GAP_MS (stamp file `<dataDir>/statusline/.seal-kick`);
 *   - no live server owns the data dir (its own 60 s chore seals, this file included).
 *  The sealer holds the store's seal lock and runs at nice 15; it never binds a port. Never throws. */
function maybeKickSeal(appended: { file: string; created: boolean }): void {
  try {
    if (process.env.AGENTLENS_NO_REVIVE === '1') return
    if (!appended.created && fs.statSync(appended.file).size < cliSealBytes()) return
    const stamp = path.join(dataDir(), 'statusline', '.seal-kick')
    try {
      if (Date.now() - fs.statSync(stamp).mtimeMs < SEAL_KICK_MIN_GAP_MS) return
    } catch { /* no stamp yet: this is the first start */ }
    if (pidfileOwnerAlive()) return
    const alcore = alcoreBin(process.env, undefined, undefined, resolveBinNativeDir())
    if (!alcore) return
    fs.writeFileSync(stamp, String(Date.now()))
    // TRDD-RTHA7EWK item 5: the sealer's stdout and stderr (what it sealed, why it refused a file) were
    // thrown away with stdio 'ignore', so a refused write-ahead file left no trace outside the server log.
    // The detached child gets its own dup of the fd, so this process closes its copy right after spawn.
    const logFd = openSealLog()
    try {
      spawn(alcore, ['statusline-seal', '--data-dir', dataDir()], {
        detached: true,
        stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
      }).unref()
    } finally {
      if (logFd !== undefined) fs.closeSync(logFd)
    }
  } catch { /* contract 2: a sealer that cannot start loses nothing, the lines stay readable in the write-ahead file */ }
}

/** One capture's progress: `done` = the POST attempt has settled; `stored` = the sample was appended
 *  locally. Two code paths can reach the local append (a failed POST, and the render deadline with the
 *  POST still pending); `stored` makes it happen once. */
interface CaptureState { stored: boolean; done: boolean }

function storeLocally(record: Buffer, state: CaptureState): void {
  if (state.stored) return
  state.stored = true
  try {
    maybeKickSeal(appendSampleToDisk(record))
  } catch { /* contract 2: capture cannot fail the wrapper */ }
}

/** POST one record; when the server did not take it, store it locally. Never throws. */
async function captureRecord(record: Buffer, state: CaptureState): Promise<void> {
  try {
    const delivered = await forwardHookEvent(record, {
      path: STATUSLINE_ENDPOINT,
      timeoutMs: captureTimeoutMs(),
      // Do NOT spool: see the note in forwardHookEvent. At this rate the shared hook-spool would
      // evict the lifecycle events it exists to protect. The store's own write-ahead file is the
      // durable path for a sample the server did not take.
      spool: false,
    })
    if (!delivered) storeLocally(record, state)
  } catch { /* contract 2: capture cannot fail the wrapper */ }
  state.done = true
}

/** Forward one status-line payload to the server. Never throws, never writes to stdout, never
 *  reports failure: a telemetry sample that can break the status line would be worse than no
 *  telemetry at all. It POSTS whether or not the kill switch is armed: the switch stops only the
 *  collection of telemetry and raw bodies, and the server in no-collection mode still stores these
 *  samples. Delivery is NOT spooled (spool false, see captureRecord). A sample the server did not take
 *  is appended to the store's own write-ahead file by storeLocally (TRDD-VS1FCUMU), so it is not lost. */
export async function captureStatusline(payload: Buffer, ev: string = STATUSLINE_EV): Promise<void> {
  const record = toStatuslineRecord(payload, ev)
  if (!record) return
  await captureRecord(record, { stored: false, done: false })
}

/** Split `--inner <command>` out of the wrapper's own argv. The inner command is carried as ONE
 *  shell string and re-run through a shell, because that is exactly how Claude Code itself runs
 *  it — anything less would silently break a status line that uses a pipe, a quote or a glob. */
export function parseStatuslineArgs(argv: string[]): { inner: string | null; subagent: boolean } {
  let inner: string | null = null
  let subagent = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--inner') {
      // A flag where the command should be means the wrapper was installed wrong (`--inner
      // --subagent` would otherwise run `sh -c "--subagent"`). Treat it as ABSENT rather than
      // throwing or running it: both of those exit non-zero, and contract 1 is that a non-zero exit
      // BLANKS the user's status line. Capture-only is a real, documented mode; a blank status line
      // is the worst outcome this file has. Nothing is reported because contract 3 forbids writing
      // anywhere the user would see.
      const v = argv[i + 1]
      inner = v === undefined || v.startsWith('--') ? null : v
    } else if (argv[i] === '--subagent') subagent = true
  }
  return { inner, subagent }
}

/** Run the inner status-line command with our stdin, inheriting stdout so its bytes reach Claude
 *  Code untouched. Resolves with its exit code. */
function runInner(inner: string, payload: Buffer): Promise<number> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.env.SHELL || '/bin/sh', ['-c', inner], { stdio: ['pipe', 'inherit', 'inherit'] })
    } catch {
      return resolve(0) // could not spawn — see the exit-code note in runStatuslineCommand
    }
    // A child that exits without draining stdin makes the write fail with EPIPE. That is its
    // prerogative, not an error of ours, so the handler is required — an unhandled 'error' on a
    // stdio stream is a process-level throw, which would blank the status line.
    child.stdin?.on('error', () => { /* child closed stdin early */ })
    try { child.stdin?.end(payload) } catch { /* same */ }
    child.on('error', () => resolve(0))
    child.on('close', (code) => resolve(typeof code === 'number' ? code : 0))
  })
}

/** Process entry for `agentlenspro statusline`.
 *
 *  `stdin` is a parameter purely so the wrapper's own contracts can be tested: `process.stdin` yields
 *  exactly one EOF per process, so a suite asserting more than one invocation hangs on the second.
 *  Production passes nothing and gets `process.stdin`. */
export async function runStatuslineCommand(
  argv: string[], stdin: NodeJS.ReadableStream = process.stdin,
): Promise<number> {
  const { inner, subagent } = parseStatuslineArgs(argv)
  const payload = await readStdin(stdin)

  // Both started before either is awaited: the capture rides alongside the child instead of being
  // serialized in front of (or behind) the render.
  const record = toStatuslineRecord(payload, subagent ? SUBAGENT_STATUSLINE_EV : STATUSLINE_EV)
  const state: CaptureState = { stored: false, done: false }
  const captured = record ? captureRecord(record, state) : Promise.resolve()
  const code = inner ? await runInner(inner, payload) : 0
  // Bound the wait to a RESIDUAL budget once the render is done. Awaiting the capture outright made
  // a wedged server cost 787ms per render (102ms healthy) — the capture's own timeout, paid on the
  // render path, which is the exact hostage-taking contract 2 forbids.
  //
  // With NO inner command there is no render to hold up (a capture-only surface writes nothing), so
  // the capture is allowed to finish: the reason to cut it short does not exist there.
  await (inner ? Promise.race([captured, delay(residualCaptureMs())]) : captured)
  // TRDD-VS1FCUMU: the deadline passed with the POST still pending (a server that accepted and does
  // not answer). The sample is stored locally NOW, because this process exits next and the pending
  // POST dies with it. The server may still store the same sample from the request it already holds:
  // a duplicate row is accepted (the stream is re-sampled many times per turn and the views read
  // per-turn buckets and cumulative deltas), a lost sample is not.
  if (record && !state.done) storeLocally(record, state)

  // We report the INNER command's exit code, and 0 when there is no inner command or it could not
  // be spawned. Never our own failure: a non-zero exit blanks the status line, so a broken capture
  // would take the user's status line down with it.
  return code
}
