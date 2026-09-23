---
trdd-id: C19SUVPH
title: The ingest flood bench cannot send statusline POSTs so a load arm cannot vary statusline alone
column: ai_review
created: 2026-09-23T19:14:50+0200
updated: 2026-09-23T21:23:25+0200
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
implementation-commits: [bbf40fdf, ea835fdf, d18dc9a1, fb61c4f4, 9b599f21]
---

# The ingest flood bench cannot send statusline POSTs so a load arm cannot vary statusline alone

scripts/bench/alcore-ingest-flood.mjs drives OTLP only. TRDD-EQCGAVGV's isolated run needs arms that vary statusline and OTLP independently, so the tool must: send POST /api/statusline-samples with a realistic payload at a configurable rate (including low rates, e.g. 1 per 10 s); pace OTLP independently; target a given port set (UI/API and OTLP) so it never touches the live collector's canonical ports by default.

## Acceptance

- [x] statusline-only and OTLP-only modes (the zero-load baseline is simply not running the tool).
- [x] rate flags verified by the target's own counters (statusline receivedSinceBoot, spans.store.totalSpans; admitted_total counts UI-port POSTs) over 5 min.
- [x] refuses to run against the canonical ports unless an explicit flag says so.

related: [EQCGAVGV].

## Approval log

- 2026-09-23T19:14:50+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Evidence

The statusline POST handler is agentlens-core/src/ui.rs:1426-1444 (POST /api/statusline-samples); payload shape is any JSON object with an optional statusline_stream:"subagent" field (ui.rs:1439), not a fixed schema struct on this path. No per-route auth/header check on this handler; it relies on the global CSRF Origin gate (ui.rs:6-14,548-569) applied to every non-GET/HEAD request.

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

Isolated alcore (own HOME/DATA_DIR, ports 4901/3901/4916): (i) statusline --rate 2 --concurrency 4 x 60 s -> ok2xx 120, statuslineReceivedDelta 120, underRate false; (ii) statusline --rate 1 --concurrency 32 x 60 s -> ok2xx 60, underRate false; (iii) killing the target at ~60 s during a --rate 2 --concurrency 1 x 300 s run -> exit 3, targetDownAtSec 60.002, deltaBasis tick. fb61c4f4 checks ran on fb61c4f4 but were not re-run after the first-fire change (expected to hold, with request counts now 2 and 1 instead of 0 and ~0): a 640 s-pace OTLP --seconds 30 run ends in 30 s with 0 late requests; --rate 0.00001 --concurrency 32 x 10 s ends in 10 s with no TimeoutOverflowWarning; --sessions 0 exits 2.
Known limit: when --rate and --sessions are both given, --rate wins and --sessions is ignored without a warning.

## Behaviour change for older recipes (9b599f21)

The first-fire change also affects the --sessions lane: each worker now fires at its stagger instead of one pace later, so a run delivers up to one more request per worker than HFV4AIT7-era numbers; underRate does not report this lane (targetReqPerSec is 0).
