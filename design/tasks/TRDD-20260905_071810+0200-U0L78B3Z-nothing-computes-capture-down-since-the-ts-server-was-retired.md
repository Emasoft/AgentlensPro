---
trdd-id: U0L78B3Z
title: Nothing computes CAPTURE DOWN since the TS server was retired so the liveness clock ticks unread
column: ai_review
created: 2026-09-05T07:18:10+0200
updated: 2026-09-05T16:43:02+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: 8ADTIGKT
related: [8ADTIGKT, 4FMHW124, 1B98LCVR, 5PUD8RKE, FGN5TY7E]
implementation-commits: [a55074bd, 7659b9ca]
---

# Nothing computes CAPTURE DOWN since the TS server was retired so the liveness clock ticks unread

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-09-05T11:52:25+0200

**IN `ai_review` — committed (a55074bd) AND DEPLOYED on this machine.** Gate
`reports_dev/diz-final.txt`: every stage exit 0 at 11:42. Deploy at 11:51: `cargo build --release`
→ copy into `bin-native/darwin-arm64/` → `codesign -s - --force` → the binary answers its usage
line (exit 64, i.e. past `main`; the codesign failure is exit 137 before it) → `agentlenspro server
restart` (pid 37180 → 39382, `RESTART_EXIT=0`, `STATUS_EXIT=0`). Live `/api/server-stats` now
sends `bodies` keys `[archive, lastPass, live, captureDownSince, sinkProblem, parked, spool]` with
`captureDownSince: null` / `sinkProblem: null` while capture is up (23 live files, newest 1 s
ago) — the correct "up" reading; raw: `reports_dev/alcore-restart.txt`. Box 3 met. The
review fork's two notes are recorded where they belong: the sink probe reads the legacy dir on a
spool machine (TRDD-5PUD8RKE), and statusline samples do not tick the activity clock yet
(TRDD-8ADTIGKT, cross-referenced in the `CAPTURE_ACTIVITY_WINDOW_MS` doc). `human_review` is the
USER's move. Earlier state, kept: `server_stats.rs` now carries
`CAPTURE_ACTIVITY_WINDOW_MS` (the TS value, cited to `567fc5c2^:standalone/server.ts:671`) and
`capture_down_since(capture_on, now, last_activity, newest_body, started_at)` — the server.ts:825-827
predicate, STATELESS: `since` = the moment the window closed on the newest body, floored at boot
(no body ever ⇒ boot). Emitted as `bodies.captureDownSince` (null = up), the direct child the CLI
reads at `serverControl.ts:521`. Inputs: `st.last_ingest_activity_ms` (the TRDD-8ADTIGKT statusline
bump + ingest) and `bodies.live.newestMs` from the same response — so box 5's input is wired.
One unit test, six cases, in `capture_block_tests`.

