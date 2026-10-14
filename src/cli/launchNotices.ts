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

/** Start an empty buffer. cliMain calls this once at the start of every invocation. */
export function beginLaunchNotices(): void {
  pending = []
}

/** Hold one notice line — the launch check's `say` (autoSetup.ts maybeAutoSetup). */
export function pushNotice(line: string): void {
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
