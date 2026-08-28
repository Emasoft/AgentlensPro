// src/shellTemplate.ts — the dashboard shell's token substitution (TRDD-VHH7FXGC).
//
// media/index.html carries `@@NAME@@` tokens that the server fills with generated values, three of
// which are JSON built from ingested session data — prompt text, file paths, agent output. The
// substitution MUST be a single left-to-right scan: a chain of `replace` calls rescans the output of
// each step, so a session whose prompt is the literal `@@SIDEBAR_INIT_JSON@@` would have the sidebar
// JSON spliced INTO the summary JSON string, terminating the literal and executing the rest as
// JavaScript in the dashboard's origin (review of 85f0b08, F1). The Rust twin is
// ui.rs::substitute_tokens; both must keep this shape.
//
// An unknown token is left verbatim (it is not the server's to invent), and the callback form of
// replace is load-bearing: a string replacement interprets `$&` / `$1` in the inlined JSON.

const TOKEN = /@@[A-Z_]+@@/g

export function substituteTokens(template: string, values: Record<string, string>): string {
  return template.replace(TOKEN, (t) => (Object.prototype.hasOwnProperty.call(values, t) ? values[t] : t))
}
