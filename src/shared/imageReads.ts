// Which Read calls are IMAGE reads — the one definition, shared by the two sides that must agree.
//
// Runtime-neutral by construction (no Node, no DOM) because it is imported by BOTH the server's
// gate evaluator (src/agentGate.ts) and the CLI hook handler (src/cli/hookHandlers.ts). The CLI
// needs it to answer "can I skip the round-trip?" locally: once `Read` is in GATE_MATCHER the hook
// fires on EVERY file read, and a session does far more of those than agent launches. Without a
// local pre-filter each one would cost a process spawn plus an HTTP call to decide "not an image" —
// paying the guard's full price on the 99% of reads it has nothing to say about.
//
// Two copies of this predicate would be worse than the round-trip: they would drift, and the drift
// is silent in the safe-looking direction (the CLI skips a read the server would have warned on).

/** Extensions Claude Code renders as an IMAGE content block.
 *  `.pdf` is included — Read renders PDF pages visually.
 *  `.svg` is NOT — it arrives as text/XML source and costs tokens like any other file, so warning
 *  about it would be noise, and noise is how a guard earns its way onto the ignore list. */
export const IMAGE_READ_EXT = /\.(png|jpe?g|gif|webp|bmp|pdf)$/i

/** True when a Read tool_input targets a file Claude Code will render as an image block.
 *  Anything path-less or non-string answers false: no path, no claim.
 *  Declared as a type PREDICATE so callers get `string` narrowing for free and cannot end up
 *  hand-writing a second `typeof === 'string'` check that could drift from this one. */
export function isImageReadPath(filePath: unknown): filePath is string {
  return typeof filePath === 'string' && IMAGE_READ_EXT.test(filePath)
}
