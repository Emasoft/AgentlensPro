---
trdd-id: N1ASCRM7
title: The cache-invalidation doctrine's never-invalidate list was FALSE for LSP until CC 2.1.235
column: backburner
created: 2026-08-22T19:25:55+0200
updated: 2026-08-22T19:25:55+0200
current-owner: main
task-type: docs
scope: project
relevant-rules: []
---

# The cache-invalidation doctrine's never-invalidate list was FALSE for LSP until CC 2.1.235

## The contradiction, both sides verified

`CLAUDE.md:308-309` asserts, quoting the Anthropic docs verbatim:

> "Skills, commands, agents, hooks, LSP servers, monitors, and themes **never** invalidate the cache."

The Claude Code changelog for **2.1.235** says:

> Fixed whole-prompt-cache invalidation when a language server disconnected or reconnected
> mid-session

Both read first-hand. So for some window ending at 2.1.235, an LSP connect/disconnect blew the
**whole prompt cache** — the most expensive event in the cost model — while our doctrine, sourced
from the docs, said it could not happen. The doc sentence describes the intended design; the
changelog records that the implementation did not match it.

## Why this matters beyond one row in a list

1. **Burn attribution over that window may be wrong.** A full-prefix cold write costs the write
   rate on the entire transcript (2× at the 1h tier on opus-5). An unexplained spike in a session
   with an LSP attached had a cause our own tooling could not name — `agentlenspro` ships no
   `LSP_RECONNECT` cause, because the doctrine said there was nothing to ship.
2. **It is evidence about the SOURCE, not just this row.** The never-invalidate list is quoted
   from documentation, and one of its seven members was measurably false. The other six
   (skills, commands, agents, hooks, monitors, themes) are asserted on exactly the same
   authority and have not been independently measured here. The doctrine block is careful to
   mark `SKILLS_RELOADED` / `ACCOUNT_SWITCHED` as INFERRED — this is the same class, and it is
   currently unmarked.
3. **It repeats the session's dominant failure shape** at the level of a project document: a
   documented generality standing in for a measurement. See the same lesson recorded in
   `[[hook-registration-live-reload-2-1-240]]`, where a global rule about hook restarts was
   preferred over a same-day first-hand measurement of the same system.

## Scope of the change

- Amend the `CLAUDE.md` cache-invalidation section so the never-invalidate list carries its
  provenance and its known exception: doc-sourced, one member measurably false before 2.1.235,
  the rest unmeasured here.
- Decide whether `agentlenspro`'s cause enumeration needs an `LSP_RECONNECT` cause for
  historical sessions (pre-2.1.235 data still on disk), or whether naming it in doctrine is
  enough. **The bar the codebase already sets** (TRDD-B9ERTBZ9) is that a cause is only named
  when it can be distinguished from the alternatives — do not add one that cannot be.
- Do NOT silently "fix" the sentence to say LSP is safe now. It IS safe as of 2.1.235, but the
  useful content is that the list was trusted and wrong, which is what stops the next reader
  trusting the remaining six unconditionally.

## Acceptance

- [ ] `CLAUDE.md`'s never-invalidate list states its provenance and the LSP exception with the
      version it was fixed in.
- [ ] The remaining six members are either measured, or explicitly marked as doc-sourced and
      unmeasured — no unmarked generality.
- [ ] A decision recorded (either way, with the reason) on whether an `LSP_RECONNECT` cause is
      warranted, held to the TRDD-B9ERTBZ9 distinguishability bar.

## Provenance

Surfaced 2026-08-22 while the USER was reading the CC changelog to check an unrelated claim
(whether hook registration reloads live). Found by scanning 2.1.232–240 for anything touching
settings or hooks; the LSP line was incidental to that search and is the more consequential
finding. Filed immediately under the standing USER order that every change-shaped remark gets a
card before it is forgotten.
