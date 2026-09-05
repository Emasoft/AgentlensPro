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

**The producer works. The consumer does not exist.**

| link in the chain | state | evidence |
|---|---|---|
| statusline POST bumps the clock | **works** | `ui.rs:1218` sets `st.last_ingest_activity_ms = now` (TRDD-8ADTIGKT) |
| the value is exposed | **works** | `/api/debug/capture-activity` → `{"lastIngestActivityAt": …}` (`ui.rs:1451-1464`) |
| something compares it to a window | **MISSING** | `CAPTURE_ACTIVITY_WINDOW_MS` appears NOWHERE in the tree |
| something renders CAPTURE DOWN | **MISSING** | zero hits for `CAPTURE DOWN` / `capture_down` in `rust-core/crates/*/src/` |
| the TS row's supplier | **MISSING** | `getCaptureDownSince` is DECLARED (`mcpServer.ts:3451`) and CALLED (`:3845`) but supplied by nothing, so it is always `undefined` — which its own comment defines as "no row" |

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
- [ ] `grep -rn 'CAPTURE_ACTIVITY_WINDOW_MS\|CAPTURE DOWN' <live backend src>` is non-empty, and
      the window's value is justified in a comment against the git-history original.
- [ ] TRDD-8ADTIGKT's statusline bump is the input: a statusline-only machine with a stale clock
      trips the row.

## Notes and lessons learned
