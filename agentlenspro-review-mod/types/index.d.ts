// Session state of agentlenspro-review-mod. `claude plugin validate` refuses an import of this type from
// logic code, so it is declared here as a module augmentation of claude-code and read via the
// atom/read/update primitives (see hooks/register.js).

export type PendingReview = {
  // The harness review of an INTERRUPTED turn (measure report included when the turn had a proposal).
  text: string
  // True when that review's verdict was BLOCK: the next Stop blocks if the next turn did not address it.
  block: boolean
  // True once the text was injected into the next prompt's context.
  injected: boolean
  at: number
}

export type LastSession = {
  transcriptPath: string
  cwd: string | null
}

declare module 'claude-code' {
  interface PluginState {
    "agentlenspro-review-mod": {
      // pendingReview: set by the interrupted-turn review (turn.complete → timer), injected by prompt.submit,
      // consumed by the next classic.Stop. Per-session ($.state): resets on /clear, /resume, /branch.
      pendingReview: PendingReview | null
      // lastSession: the main conversation transcript path and cwd, remembered from classic.SessionStart /
      // classic.UserPromptSubmit / classic.Stop payloads (turn.complete carries no transcript path).
      lastSession: LastSession | null
    }
  }
}
