// The per-session pending demand store for agentlenspro-review-mod.
// `claude plugin validate` refuses an import of this type from logic code,
// so it is declared here as a module augmentation of claude-code and read
// via the atom/read/update primitives (see hooks/register.js).

export type PendingDemand = {
  turnId: string | number | null
  reasons: string[]
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    "agentlenspro-review-mod": {
      // pendingDemand: the unreviewed-turn demand queued by turn.complete
      // and consumed by prompt.submit. null when no demand is pending.
      // Per-session (lives in $.state, never $.store): resets on /clear,
      // /resume, /branch — the classic.SessionStart hook is the reload point.
      pendingDemand: PendingDemand | null
    }
  }
}