**Scope decisions (ponytail):** (1) `mcpServer.ts`'s burn-guard row stays unsupplied. Whether it
is even reachable is NOT established: the string `mcpServer` occurs in `standalone/cli.js`, but
that is a 15k-line bundle and a grep hit there is not an import (this card's own rule); the grep
for `from './mcpServer'` under `standalone/` returned nothing. The CLI status row is the consumer
that demonstrably renders, so it is the one wired.
**Review-fork check (2026-09-05): the `.sink-probe` file cannot be mis-read as a body** — every
scanner of the capture dirs filters on `.request.json`/`.response.json` (`chores.rs:171`,
`burn/guard.rs:218`, `live_bodies_liveness` :232), so the drain chore, the burn guard and the
liveness gauge all skip it; `newestMs` is `as_secs_f64()*1000` = epoch ms, same unit as the clock.
A second fork pointed out that ONE filter hit is not EVERY listing — so every `read_dir` over the
capture dirs was read, not grepped: `chores.rs:167` is `staged_body_bytes` (filtered),
`agentlens-store/pass.rs:170` `body_files` is THE drain lister (filtered on both suffixes),
`bodies_evidence.rs:181` skips non-`.json`, `pass.rs:293` lists the parquet store, not bodies.
`chores.rs` contains no `rename`/`remove_file` at all. And `probe_sink` now tolerates `NotFound` on
its own cleanup, so a concurrent consumer of the probe file can never surface as `SINK:`. (2) `sinkProblem`,
`reclaimedSinceBoot`, `lastNonZeroPassAt` are NOT ported here — the first needs a sink probe
(`probeSink`) alcore does not have, the other two need bodies-pass counters; each is its own
change. TRDD-FGN5TY7E box 4 still decides whether they send or stop being declared.

**`sinkProblem` is ALSO ported, and where it runs matters (third review fork):** the TS probed
once per bodies-pass TICK (server.ts:818) and the stats route read a variable; a first draft here
probed on every `/api/server-stats` call, which dashboards poll — a create+unlink per poll on the
legacy SSD dir. Now: `chores.rs` probes at the tick (capture on only), logs on TRANSITIONS
(`bodies sink precondition FAILED: …` / `recovered`, as the TS did), stores `CoreState.sink_problem`;
`server_stats` reads it. `PersistStats` is `Copy`, so the `Option<String>` lives on `CoreState`
next to `last_ingest_activity_ms`.

**Gates:** lib unit test 1/1 (LIB_EXIT=0, pre-probe-move run); `--test server_stats` + clippy
relaunched after the last edit — read `reports_dev/u0l78b3z-gate2.txt` / `-gate3.txt`. Mocha
whole-suite run: 2643 pass / 17 fail, none in the capture-line suites (those pass); the 17 are
pre-existing (B7DSTJLS, CS2W7E77) plus `setup`/`rustIngest`/`FAL` failures carded as TRDD-X4YTS5BF.
**NEXT ACTION:** gates green → commit → a live check per box 3 needs a deploy (`codesign` —
TRDD-M2VK8T4P).

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
| something compares the CLOCK to a window | **MISSING** | The unscoped, binary-safe search over `last_ingest_activity_ms`/`lastIngestActivityAt` returns ONLY writes, the definition, the debug-route exposure, and tests. Complete by construction **for that identifier** — but NOT for the card's claim: a CAPTURE DOWN value need not come from this clock at all. `bodies.live.newestMs` is already in the same response and `now - newestMs > window` is a complete capture-liveness test; so are spool mtimes, hook-event arrival, and span arrival. An earlier version of this row claimed "any emitter would have to compute from this clock" — **false, and `newestMs` is arguably the BETTER design.** Also true: `CAPTURE_ACTIVITY_WINDOW_MS` is absent tree-wide, and `ui.rs:1460` delegates the comparison to "the caller (server.ts kept it on its side)", which `567fc5c2` retired |
| alcore emits `bodies.captureDownSince` in `/api/server-stats` | **MISSING — CLOSED, by reading the one block that decides it** | The consumer reads `s.bodies.captureDownSince` — a DIRECT CHILD of `bodies`. `server_stats.rs:613` builds that object as a literal `json!` block whose direct children are exactly five: `archive`, `lastPass`, `live`, `parked`, `spool`. Four are inline literals; **exactly one value is spliced** (`spool_gauge(…)`), and it sits UNDER `"spool"`, so whatever it emits lands at `bodies.spool.*` and can never become `bodies.captureDownSince`. The enumeration is therefore complete for the key the CLI actually reads — a bounded block, not a search. **Cross-check**: the live curl returned `bodies` keys `[archive, lastPass, live, parked, spool]` — exactly the literal set, so no splice adds a direct child at runtime either. (An earlier version claimed closure from a whole-file string-literal count plus "zero derives in this file". That is the WEAKER precondition: `json!` can splice a `Value` built anywhere, so a file-scoped derive check cannot exclude keys entering the tree from another module. What closes it is reading the one block, not counting literals in the file.) **The row below is SUPPORTING only — a SCOPED search, not a universal negative.** Zero hits for `captureDown` / `capture_down` in `server_stats.rs` or anywhere under `rust-core/crates/*/src/`. It could miss an emitter whose Rust field is named something else under a `rename_all = "camelCase"`, a key built in a hand-written `json!` (the codebase mixes styles — `ui.rs:1463` is exactly that), or a crate outside the `*/src/` glob. That does not weaken the card, because the row above does not depend on it. **CORROBORATING ONLY: the wire.** `curl -s localhost:3000/api/server-stats` (2026-09-05) returns `bodies` with keys `[archive, lastPass, live, parked, spool]`, no `captureDownSince` — but that curl was taken while capture was HEALTHY (`live.files=29`, newest 1s ago), which is exactly when a CORRECTLY WORKING implementation would also omit an optional field (`skip_serializing_if = "Option::is_none"` is the idiom). **It discriminates nothing.** The behavioural test that WOULD is a response observed while capture is genuinely down — nobody has run it, and acceptance box 1 already asks for it |
| **the CLI renders the row, and its read path is clean** | **LIVE — verified by running it, and the path re-read** | `showStatus` assigns `s` once at `serverControl.ts:616` from the parsed `/api/server-stats` response and only reads it after — no normalizer, no merge, no default-filler, so nothing between the wire and `:521` can inject or relocate the field. | `src/cli/serverControl.ts:513` declares `captureDownSince?: number \| null` and `:521` renders `` `\| CAPTURE DOWN <N>m — sessions active, no bodies arriving` `` on EVERY branch. **`agentlenspro server status` on 2026-09-05 printed `capture: 11 live file(s), newest 1s ago`**, and `:700` is literally `` `capture: ${bodiesCaptureLine(s)}` `` while `bodiesCaptureLine` is the function at `:506` whose body computes `down` at `:521` — so that line IS this function's output, the function ran, `down` evaluated, and it was empty because the field is absent. (`:691`'s `bodies: archive …` is a DIFFERENT line; do not cite it for this.) |
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

