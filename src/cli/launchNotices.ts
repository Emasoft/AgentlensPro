// The launch install check's notice lines, held back while one CLI invocation decides where they belong
// (TRDD-YL3EWT6N item 7).
//
// WHY this exists: the exit-2 contract (skills/agentlenspro-diagnostics/SKILL.md) promises that a REFUSED tool
// call prints exactly one JSON object on stderr and nothing on stdout. The per-launch install check runs BEFORE the
// verb and used to print its notices ("first run …", "restored …", the stale-env warning) straight to stderr, so a
// consumer's `JSON.parse(stderr)` failed whenever that launch repaired or warned. The check now hands its lines
// here; a single tool call that refuses folds them into its JSON (`notices`), and every other path prints them on
// stderr exactly as before (main.ts decides for its own verbs, diagnosticsCli for its own sub-commands).
//
// Process-global on purpose — one CLI invocation is one process — and reset by cliMain at the start of every
// invocation, so two in-process calls (the tests) can never leak lines into each other.

let pending: string[] = []

// True only between cliMain's beginLaunchNotices and endLaunchNotices: outside an invocation nothing holds lines.
let active = false

/** Start an empty buffer and mark an invocation active. cliMain calls this once at the start of every invocation. */
export function beginLaunchNotices(): void {
  pending = []
  active = true
}

/** The invocation is over: from here on a notice prints at once (pushNotice). cliMain calls this in its finally,
 *  after the last flush. */
export function endLaunchNotices(): void {
  active = false
}

/** Hold one notice line — the launch check's `say` (autoSetup.ts maybeAutoSetup). OUTSIDE a cliMain invocation (no
 *  beginLaunchNotices without its endLaunchNotices) the line prints on stderr at once: a caller that is not inside
 *  cliMain has nobody to flush the buffer, and a held line there would vanish without a trace. */
export function pushNotice(line: string): void {
  if (!active) { process.stderr.write(`${line}\n`); return }
  pending.push(line)
}

/** Drain and return every held line. A refusal folds them into its JSON (diagnosticsCli emit). */
export function takeNotices(): string[] {
  const out = pending
  pending = []
  return out
}

/** Print every held line on stderr now, in order, and drain the buffer. Calling it again prints nothing. */
export function flushNoticesToStderr(): void {
  for (const line of takeNotices()) process.stderr.write(`${line}\n`)
}
