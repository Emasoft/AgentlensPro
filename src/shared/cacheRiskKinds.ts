// The cache-risk command VOCABULARY — runtime-neutral (no Node imports, no DOM), so the host
// scanner (src/cacheRiskCommands.ts) and the dashboard both import the SAME definitions
// (TRDD-EYA3X5MQ). It lives in src/shared/ specifically so `pnpm run check-mirrors` fails the build
// if media/src/ ever re-declares one of these symbols: the first version of the Lifecycle tab did
// exactly that, and adding EFFORT_CHANGED to the host union left the webview's private copy silently
// stale — the same drift that had already diverged pricing.ts and cacheBreak.ts before them.

/** What a command does to the cached prefix. Mirrors the CacheBreakCause vocabulary. */
export type CacheRiskKind =
  | 'PLUGINS_RELOADED'   // /reload-plugins — re-registers tool + skill + agent catalogs
  | 'SKILLS_RELOADED'    // /reload-skills — re-registers the skill catalog
  | 'PLUGIN_CHANGED'     // /plugin install|uninstall|enable|disable|update|marketplace …
  | 'MCP_SERVER_TOGGLE'  // /mcp — connecting/disconnecting a server rewrites the tool block
  | 'MODEL_SWITCHED'     // /model — caches are per-model, so a switch cannot hit the old entry
  | 'EFFORT_CHANGED'     // /effort — the reasoning-effort level is part of the cached prefix
  | 'ACCOUNT_SWITCHED'   // /login, /logout — a different credential cannot read the old cache
  | 'COMPACTION'         // /compact — rebuilds the message layer
  | 'CLEAR'              // /clear — resets the transcript floor (the REMEDY, tracked for contrast)

/** Whether the command necessarily changed the prefix, or only *might* have. */
export type MutationCertainty = 'certain' | 'ambiguous'

/** Display label + colour per kind. Exhaustive by Record, so a new kind cannot ship unrendered. */
export const CACHE_RISK_STYLE: Record<CacheRiskKind, { color: string; label: string }> = {
  PLUGINS_RELOADED:  { color: '#ef5350', label: 'plugins reloaded' },
  SKILLS_RELOADED:   { color: '#ff8a65', label: 'skills reloaded' },
  PLUGIN_CHANGED:    { color: '#ffa726', label: 'plugin changed' },
  MCP_SERVER_TOGGLE: { color: '#ffca28', label: 'MCP toggled' },
  MODEL_SWITCHED:    { color: '#ba68c8', label: 'model switched' },
  EFFORT_CHANGED:    { color: '#9575cd', label: 'effort changed' },
  ACCOUNT_SWITCHED:  { color: '#7986cb', label: 'account switched' },
  COMPACTION:        { color: '#4dd0e1', label: '/compact' },
  CLEAR:             { color: '#66bb6a', label: '/clear' },
}

/** `/plugin` sub-commands that actually mutate the installed set (bare `/plugin` opens a menu). */
const PLUGIN_MUTATING = /^(install|uninstall|remove|enable|disable|update|marketplace)\b/i

/**
 * Map a slash command to its cache effect. Returns undefined for commands that do not touch the
 * cached prefix of the session they were typed in. Pure and table-driven so the vocabulary lives in
 * exactly one place.
 */
export function classifySlashCommand(
  name: string,
  args?: string,
): { kind: CacheRiskKind; mutation: MutationCertainty } | undefined {
  const cmd = name.trim().toLowerCase()
  const a = (args ?? '').trim()
  switch (cmd) {
    case '/reload-plugins': return { kind: 'PLUGINS_RELOADED', mutation: 'certain' }
    case '/reload-skills': return { kind: 'SKILLS_RELOADED', mutation: 'certain' }
    case '/login':
    case '/logout': return { kind: 'ACCOUNT_SWITCHED', mutation: 'certain' }
    case '/compact': return { kind: 'COMPACTION', mutation: 'certain' }
    case '/clear': return { kind: 'CLEAR', mutation: 'certain' }
    // Menu-driven commands: an argument means the user named the mutation outright, so it is
    // certain; bare invocation only OPENS the picker and may change nothing at all.
    case '/plugin':
    case '/plugins':
      if (!a) return { kind: 'PLUGIN_CHANGED', mutation: 'ambiguous' }
      // `/plugin plugin update x` and `/plugin marketplace add y` both appear in real transcripts —
      // strip one redundant leading `plugin` before testing the verb.
      return PLUGIN_MUTATING.test(a.replace(/^plugins?\s+/i, ''))
        ? { kind: 'PLUGIN_CHANGED', mutation: 'certain' }
        : undefined
    case '/mcp': return { kind: 'MCP_SERVER_TOGGLE', mutation: 'ambiguous' }
    case '/model': return { kind: 'MODEL_SWITCHED', mutation: a ? 'certain' : 'ambiguous' }
    case '/effort': return { kind: 'EFFORT_CHANGED', mutation: a ? 'certain' : 'ambiguous' }
    // DELIBERATELY ABSENT: /fork, /subtask, /branch, /resume. Each one's cost is real but lands in
    // a DIFFERENT context than the session the command was typed in — /fork (CC 2.1.212) copies the
    // conversation into a new background session, /subtask runs in a subagent, /resume warms a new
    // session from an old transcript. This module's contract is "the command broke THIS session's
    // prefix, so bill its next turn"; classifying them here would attribute a child context's cold
    // start to the parent's next turn, which is simply a wrong number. Model them as session-spawn
    // events if they are ever wanted — not as cache-risk commands. (Measured 2026-07-21: zero
    // occurrences in any local transcript, so this costs nothing today either.)
    default: return undefined
  }
}
