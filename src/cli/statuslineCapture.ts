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
// THE SCRIPT IS A DUMB PIPE. Read stdin, POST it, exit. No state file, no digest, no client-side
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
// ~3s away. Nothing is half-written because nothing is written locally at all.

import { spawn } from 'child_process'
import { forwardHookEvent, readStdin } from './hookHandlers'
import { agentlensDisabled } from './killSwitch'

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

/** Tight by design: this runs on the render path. The child dominates it, but a hung socket must
 *  not hold the status line hostage — a dropped sample is invisible, a frozen status line is not. */
function captureTimeoutMs(): number {
  return Math.max(100, Number(process.env.AGENTLENS_STATUSLINE_TIMEOUT_MS) || 700)
}

/** Stamp the payload with the event name the server requires, leaving every other field verbatim.
 *  Exported so a test can pin that no field is dropped or rewritten on the way through. */
export function toStatuslineRecord(payload: Buffer, ev: string = STATUSLINE_EV): Buffer | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload.toString('utf-8'))
  } catch {
    return null // a payload shape we cannot read is not one we should be storing
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  // `hook_event_name` last: the server rejects a payload without it, and this module is the thing
  // asserting it — a status-line blob that somehow carried its own must not win over ours.
  return Buffer.from(JSON.stringify({ ...(parsed as Record<string, unknown>), hook_event_name: ev }))
}

/** Forward one status-line payload to the server. Never throws, never writes to stdout, never
 *  reports failure: a telemetry sample that can break the status line would be worse than no
 *  telemetry at all. Delivery failures spool + revive inside forwardHookEvent, so a sample taken
 *  while the server is down is not lost. */
export async function captureStatusline(payload: Buffer, ev: string = STATUSLINE_EV): Promise<void> {
  try {
    if (agentlensDisabled()) return // the global brake reaches sessions already running
    const record = toStatuslineRecord(payload, ev)
    if (!record) return
    await forwardHookEvent(record, { timeoutMs: captureTimeoutMs() })
  } catch { /* contract 2: capture cannot fail the wrapper */ }
}

/** Split `--inner <command>` out of the wrapper's own argv. The inner command is carried as ONE
 *  shell string and re-run through a shell, because that is exactly how Claude Code itself runs
 *  it — anything less would silently break a status line that uses a pipe, a quote or a glob. */
export function parseStatuslineArgs(argv: string[]): { inner: string | null; subagent: boolean } {
  let inner: string | null = null
  let subagent = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--inner') inner = argv[i + 1] ?? null
    else if (argv[i] === '--subagent') subagent = true
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

/** Process entry for `agentlenspro statusline`. */
export async function runStatuslineCommand(argv: string[]): Promise<number> {
  const { inner, subagent } = parseStatuslineArgs(argv)
  const payload = await readStdin(process.stdin)

  // Both started before either is awaited: the capture rides alongside the child instead of being
  // serialized in front of (or behind) the render.
  const captured = captureStatusline(payload, subagent ? SUBAGENT_STATUSLINE_EV : STATUSLINE_EV)
  const code = inner ? await runInner(inner, payload) : 0
  await captured

  // We report the INNER command's exit code, and 0 when there is no inner command or it could not
  // be spawned. Never our own failure: a non-zero exit blanks the status line, so a broken capture
  // would take the user's status line down with it.
  return code
}