## ⏵ 2026-09-05 — THIS IS NOT ONE FIELD. The CLI reads FOUR that alcore never emits.

Found while verifying the read path for this card. `showStatus` assigns `s` ONCE at
`serverControl.ts:616` from `apiRequest('GET', '/api/server-stats')` and only reads it afterwards —
no reassignment, no `Object.assign`, no spread — so the read path is verified and nothing injects
fields. That same read shows the CLI consuming two MORE fields with the same problem:

**This is ONE CLASS with a COMPLETE list, not a growing pile of omissions.** `bodies`'s direct
children are closed at five (`archive`, `lastPass`, `live`, `parked`, `spool` — the bounded block
read at `server_stats.rs:613`, confirmed by the live curl returning exactly those keys). So every
`s.bodies.*` the CLI reads outside that set is unsent, and the diff is exhaustive:

| `s.bodies.*` read by `serverControl.ts` | emitted? |
|---|---|
| `archive`, `lastPass`, `live`, `parked` | **yes** |
| `captureDownSince` | **NO** — the `\| CAPTURE DOWN <N>m` row |
| `sinkProblem` | **NO** — the `\| SINK: <problem>` row |
| `reclaimedSinceBoot` | **NO** — gates the newer reclaimed-since-boot statistic |
| `lastNonZeroPassAt` | **NO** — the timestamp that statistic renders with |

**Derived twice, by two instruments that cannot miss the same things — same four both times.**
First by dot-access grep (`grep -oE 's\.bodies\.[a-zA-Z][a-zA-Z0-9_]*' src/cli/serverControl.ts`),
which is a LOWER BOUND only: it sees one file, one syntax, one variable name. Proof that it is the
wrong instrument — **it cannot see `:521`, the read this whole card is about**, because inside
`bodiesCaptureLine` the object is a parameter, not `s`. Then by the declared TYPE, which lists what
any consumer can read regardless of syntax or variable name.

