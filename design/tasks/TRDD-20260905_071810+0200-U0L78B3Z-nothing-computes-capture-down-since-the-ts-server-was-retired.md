---
trdd-id: U0L78B3Z
title: Nothing computes CAPTURE DOWN since the TS server was retired so the liveness clock ticks unread
column: todo
created: 2026-09-05T07:18:10+0200
updated: 2026-09-05T07:18:10+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: 8ADTIGKT
related: [8ADTIGKT, 4FMHW124, 1B98LCVR, 5PUD8RKE]
---

# Nothing computes CAPTURE DOWN since the TS server was retired so the liveness clock ticks unread

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T07:18:10+0200

Found while AI-reviewing TRDD-8ADTIGKT, whose boxes are satisfied and whose PURPOSE is not
reachable. Nothing here is fixed yet; this card is the finding.

**The producer works and a live consumer is waiting. The SUPPLIER in the middle is missing.**

> **This card's first version claimed "nothing computes CAPTURE DOWN anywhere". That was FALSE**,
> and the way it went wrong is the point: the grep meant to establish that universal negative was
> piped through `| head -12`, and the disproof (`src/cli/serverControl.ts`) was on line 23. A
> truncated search cannot establish an absence — it can only ever show what it did not cut off.
> The corrected finding below is narrower AND more actionable.

| link in the chain | state | evidence |
|---|---|---|
| statusline POST bumps the clock | **works** | `ui.rs:1218` sets `st.last_ingest_activity_ms = now` (TRDD-8ADTIGKT) |
| the value is exposed on a debug route | **works** | `/api/debug/capture-activity` → `{"lastIngestActivityAt": …}` (`ui.rs:1451-1464`) |
| something compares it to a window | **MISSING** | `CAPTURE_ACTIVITY_WINDOW_MS` appears nowhere in the tree; `ui.rs:1460` says the comparison "belongs to the caller (server.ts kept it on its side)" and `567fc5c2` retired `standalone/server.ts` |
| alcore emits `bodies.captureDownSince` in `/api/server-stats` | **MISSING** | zero hits for `captureDown` / `capture_down` in `server_stats.rs`, and none anywhere under `rust-core/crates/*/src/` |
| **the CLI renders the row** | **WORKS, AND IS WAITING** | `src/cli/serverControl.ts:513` declares `captureDownSince?: number \| null` on the server-stats shape and `:521` renders `` `\| CAPTURE DOWN <N>m — sessions active, no bodies arriving` `` on EVERY branch |
| the TS burn-guard row | **unsupplied** | `getCaptureDownSince` DECLARED (`mcpServer.ts:3451`) and CALLED (`:3845`) but supplied by nothing ⇒ always `undefined` ⇒ its own comment: "no row" |

**So `agentlenspro server status` has rendered CAPTURE DOWN correctly this whole time and will
never print it**, because alcore — the only backend — does not send the field. `serverControl.ts`
names this exact trap in its own comment: *"absent on an older server — absent is not 'healthy',
it is 'not reported'."* The CLI is honest about the distinction; there is simply no server left
that reports it.

`ui.rs:1460` states the design explicitly: *"the window comparison belongs to the caller (server.ts
kept `CAPTURE_ACTIVITY_WINDOW_MS` on its side)"*. That caller was deleted — `567fc5c2` retired
`standalone/server.ts` entirely ("alcore is the only backend"). The comparison went with it and was
never ported. So the alarm this whole chain exists to raise cannot fire on any machine, statusline-
only or not.

**Do NOT read this as "8ADTIGKT was wrong".** Its two boxes are about the bump, both are satisfied,
and its APPROVE stands. This is a gap the card's own acceptance criteria could not see, because the
criteria stop at the value and the purpose needs the consumer — the same shape recorded in USER
memory as `ATOM-H5NC-JGM6`, here in its most consequential form: an alarm whose producer is
carefully maintained and whose consumer was deleted a commit at a time.

**UNVERIFIED, and it decides the fix's shape**: whether `mcpServer.ts` is live at all. `CLAUDE.md`
says alcore is the only backend and the MCP server is deliberately not registered, which suggests
the TS burn-guard row is itself legacy. If so the port target is alcore's own burn guard, not the
TS one. Settle this before writing code.

## Why this matters

Capture going down is silent by construction — the feed looks connected and produces nothing. That
is why the alarm exists, and why its absence is worse than a broken alarm: a broken one eventually
misfires and gets noticed. TRDD-ZW4APOPI measured the cost of exactly this class of silence: a 2 GB
spool sat 100% full for ~18h and 117 request bodies were written as ZERO BYTES.

## Fix shape (not yet decided)

1. Establish whether the CAPTURE DOWN row's home is alcore's burn guard or the TS one (above).
2. Port the window comparison to whichever it is: `now - lastIngestActivityAt > WINDOW` ⇒ down,
   with `downSince` tracked so the row can render its age as the TS one did
   (`burnGuard.ts:143-150` is the existing shape and renders `CAPTURE DOWN 15m`).
3. Pick the window deliberately rather than inheriting a number nobody can now point to — the TS
   constant is gone, so its value must be recovered from git history, not guessed.

## Acceptance

- [ ] A named constant and a comparison exist in the LIVE backend, reachable from a request path
      that a test drives — not merely defined.
- [ ] With the clock stale past the window, the guard emits a CAPTURE DOWN row; within the window
      it emits none. Both asserted by a test that fails if the comparison is removed
      (mutation-verified, not merely present).
- [ ] `/api/server-stats` emits `bodies.captureDownSince` — asserted by a test that reads the
      ACTUAL response body, so `serverControl.ts:521`'s row can render. (An earlier draft of this
      box asked only that a grep be non-empty; a comment satisfies that. The failure this card
      documents is a field nobody sends, which a grep for a name cannot detect.)
- [ ] The window's value is justified in a comment against the git-history original
      (`CAPTURE_ACTIVITY_WINDOW_MS` in `standalone/server.ts` before `567fc5c2`), not guessed.
- [ ] TRDD-8ADTIGKT's statusline bump is the input: a statusline-only machine with a stale clock
      trips the row.

## Notes and lessons learned

- **The negative IS established now, by one unscoped search.** `grep -rna
  "last_ingest_activity_ms\|lastIngestActivityAt" .` over the whole repo (no `--include`, no
  directory list, `-a` because `grep` is a shell function here that hides binary matches) returns
  only writes, the definition, the debug-route exposure, and tests — no comparison anywhere. That
  search is complete BY CONSTRUCTION: any consumer must name the field. A scoped grep for a
  constant NAME could never have settled it, because a threshold can be an env var, a
  `resolve_knob` call, or an inline literal.
- **TRDD-8ADTIGKT's acceptance criteria were under-specified, and the next card in this family
  will be tempted to repeat the shape.** Its title promises an alarm; its two boxes test only that
  a field gets bumped. Both boxes passed honestly and the alarm still cannot fire. When a card's
  title names an OUTCOME, at least one box must assert that outcome — not the input that feeds it.
