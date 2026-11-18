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
  // True when a stop ended WITHOUT a harness review (failure past the retries, or the round cap): the next stop
  // must review that work, even when its own turn changed nothing. debtWhy says why.
  debt?: boolean
  debtWhy?: string
}

export type LastSession = {
  transcriptPath: string
  cwd: string | null
}

// One held box: the rows the Stop display prints for one reviewed interrupted turn.
export type HeldBox = {
  // Local time the review ended, "HH:MM": the heading of the box is "interrupted turn HH:MM".
  at: string
  // The display rows, ready to print: that heading, the plain-text report when the review produced one, and the coloured
  // usage box when the usage could be computed. Rendered text, not the usage table, so the value stays plain JSON.
  lines: string[]
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
      // heldInterrupted: the user-only boxes of the reviewed INTERRUPTED turns that no main-thread Stop has shown yet, oldest
      // first. Appended when such a review ends (turn.complete → timer), taken whole by the next main-thread classic.Stop.
      // In session state since 0.7.12 (TRDD-ISEF8YO7). By the mods documentation it outlasts a compaction and a reload of the
      // module and resets on /clear, /resume and /branch, like pendingReview (not observed in a live session);
      // classic.SessionStart then prints one row that says how many went.
      heldInterrupted: HeldBox[]
    }
  }
}