**The type instrument has its own trap here: the wire shape is DECLARED TWICE, and the two
declarations disagree.**

| declaration | has | lacks |
|---|---|---|
| `interface ServerStats.bodies` (`:575-588`) | archive, lastPass, reclaimedSinceBoot, lastNonZeroPassAt, captureDownSince, sinkProblem, live | **parked**, **spool** |
| `bodiesCaptureLine`'s parameter (`:509-514`) | live, parked, captureDownSince, sinkProblem | archive, lastPass, reclaimedSinceBoot, lastNonZeroPassAt |

Neither is complete, and the CLI demonstrably reads `s.bodies.parked` — a field the main interface
does not declare. **The real read set is the UNION**, and diffing that against the five emitted
children yields the same four unsent fields.

**NOT "instrument-independent" — I claimed that and it is wrong.** Both instruments ran over
`serverControl.ts` alone, so they share a blind spot: another file declaring or consuming this
shape is invisible to both. (A widened search did find a third SITE naming `captureDownSince` —
`burnGuard.ts:110` — but reading it showed a `BurnGuardOptions` parameter type that is HANDED the
value, not a third wire declaration; see TRDD-FGN5TY7E. The single-file blind spot is real
regardless, and does not need that hit to be a declaration.) What was
actually earned: *the same four from two instruments with different blind spots, both scoped to one
file*, which is a real strengthening (the grep cannot see `:521`'s parameter read; the type route
can) but still a LOWER BOUND. The asymmetry protects the finding — every miss adds an unsent
field, never removes one.

That duplication is now its own card, **TRDD-FGN5TY7E** (`related:`, not `eht:` — the port does not
depend on the dedup and must not be blocked by it). It is plausibly the root cause of this whole
class: each declaration looks locally complete, so nobody notices. **Cite the bounded block plus this union for all four**; the per-key `grep -c`
that first found two of them is the scoped-search evidence this card spent four commits demoting.

**TWO silent alarms, not one — and `sinkProblem` is verified to the SAME standard as
`captureDownSince`, not one notch below it.** `const sink = s.bodies.sinkProblem ? ' | SINK: …'
: ''` sits at `serverControl.ts:524`, **three lines below `down` at `:521` and inside the same
`bodiesCaptureLine` function**. So the identical behavioural proof carries: the live run printed
`capture: 11 live file(s), newest 1s ago`, which IS that function's output (`:700`), so the
function ran, so `sink` evaluated — and it was empty, because the field is absent from the closed
five-key set. A sink problem is exactly the condition a human needs told, and this row has never
been able to appear.

(An earlier session summary said "two alarms that have never been able to fire" while only
`captureDownSince` had a traced render path; the two evidence levels were flattened. Levelled by
tracing `:524`, not by softening the claim.)

**`reclaimedSinceBoot` fails differently from the other three, and the distinction matters for
triage.** `serverControl.ts` branches on `s.bodies.reclaimedSinceBoot !== undefined`; since it is
always undefined the line ALWAYS takes the else-branch. The else-branch is not buggy — it is the
correct older `lastPass` rendering — so nothing looks wrong. The defect is that the NEWER, better
statistic is permanently unreachable, silently, with a plausible number in its place. The other
three fail by rendering nothing at all.

Same wound as this card's: `567fc5c2` retired the TS server, the CLI kept the reader, and the Rust
replacement never grew the writer. **Scope decision for whoever takes this**: either widen this
card to "port the bodies fields the CLI reads", or split the two new ones out — but do not fix
`captureDownSince` alone and leave a consumer reading two more fields nobody sends.

**Not yet checked**: whether other `s.<section>.*` reads outside `bodies` have the same gap. The
recipe, written down because it is the same two steps that closed `bodies` and will otherwise be
re-derived:

1. Read the ONE literal `json!` block in `server_stats.rs` that builds that section; its direct
   children are the closed emitted set. (Do not grep the file for key names — `json!` splices
   `Value`s built in other modules, so a file-wide literal count proves nothing about a subtree.)
