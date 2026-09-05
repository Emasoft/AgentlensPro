---
trdd-id: U0L78B3Z
title: Nothing computes CAPTURE DOWN since the TS server was retired so the liveness clock ticks unread
column: todo
created: 2026-09-05T07:18:10+0200
updated: 2026-09-05T08:25:46+0200
current-owner: main-session
task-type: bugfix
priority: high
min-approval-requirement: none
created-by: 8ADTIGKT
related: [8ADTIGKT, 4FMHW124, 1B98LCVR, 5PUD8RKE, FGN5TY7E]
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

## ⏵ 2026-09-05 — THIS IS NOT ONE FIELD. The CLI reads THREE that alcore never emits.

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
shape is invisible to both. Proof, found minutes later: **there is a THIRD declaration, in a second
file** — `burnGuard.ts:110` — so the count went 2 → 3 the moment the search widened. What was
actually earned: *the same four from two instruments with different blind spots, both scoped to one
file*, which is a real strengthening (the grep cannot see `:521`'s parameter read; the type route
can) but still a LOWER BOUND. The asymmetry protects the finding — every miss adds an unsent
field, never removes one.

That duplication is now its own card, **TRDD-FGN5TY7E** (`related:`, not `eht:` — the port does not
depend on the dedup and must not be blocked by it). It is plausibly the root cause of this whole
class: each declaration looks locally complete, so nobody notices. **Cite the bounded block plus this union for all four**; the per-key `grep -c`
that first found two of them is the scoped-search evidence this card spent four commits demoting.

**TWO silent alarms, not one.** `sinkProblem` renders `| SINK: …` on every status branch and, like
CAPTURE DOWN, has never been able to appear. A sink problem is exactly the condition a human needs
told.

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
