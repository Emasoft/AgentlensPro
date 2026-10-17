---
trdd-id: C19SUVPH
title: The ingest flood bench cannot send statusline POSTs so a load arm cannot vary statusline alone
column: human_review
created: 2026-09-23T19:14:50+0200
updated: 2026-10-17T20:18:32+0200
current-owner: main-session
created-by: main-session
task-type: infra
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T19:14:50+0200
implementation-commits: [bbf40fdf, ea835fdf, d18dc9a1, fb61c4f4, 9b599f21, 79dd2828, d35de9f2, 782cab31, 17ed1ce4, 3f698179]
status: tasked
---

# The ingest flood bench cannot send statusline POSTs so a load arm cannot vary statusline alone

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-17

- CURRENT HEAD (2026-10-17, written at the Part 2 close; the bullets after this head are older and lose where they disagree): Parts 1 and 2 are done. Part 1 = scripts/test-flood-bench-args.js (d35de9f2, P2 precondition 782cab31). Part 2 = src/test/floodBenchRate.test.ts against a real isolated alcore (17ed1ce4, extended in 3f698179).
- Box 1 ticked: statusline-only and OTLP-only measured against a real alcore, mutation-proven (see ## Evidence, 2026-10-17 Box 1).
- Box 2 ticked: the 5-minute agreement was observed once locally on the pre-fix bench (17ed1ce4) with disclosures (see ## Evidence, 2026-10-17 Box 2); the committed test runs 10 s per case. admitted_total also counts the bench snapshot reads (correction in ## Evidence).
- Box 3 ticked earlier (d35de9f2), with its stated qualifications (P2/P3 first observed on CI).
- CI has not observed the three new test steps or the rate test yet (no push).
- F2 (the root afterAll hook in src/test/setup.js times out on long runs) is filed as TRDD-PLK9JWTF.
- NEXT ACTION: the owner pushes so CI observes the three new test steps and the rate test.
- Part 1 committed in d35de9f2: scripts/test-flood-bench-args.js, wired into check-guards and ci.yml. Local run 16 passed, 1 skipped, 0 failed. Not yet observed on CI (no push).
- Cases D1-D4 (dataDir refusal), P1-P3 (port guard), B1-B10 (bad arguments); full list in ## Part 1 test (2026-10-17).
- Mutations M1-M5 each turned their target case red (the worker's run); the orchestrator re-ran only the green suite.
- The stats endpoints come from a stand-in HTTP server inside the test: a real alcore cannot report the live ~/.agentlens as its data dir (one owner per data dir), so nothing else could reach that refusal.
- D1 on CI (~/.agentlens absent) is first observed on CI; until then it rests on reading the code. P2 and P3 are likewise first observed on CI.
- Statusline received and persisted are one counter (p.statusline_samples), so the 2026-09-23 result 600 received = 600 persisted was never a two-sided check.
- SUPERSEDED 2026-10-17 (see the current head) — Still unverified: the target-down exit 3; the hooks mix and the both mix; admitted_total; the 5-minute agreement between the rate flags and the target counters (box 2).
- Known and unfixed: --rate together with --sessions silently ignores --sessions.
- SUPERSEDED 2026-10-17 (see the current head) — Part 2 (deferred): a real-alcore rate test. In CI it goes after ci.yml:119, where AGENTLENS_ALCORE is downloaded. alcore takes flags, not env vars (--media-dir is required). It waits for the 1-minute load to drop under 20 (it was 54.6).
- SUPERSEDED 2026-10-17 (see the current head) — No acceptance box was ticked by this update.
- P2 precondition landed in 782cab31: P2 runs only when nothing listens on 3000 or the server there reports ~/.agentlens (same resolver as the bench); otherwise a visible skip. Accepted residual: a server change between that check and the P2 spawn (P2 never passes --allow-live). The skip branch is untested.
- SUPERSEDED 2026-10-17 (see the current head) — Part 2 recipe: runs after ci.yml:119 with AGENTLENS_ALCORE; alcore takes CLI flags, and --media-dir is required; poll the counters until two reads agree; assert floors, not only equality.
- SUPERSEDED 2026-10-17 (Part 2 is done; see the current head above) — former next action: Part 2 (real-alcore rate test plus the 5-minute box-2 run) when the 1-minute load is under 20

scripts/bench/alcore-ingest-flood.mjs drives OTLP only. TRDD-EQCGAVGV's isolated run needs arms that vary statusline and OTLP independently, so the tool must: send POST /api/statusline-samples with a realistic payload at a configurable rate (including low rates, e.g. 1 per 10 s); pace OTLP independently; target a given port set (UI/API and OTLP) so it never touches the live collector's canonical ports by default.
Known gap, not fixed: the bench's live-port refusal is keyed on the literal UI port 3000 (OTLP 4318 never moves) and does not read <dataDir>/ports.json, so a live collector whose UI port moved off 3000 is protected only by the dataDir refusal. On 2026-10-17 nothing listened on 3000 at the probe; the cause is unexplained (a moved port, or no collector running).

## Acceptance

- [x] statusline-only and OTLP-only modes (the zero-load baseline is simply not running the tool).
- [x] rate flags verified by the target's own counters (statusline receivedSinceBoot, spans.store.totalSpans; admitted_total counts UI-port POSTs) over 5 min. (see the 2026-10-17 correction in ## Evidence: admitted_total also counts the bench's snapshot reads)
- [x] refuses to run against the canonical ports unless an explicit flag says so. (test-committed d35de9f2; P2/P3 first observed on CI; P1 mutation-proven; the P2 mutation was not run; the --allow-live bypass (P3) is CI-only and not yet observed)

related: [EQCGAVGV, PLK9JWTF].

## Approval log

- 2026-09-23T19:14:50+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-24T08:57:34+0200 — column → human_review by main-session. AI review verified, evidence in reports/board-triage ai_review-A/B/C triage
- 2026-09-24T08:57:49+0200 — main-session (board update A): moved ai_review -> human_review; AI review verified per reports/board-triage ai_review-A/B/C triage rows. In this project's mono-agent rule the session moves ai_review->human_review; the owner moves human_review->complete.
- 2026-09-24T08:58:02+0200 — main-session note: this card carries the open owner question on the human_review policy for AI-approved mandate cards (shared with 9SOYXKNE) — moved to human_review per this batch's instruction; the policy question itself remains for the owner.
- 2026-10-05T01:52:23+0200 — column → todo by main-agent@agentlenspro. review in the owner's stead 2026-10-05: no committed test; not dev, because nobody is working on it
- 2026-10-17T15:03:04+0200 — column → dev by main-agent@agentlenspro. Part 1 test (refusals, args) in progress per round-2-reviewed spec docs_dev/20261017-c19-args-test-spec.md; Part 2 real-alcore rate test deferred until load < 20
- 2026-10-17T15:25:20+0200 — column → todo by main-agent@agentlenspro. Part 1 committed (d35de9f2); Part 2 waits for load < 20, nobody is working the card now
- 2026-10-17 — box 2 unticked by main-agent@agentlenspro: its tick rested on one gitignored isolated run of 2026-09-23 on older code; it is re-ticked by the Part 2 five-minute run (load < 20).
- 2026-10-17 — box 1 unticked by main-agent@agentlenspro: OTLP-only rests on the 2026-09-23 run only; statusline-only reaches the endpoint in d35de9f2 case D3 against a stand-in server, not alcore. Both are re-proven by Part 2.
- 2026-10-17T17:26:08+0200 — column → dev by main-agent@agentlenspro. Part 2 implementation started
- 2026-10-17T20:12:05+0200 — column → testing by main-agent@agentlenspro. Part 2 committed (17ed1ce4, 3f698179): real-alcore rate test green locally, mutations MB1-MB4 as expected; boxes 1-2 ticked
- 2026-10-17T20:12:06+0200 — column → human_review by main-agent@agentlenspro. all three boxes ticked with disclosures in ## Evidence; owner to push so CI observes the new test steps and the rate test

## Evidence

The statusline POST handler is agentlens-core/src/ui.rs:1426-1444 (POST /api/statusline-samples); payload shape is any JSON object with an optional statusline_stream:"subagent" field (ui.rs:1439), not a fixed schema struct on this path. No per-route auth/header check on this handler; it relies on the global CSRF Origin gate (ui.rs:6-14,548-569) applied to every non-GET/HEAD request.
- 2026-10-17 Box 1 (statusline-only and OTLP-only modes): src/test/floodBenchRate.test.ts (17ed1ce4, extended in 3f698179) boots a real isolated alcore (free ports, temp HOME and data dir, --no-log-scan, scrubbed env). Case S (statusline) measured ok2xx 20, statusline 20, admitted 22, spans 0. Case O (otlp, 20 spans per request) measured ok2xx 20, spans 400, statusline 0, admitted 2. Mutations on 17ed1ce4: M1-M5 red on their targets; M6 red, but on the ceiling, its intended spans-zero target proven later by MB3; on 3f698179, MB1 (no budget, no break) red at 17 of 14, MB2 (no budget) red at 15 of 14, MB3 (M6) red on spans-zero, MB4 (no break) green as expected. CI has not observed it yet (no push).
- 2026-10-17 Box 2 (rate flags verified by the target's own counters over 5 min): the 5-minute agreement was observed once locally on 17ed1ce4's bench, BEFORE the deadline fix, using rust-core/target/release/alcore built from dbbadf86 (sha256 3e9aecfa2e519606f728bfcd6ad8b16821f64c5abab203909bbe4d3be043af14, built 2026-10-17 17:29). Results: S 600/600, admitted 602, spans 0; O 600 requests, 12000 spans, statusline 0. The fix only removes deadline-edge sends, and 600 = 2N. Disclosures: (a) a leftover duplicate PQ40PZ9D agent wrote the bench at 18:29 during that run (Case S spawned on a cmp-verified bench at about 18:19; Case O's bench at about 18:24 on unverified content, though by the leftover agent's own account (INFERRED, not checked) its edits could not touch the otlp path); (b) the load spiked to about 76-127 during the run and the floor still held; (c) mocha exited 1 only because of the root afterAll hook (TRDD-PLK9JWTF). To get exit 0 on a 5-minute run, pass a larger global --timeout (e.g. 120000).
- 2026-10-17 The committed test runs 10 s per case. The rate ceiling is 2N, held by the bench's shared send budget (mutation-proven by MB2) plus the deadline break (defence in depth, MB4). The 2N figure is code-read (measure r2 section 3) and recorded in the bench worker-loop comments (3f698179) and confirmed by MB2. The total never exceeds the ideal schedule's count; which worker sends the last unit may change.
- 2026-10-17 Correction (appended, box 2 text unchanged): admitted_total counts EVERY non-exempt UI-port request, including the bench's own snapshot reads (+2 per run with --progress-sec 100000), not only the statusline POSTs.
- 2026-10-17 Known and not fixed: the bench's own spansAppendedDelta can undercount by about 5 s of spans, because totalSpans counts flushed segments only and the flush runs every 5 s; TRDD-EQCGAVGV's arms must not use that field without a settle. Statusline persistence is unproven (received and persisted are one counter). The deadline fix's F1 mechanism is INFERRED by code reading, with early timer wakes measured at 11 of 4000.
- 2026-10-17 Process note: a leftover duplicate agent from an earlier session wrote this card's bench file for hours alongside this session's worker, breaking one writer per file. It removed its own edits; the committed fix 3f583f6d stands.

## Implementation spec (2026-09-23, after two review rounds)

1. --mix statusline: POST /api/statusline-samples on --ui-port. Body = synthetic statusline JSON: session_id; transcript_path and cwd under /tmp/al-bench-data (no reader opens them - src/statuslineUsage.ts reads only the fields below); model{id,display_name}; workspace{current_dir,project_dir}; cost{total_cost_usd rising per session over the run, total_duration_ms, total_api_duration_ms, total_lines_added, total_lines_removed}; context_window{total_input_tokens,total_output_tokens,context_window_size,used_percentage,current_usage{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}}; rate_limits{five_hour{used_percentage,resets_at},seven_day{used_percentage,resets_at}}; plus hook_event_name ('StatusLineSample' or 'SubagentStatusLineSample') and statusline_stream ('subagent' with probability --subagent-share, default 0.31, else 'main'). Take any further top-level/nested KEY NAMES (names only, never values) from one line of the newest live WAL (~/.agentlens/statusline/main/<today>/wal-*.ndjson, e.g. head -1 | jq) and add them with synthetic values so a body is ~1.9-2.0 KB (live mean 1,960 B/row).
2. --rate R = total requests/s: paceMsPerReq = 1000*concurrency/R; overrides --sessions; worker i starts after i*pace/concurrency ms (no synchronized bursts). Result echoes paceMsPerReq, targetReqPerSec, achievedReqPerSec, and underRate:true if achieved < 95% of target.
3. --spans-per-request K (default 20) sets makeOtlpBody's span count.
4. --new-session-every S (default 0 = off): every S s a new monotonic id bench-session-<n> joins a sliding window of the 16 newest; all mixes pick from the window.
5. Stats: read /api/server-stats and /api/debug/log-scan-stats (derivedCaches.summary.misses) before, at every progress tick (--progress-sec, default 300; one stderr line per tick), and after. Keep the last good snapshot. Result adds statuslineReceivedDelta, statuslinePersistedDelta (persistence.statuslineSamples), summaryMissesDelta, spansAppendedDelta, hookEventsReceivedDelta, deltasAsOfSec. If the after-read fails, deltas are computed against the last good snapshot. Record target pid at each read; a pid change sets revived:true and nulls every delta spanning it.
6. Target-down: a run of consecutive status-0 responses lasting >= 20 requests AND >= 30 s ends the arm; targetDownAtSec = time of the FIRST failure of that run. Always print the result JSON; exit 3 when the arm ended early on target-down, 0 on full duration, 2 on refusal, 1 on tool error.
7. Live refusal: BEFORE any http call, exit 2 if --ui-port == 3000 or --otlp-port == 4318 (each alone) unless --allow-live. Then, on the first /api/server-stats read, exit 2 (no POST sent) if realpath($.dataDir) == realpath(os.userInfo().homedir + '/.agentlens') unless --allow-live; if $.dataDir is absent, warn on stderr and continue.
8. Unchanged: OTLP/hook body shapes (except span count), defaults, the unbounded latency arrays (keep the existing ponytail comment). Add a code comment with the WHY for 5-7.

## Verification (2026-09-23)

Implemented in bbf40fdf. Isolated alcore (own HOME/DATA_DIR, ports 3901/4901/4916): statusline --rate 2 x 300 s -> 600 requests, 600 received = 600 persisted, 0 spans; OTLP --rate 1 --spans-per-request 20 x 300 s -> 5,900 spans at the tool's after-read, 6,000 on a re-read 2 s later; ports 3000 and 4318 each refused with exit 2 and zero HTTP requests; target killed at 60 s -> exit 3, targetDownAtSec 60. summaryMissesDelta: statusline 0, OTLP 300. The dataDir refusal was not exercised. Report: reports/flood-bench/20260923_201445+0200-c19suvph-impl.md (gitignored).

## Amendments after review of bbf40fdf (2026-09-23)

Item 1: no ts is sent - the server stamps its own ts on every row (statusline_store.rs append, ~289-304), overwriting any client value. resets_at is fixed per run, used_percentage is account-wide and rises 0.001/sample, prompt_id is stable for 20 samples per session; statuslineBodyBytesMean is reported (1,919 B measured).
Item 5 as implemented: the revive check compares the pid of the first read with the pid of the final read (or last good tick), not every tick; a pid change nulls every delta. deltaBasis (final|tick|before) names the read the deltas rest on; with basis before, every delta is null.
Item 6 as implemented: only status 0 (no response, socket error, timeout) counts toward target-down; 4xx/5xx are the server answering. getJson now has the same REQUEST_TIMEOUT_MS as post.
Added: every flag is validated before any http call (unknown flag, missing/non-finite/negative number, --mix outside otlp|hooks|both|statusline, out-of-range ports/share/concurrency) -> exit 2; underRate is judged on achievedOkPerSec (2xx only).

## Re-verification on d18dc9a1 (2026-09-23)

The ticked acceptance first rested on the bbf40fdf verification; after the ea835fdf and d18dc9a1 fixes (status-0-only target-down, flag validation incl. empty/zero values) all checks were re-run on the fixed code against an isolated alcore: statusline --rate 2 x 300 s and OTLP --rate 1 --spans-per-request 20 x 300 s passed their count checks; ten bad-flag cases (incl. --rate '', --rate 0, --spans-per-request 0, --concurrency 2.5, constructor 1) and both live-port cases exit 2 with no HTTP request; killing the target at 60 s exits 3 with targetDownAtSec 60.003 and stale=true on the fallback progress lines. Report: reports/flood-bench/20260923_205703+0200-ea835fdf-followup.md (gitignored).

## Verification on fb61c4f4 and the first-fire follow-up (2026-09-23)

Isolated alcore (own HOME/DATA_DIR, ports 4901/3901/4916): (i) statusline --rate 2 --concurrency 4 x 60 s -> ok2xx 120, statuslineReceivedDelta 120, underRate false; (ii) statusline --rate 1 --concurrency 32 x 60 s -> ok2xx 60, underRate false; (iii) killing the target at ~60 s during a --rate 2 --concurrency 1 x 300 s run -> exit 3, targetDownAtSec 60.002, deltaBasis tick. fb61c4f4 checks ran on fb61c4f4 but were not re-run after the first-fire change (expected to hold, with request counts now 2 and 1 instead of 0 and ~0): a 640 s-pace OTLP --seconds 30 run ends in 30 s with 0 late requests; --rate 0.00001 --concurrency 32 x 10 s ends in 10 s with no TimeoutOverflowWarning. (--sessions 0 exiting 2 is argument validation, which runs before any worker and is unaffected by the first-fire change.)
Known limit: when --rate and --sessions are both given, --rate wins and --sessions is ignored without a warning.

## Behaviour change for older recipes (9b599f21)

Against fb61c4f4, each worker now fires at its stagger instead of one pace later, so a run delivers up to one more request per worker. Against HFV4AIT7-era runs (no stagger, no deadline cap) the count is the same or up to one fewer per worker, none land after the deadline, and elapsed equals --seconds instead of overrunning by up to one pace. underRate does not report the --sessions lane (targetReqPerSec is 0).

## Notes

2026-10-04: code and tests verified at HEAD 7dab99a0 (report 20261004_123622+0200-close-verify-cv4.md); stays in human_review because box 2 (rate flags agree with target counters over 5 min) was only ever true on an isolated collector run of 2026-09-23, and the dataDir refusal was never exercised; the owner confirms after the next deploy / push.

## Review 2026-10-05 (in the owner's stead)

- Verdict: returned to todo. No committed test of any kind covers scripts/bench/alcore-ingest-flood.mjs; every acceptance claim rests on gitignored reports of one run on 2026-09-23. Not deploy, because nothing here waits on a deploy. Reviewer report: docs_dev/20261005_014637+0200-review-C19SUVPH.md (gitignored).
- Verified: the refusal to target --ui-port 3000 or --otlp-port 4318 exits 2 before any http call (run by the reviewer; the guard and its position before the first http.request read by the main agent); bad flag values exit 2 with "bad arguments".
- Owed: a committed test for the port refusal, the argument validation and the statusline-only mix; the data-directory half of the refusal has never been exercised; the 5-minute agreement between the rate flags and the target counters re-run on an isolated collector at low load. Known and unfixed: --rate together with --sessions silently ignores --sessions.

## Part 1 test (2026-10-17)

Test file scripts/test-flood-bench-args.js, commit d35de9f2, wired into check-guards and ci.yml. Local run: 16 passed, 1 skipped, 0 failed; not yet observed on CI.
- D1: the server-reported dataDir is ~/.agentlens, so the bench refuses with 0 POST.
- D2: a symlink spelling of D1 also refuses. Local only; skipped when ~/.agentlens is absent.
- D3: a scratch dataDir is accepted and posts.
- D4: an absent dataDir warns and continues.
- P1: --otlp-port 4318 is refused with 0 requests.
- P2: --ui-port 3000 is refused with 0 requests. It runs only after D1 passes.
- P3: --allow-live gets past the port guard. CI only, because --allow-live lifts both gates.
- B1 to B10: bad arguments, each matched by its own error line, with 0 requests.
The stats endpoints are served by a stand-in HTTP server inside the test, because a real alcore cannot report the live ~/.agentlens as its data dir (one owner per data dir).
Mutations: M1 to M5 each turned their target case red. That is the worker's run; the orchestrator re-ran only the green suite.
