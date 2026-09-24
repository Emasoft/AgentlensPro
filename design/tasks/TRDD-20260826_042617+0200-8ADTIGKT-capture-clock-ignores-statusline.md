---
trdd-id: 8ADTIGKT
title: The capture-liveness clock ignores statusline samples so a statusline-only machine never raises CAPTURE DOWN
column: human_review
created: 2026-08-26T04:26:17+0200
updated: 2026-09-24T08:57:51+0200
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

## ⏵ AI-REVIEW VERDICT 2026-09-05 — APPROVE. Ready for `human_review`; the USER makes that move.

Both ticked boxes verified — the reviewing agent's, then re-checked by the orchestrator reading
producer AND consumer: `ui.rs:1218` bumps `last_ingest_activity_ms` inside the statusline POST
handler, and `/api/debug/capture-activity` (`ui.rs:1451-1464`) exposes it; the pinning test passes
1/1 against the current binary. Report: `reports/ai-review/20260905_071607+0200-8ADTIGKT.md`.

**But the PURPOSE this card names is not reachable, and that is a separate defect —
TRDD-U0L78B3Z.** The title says a statusline-only machine "never raises CAPTURE DOWN"; nothing
raises CAPTURE DOWN on ANY machine now. `ui.rs:1460` delegates the window comparison to "the
caller (server.ts kept `CAPTURE_ACTIVITY_WINDOW_MS` on its side)", and `567fc5c2` retired
`standalone/server.ts` entirely. `CAPTURE_ACTIVITY_WINDOW_MS` is absent from the whole tree, alcore
computes no CAPTURE DOWN, and `getCaptureDownSince` is declared and called but supplied by nothing.
The clock this card fixed now ticks correctly and unread.

The APPROVE stands: these two boxes are about the bump and the bump works. The gap is one the
criteria could not see, because they stop at the value and the purpose needs the consumer.

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

## Approval log

- 2026-09-24T08:57:34+0200 — column → human_review by main-session. AI review verified, evidence in reports/board-triage ai_review-A/B/C triage
- 2026-09-24T08:57:49+0200 — main-session (board update A): moved ai_review -> human_review; AI review verified per reports/board-triage ai_review-A/B/C triage rows. In this project's mono-agent rule the session moves ai_review->human_review; the owner moves human_review->complete.