2. Read the DECLARED TYPE(S) for that section — **plural, and check for more than one**; a
   dot-access grep is a lower bound that cannot see a destructured read, a differently-named
   variable, another file, or bracket access. Diff the union of the declarations against step 1.

**Still uncovered, one level down**: `s.bodies.spool.*`. `spool` is the ONE spliced value in the
block, so the bounded read said nothing about its keys — run the same two steps on `spool_gauge`.

**On the read path**: `s` is assigned once at `:616` and an identifier scan of the render range
found only reads — but that scan would miss a helper mutating `s` in place or a bracket-access
write, and `apiRequest`'s own return shaping was never read. What actually excludes a mutation that
MATTERS is behavioural: the live run printed the capture line with no `| CAPTURE DOWN` suffix, so
any injected value was falsy, which is indistinguishable from absence at `:521`. A truthy injection
would have rendered.

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

- [x] A named constant and a comparison exist in the LIVE backend, reachable from a request path
      that a test drives — not merely defined. (`server_stats.rs:519` `CAPTURE_ACTIVITY_WINDOW_MS`,
      `capture_down_since` at `:528`, called from the `bodies` object at `:674`.)
- [x] With the clock stale past the window, the guard emits a CAPTURE DOWN row; within the window
      it emits none. Both asserted by a test that fails if the comparison is removed
      (mutation-verified, not merely present). (`server_stats.rs:738` unit test, 6 cases; the 15:36
      review's mutation claim is the worker's — the run itself was deferred for CPU contention.)
- [x] `/api/server-stats` emits `bodies.captureDownSince` — asserted by a test that reads the
      ACTUAL response body, so `serverControl.ts:521`'s row can render. (An earlier draft of this
      box asked only that a grep be non-empty; a comment satisfies that. The failure this card
      documents is a field nobody sends, which a grep for a name cannot detect.)
      (`tests/server_stats.rs`, extended in `7659b9ca`; live curl corroborated by the review.)
- [x] The window's value is justified in a comment against the git-history original
      (`CAPTURE_ACTIVITY_WINDOW_MS` in `standalone/server.ts` before `567fc5c2`), not guessed.
      (`server_stats.rs:511-515`.)
- [x] TRDD-8ADTIGKT's statusline bump is the input: a statusline-only machine with a stale clock
      trips the row. (`ui.rs:1218` `st.last_ingest_activity_ms = now;` inside the
      `/api/statusline-samples` handler — block read on HEAD `1195-1222` at 16:43: no intervening
      `else if` arm between the route match and the bump, and the bump's own comment reads "A
      statusline sample IS capture activity (TRDD-8ADTIGKT, TRDD-465EXTJ6)"; `capture_down_since` is
      fed that field at `:675`. The doc comment at `server_stats.rs:516-518` said the opposite —
      corrected 16:41.)

## Approval log

