---
trdd-id: 8ADTIGKT
title: The capture-liveness clock ignores statusline samples so a statusline-only machine never raises CAPTURE DOWN
column: todo
created: 2026-08-26T04:26:17+0200
updated: 2026-08-26T05:19:33+0200
current-owner: AgentlensPro session
task-type: bugfix
severity: LOW
scope: project
project-id: agentlenspro
min-approval-requirement: none
relevant-files: [standalone/server.ts, src/cli/serverControl.ts]
npt: []
eht: []
---

# The capture-liveness clock counts two of three feeds

TRDD-4FMHW124 shipped capture-liveness detection for `server status`. Its
description (line 44-45) lists three things that count as capture: OTEL spans,
POSTed hook events, and statusline samples. The implementation bumps the
activity clock on the first two only.

The drift is smaller than that framing suggests: line 170-171 of the same card
already discloses the two feeds that actually shipped. So the card contradicts
itself rather than misrepresenting the code — which is still worth fixing,
because a reader who stops at line 45 is misinformed.

## Direction of the error

UNDER-DETECTION only. `standalone/server.ts:786` fires the warning on
`CAPTURE_ON && active && !captured`, where `active` derives from
`lastIngestActivityAt` — which is bumped at exactly two sites, `:2118` (spans)
and `:3526` (POST /api/hook-events). The statusline endpoint at `:3481` does not
bump it. So on a statusline-only machine the clock stays stale, `active` is
false, and CAPTURE DOWN **never fires at all**: a genuine outage would go
unreported. It cannot raise a false alarm.

(The first version of this card asserted the opposite — "could eventually say
CAPTURE DOWN while capture is working" — one line before asserting the correct
direction. Corrected against the code by a second review fork; the originating
fork's NOTE 2 had it right and the transcription garbled it.)

Found by an adversarial review fork over 5dfac15, checking the card's claims
against the diff rather than against the card's prose.

## Acceptance

- [x] Either the statusline sample path bumps the same activity clock, or the
      card's own list of what counts as capture is corrected to the two feeds
      that actually do — one source of truth, not two descriptions.
      Evidence: `standalone/server.ts` POST `/api/statusline-samples` handler
      now sets `lastIngestActivityAt = Date.now()` after a successful
      `ingestStatuslineSample` call (same variable, same post-success placement
      as the `/api/hook-events` handler at :3529, now :3532 after the insert).
- [x] Whichever way it goes, a test pins it, so the list and the code cannot
      drift apart again silently.
      Evidence: `src/test/serverEndpoints.test.ts` — new test
      `POST /api/statusline-samples bumps the capture-liveness clock same as
      hook-events (TRDD-8ADTIGKT)`, reading the clock via a new debug endpoint
      `GET /api/debug/capture-activity`; `npx mocha
      out/test/test/serverEndpoints.test.js --grep TRDD-8ADTIGKT` → 1 passing.