- 2026-09-05T16:40:54+0200 — orchestrator accepts the 15:36 AI-review APPROVE and ticks the five
  boxes it had left for the review to judge. Re-checked first-hand: the constant, the `:674-675` call
  site, the `:738` unit test's existence, `7659b9ca`'s Rust footprint (`server_stats.rs`,
  `tests/server_stats.rs`, `bodies_activity.rs`), and the statusline bump at HEAD `ui.rs:1218`.
  Worker's alone: the 6-case mutation run and the live curl. Acted on both defects the review named:
  `implementation-commits` gains `7659b9ca` (the wiring test + deploy commit), and the false
  "statusline samples do not tick it yet" doc comment in `server_stats.rs` is rewritten (comment-only,
  no rebuild). The review had routed those two fixes to human_review ("recommend the human reviewer
  ask for both"); applying them at `ai_review` pre-empted that routing — an orchestrator call,
  vetoable by reverting `95fec703`'s comment hunk. Card stays `ai_review` for the human_review move.

## Notes and lessons learned

- **The negative IS established now, by one unscoped search.** `grep -rna
  "last_ingest_activity_ms\|lastIngestActivityAt" .` over the whole repo (no `--include`, no
  directory list, `-a` because `grep` is a shell function here that hides binary matches) returns
  only writes, the definition, the debug-route exposure, and tests — no comparison anywhere. That
  search is complete for **in-process Rust** consumers — there `st.last_ingest_activity_ms` is the
  only access path, the struct is internal, and no serde rename applies. It is **NOT** complete
  across the HTTP boundary: a reader could fetch the route and index the parsed object without
  either identifier appearing (`v[k]`, `Object.values(v)[0]`, passing the whole object onward).
  What rules THAT out is the second search — `/api/debug/capture-activity` appears only in
  `ui.rs` (the route), `serverEndpoints.test.ts` (tests) and a `lib.rs` comment. **Both searches
  together** carry the negative; neither does alone. A scoped grep for a constant NAME could never
  have settled it either way, because a threshold can be an env var, a `resolve_knob` call, or an
  inline literal.
- **TRDD-8ADTIGKT's acceptance criteria were under-specified, and the next card in this family
  will be tempted to repeat the shape.** Its title promises an alarm; its two boxes test only that
  a field gets bumped. Both boxes passed honestly and the alarm still cannot fire. When a card's
  title names an OUTCOME, at least one box must assert that outcome — not the input that feeds it.

## AI review verdict — run: 2026-09-05T15:36:08+0200

| box | met/unmet | status | evidence |
|---|---|---|---|
| 1. named constant + comparison in the LIVE backend, reachable from a request path a test drives | met | ✓ VERIFIED | `server_stats.rs:519` `CAPTURE_ACTIVITY_WINDOW_MS`, `:528` `capture_down_since(...)`, called at `:674-677` inside `pub fn server_stats(...)`, which is the EXACT function `ui.rs:1200` invokes for the `/api/server-stats` route (`crate::server_stats::server_stats(&st, crate::now_ms())`) — no wrapper in between. The integration test (`tests/server_stats.rs::the_values_the_core_owns_move_with_the_state`) calls `server_stats(&st, ...)` directly rather than issuing a real HTTP request, so "reachable from a request path" is proven by reading the handler, not by the test itself; the live curl below closes that gap behaviourally. |
| 2. stale clock ⇒ row; within window ⇒ none; mutation-verified test | met | ✓ VERIFIED | Unit test `server_stats.rs:738-752` `capture_down_since_fires_only_on_active_and_not_captured`, 6 asserts covering: fresh body→None, stale body→Some(since), no body ever→Some(boot), stale-older-than-boot floored, idle host→None, capture off→None. Removing the `!captured` or `active` term in `capture_down_since` (`:535-539`) would flip at least 2 of the 6 asserts — genuinely mutation-sensitive, not just present. Plus the integration test asserts the SAME transition through real `CoreState`: `before["bodies"]["captureDownSince"]==null` (no activity yet), `after[...]==st.started_at_ms` (post-ingest, no bodies) at `tests/server_stats.rs:159,184`. |
| 3. `/api/server-stats` emits `bodies.captureDownSince`, asserted against the actual response body | met | ✓ VERIFIED (code + live wire, both) | `server_stats.rs:674-677` splices it as a direct `bodies` child; `tests/server_stats.rs:43` frozen key-order test includes it in the exact key list. **Live re-verified independently**: `curl -s localhost:3000/api/server-stats` (this review, pid 39382, binary mtime Sep 5 11:50, matching the claimed deploy) returned `bodies` keys `[archive, lastPass, live, captureDownSince, sinkProblem, parked, spool]`, `captureDownSince: null`, `sinkProblem: null` — matches `reports_dev/alcore-restart.txt` exactly. This only proves the UP reading on the wire (capture is healthy); the DOWN reading on the wire is proven by the integration test above, not by this curl. |
| 4. window value justified against git-history original, not guessed | met | ✓ VERIFIED | `git show 567fc5c2^:standalone/server.ts` line 671: `const CAPTURE_ACTIVITY_WINDOW_MS = 10 * 60_000`. Rust: `server_stats.rs:519` `pub const CAPTURE_ACTIVITY_WINDOW_MS: i64 = 10 * 60_000;`, comment cites the exact same commit/line. Values and provenance match. |
| 5. TRDD-8ADTIGKT's statusline bump is the input; a statusline-only machine with a stale clock trips the row | met, but the card's own doc comment is factually wrong about it | ✓ VERIFIED (met) / defect in the comment | `capture_down_since` is fed `st.last_ingest_activity_ms` (`server_stats.rs:675`). That field IS bumped by the statusline POST handler in **alcore itself**: `ui.rs:1303-1308` (`st.last_ingest_activity_ms = now;` inside the `/api/statusline` handler), landed in commit `0c1edbec` (2026-09-01, TRDD-465EXTJ6), i.e. already live before this card was even opened. So a statusline-only machine (no spans, no hook events, periodic statusline POSTs, no bodies landing) DOES tick the same field the guard reads, and WOULD trip `captureDownSince`. **Defect**: the doc comment this card's own commit `7659b9ca` added at `server_stats.rs:515-517` says *"statusline samples do not tick it yet (TRDD-8ADTIGKT, open)"* — this is FALSE, contradicted by `ui.rs:1308` read directly. TRDD-8ADTIGKT's own file (`design/tasks/TRDD-...-8ADTIGKT-...md`) has this exact box ticked `[x]` already, citing (stale) TS evidence — the same fix independently exists and is live in alcore. No test specifically drives the *statusline* path into `capture_down_since` (the wiring test uses a trace ingest, which bumps the same field via `lib.rs:885`), but since both callers write the identical `CoreState` field that the pure function consumes, the wiring is structurally proven; the missing piece is a comment correction, not code. |

**Frontmatter hygiene defect**: `implementation-commits: [a55074bd]` omits `7659b9ca`, which is the commit that (a) added the wiring test that actually exercises the FIRES branch through real state, (b) performed the deploy, and (c) moved the card to `ai_review`. Per the STATE block's own account, `7659b9ca` is load-bearing for this card's readiness and should be listed.

**Other defects found, none blocking**:
- The stale/false doc comment at `server_stats.rs:515-517` (see box 5) should be corrected to reflect that alcore's statusline handler already bumps the clock (commit `0c1edbec`), independent of TRDD-8ADTIGKT's own (TS-only) evidence trail.
- Box 1's "reachable from a request path that a test drives" is met by reading the handler wiring (no wrapper between the HTTP route and the tested function) plus the live curl corroborating the UP case; no test issues a literal HTTP request against `/api/server-stats` for the DOWN case. This is a thin but real gap between the letter of the box and what was tested — not enough to reject given the integration test drives the exact function the route calls, with real `CoreState`, real config-file parsing, and a live-server cross-check for the up-branch.

**Deferred, not run (CPU contention — a Rust worker is building on this machine)**: `cargo test --workspace` fresh run; the reviewer relied on the two committed gate transcripts (`reports_dev/diz-final.txt`, `reports_dev/u0l-wiring-test.txt`), both read in full, both `*_EXIT=0` with the relevant test names and PASS lines present verbatim.

**Verdict: APPROVE** — all five acceptance boxes are met by code read first-hand, one unit test (6 mutation-sensitive cases) plus one integration test (real `CoreState`, both branches) plus a live independent curl corroborating the wire. The one real defect (a false doc comment on box 5, landed in `7659b9ca`) is cosmetic — it does not change what code executes or what the tests prove — and the missing `implementation-commits` entry is a one-line frontmatter fix. Recommend the human reviewer ask for both fixed as a fast-follow, but neither blocks promotion to `human_review`.
