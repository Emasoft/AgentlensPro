---
trdd-id: WKLD508O
title: alcore exits with a culprit log rather than exceed a 2 GB memory cap
column: dev
created: 2026-09-07T19:36:46+0200
updated: 2026-09-07T21:30:33+0200
current-owner: main
task-type: feature
parent-trdd: 7YPQWKPG
min-approval-requirement: none
priority: high
severity: high
blocked-by: []
npt: []
eht: []
implementation-commits: [466775af, f9776548, c0537ef4]
project-id: agentlenspro
scope: project
labels: [rust, memory, alcore, guard]
---

# alcore exits with a culprit log rather than exceed a 2 GB memory cap

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-07 21:15

**CODE LANDED, NOT DEPLOYED.** `466775af` (worker's implementation) + `f9776548` (two defects I
found by reading the 244 lines I had committed after reading ~60). The worker has finished and
released the crate. 8/8 tests green. Deploy still needs `cargo build --release` → copy into
`bin-native/darwin-arm64/` → `codesign -s - --force` → `agentlenspro server restart`.

**THE FINDING THAT CHANGES THIS CARD'S PREMISE — measured on the live collector (pid 30984),
`vmmap -summary` + `footprint`, 2026-09-07 21:0x:**

`phys_footprint` **6265 MB**, peak **8375 MB**. Per-region `dirty + swapped` (footprint charges
compressed/swapped pages; DIRTY alone does not, which is why a dirty-only reading understates the
C++ side by ~2×):

| region | dirty + swapped |
|---|---|
| IOAccelerator = **the Rust heap** (mimalloc tags its mmaps VM tag 100; macOS names tag 100 `VM_MEMORY_IOACCELERATOR`) | **~0.96 G** |
| MALLOC_LARGE (93 M resident, **2.3 G swapped**) | ~2.39 G |
| MALLOC_SMALL | ~2.05 G |
| MALLOC (empty) + metadata | ~0.66 G |
| | Σ ≈ **6.05 G** vs footprint 6.265 G |

**So ~5.1 G of 6.3 G is the C/C++ (DuckDB) allocator and ~0.96 G is the Rust heap — about 5:1.**
The consequence for this card: **zeroing the entire Rust heap does not reach 2048 MB.** Deleting
`SpanWindow` (TRDD-KBM09XHB), shrinking the card store, or narrowing the window all operate on the
~0.96 G. Whether that 5.1 G is *reducible by Rust-side work* is a separate, open question — the
bytes live in the C++ allocator, but the Rust code decides how many queries, appends, and parquet
readers create them. Do not read "the bytes are in DuckDB" as "no Rust change can shrink them".

**Corollary: the guard fires on its first tick at the 2048 default**, and peak 8375 MB says it
would have fired at any point today.

**THE SOFT VALVE IS OSCILLATING OVER ITS WHOLE RANGE, AND ITS CONTROL INPUT IS INVERTED UNDER
SWAP.** Two wrong versions of this paragraph preceded this one: the first said "narrowed 750
times" (the log message prints on a boolean that is also `true` for a *widening*, so a recovery is
printed as `memory pressure` — a real logging defect, `lib.rs::prune_window` binds it as
`narrowed`); the second retracted the oscillation claim as unsupported. **The retraction was
wrong.** Classifying all 750 logged values settles it:

```
101 × 300000   93 × 600000   48 × 43200000   46 × 21600000   46 × 1200000
 44 × 5400000  44 × 2700000  44 × 1350000    44 × 10800000   43 × 675000   40 × 337500 …
```

**There are TWO disjoint ladders, and reading them as one produced three wrong counts in three
turns.** Descent halves from `configured_ms` and clamps: `43200000 21600000 10800000 5400000
2700000 1350000 675000 337500 300000`. Ascent doubles from the floor and clamps: `600000 1200000
2400000 4800000 9600000 19200000 38400000 76800000 86400000`. They share nothing, because
`300000 ≠ 86400000 / 2^k` (the ratio is 288, not a power of two).

**Widening is proven by VALUE MEMBERSHIP, which needs no assumption about consecutive lines.**
`600000, 1200000, 2400000, 4800000, 9600000, 19200000` are unreachable by halving from
`86400000` — a process that only ever starts fresh and narrows can never print them. They appear
254 times, `600000` alone 93 times. So the window departed the floor **~93 times**, and the ascent
counts decay 93 → 46 → 39 → 31 → 25 → 20: most recoveries survive one or two ticks.

**The log spans restarts — by arithmetic, from these same counts.** Logging `43200000` requires the
window to have been at `86400000`, which happens only at construction or when an ascent clamps
there. `#(43200000) = 48` but `#(86400000) = 15`, so there were **≥33 window constructions**. Any
sentence attributing this log to one uptime — including two earlier versions of this paragraph — is
wrong. Descent-rung counts are also direction-ambiguous (a mid-descent widen re-emits the same
value going up), so none of them is a descent tally.

**The control input can read 0, and 0 widens.** `server_stats::rss_bytes()` returns
`proc_pidinfo(PROC_PIDTASKINFO).pti_resident_size` — but on a short read it falls through to
`0`, and `0 <= budget` takes the widen branch. That is a complete inversion mechanism requiring
one transient syscall failure and nothing else. A swap-driven story is also available (RSS falls
when pages leave residency, and ~2.5 G is swapped here) but its magnitude is **unshown** — the
server reports `rssMb 7930`, *above* `ps`'s 6.6 GB, and nothing measured shows this input reaching
≤4096 MB. Prefer the mechanism that is visible in the source; do not assert either as established.

**Do NOT call the valve "saturated" — it is not, and the two claims are incompatible.** A saturated
valve is pinned at the floor and logs nothing (`max(150000, 300000)` is not `< effective_ms` ⇒
`return false`). This one departs the floor ~93 times. The supported statement is narrower and
still decides the cap question: **the window reaches its floor while the process sits at 6265 MB, so
a valve at full deflection does not bring it under 2048 MB — the hard cap is not redundant with it.**

**Interaction with this card's own deliverable.** `CulpritSnapshot` records `window_effective_ms` at
breach. If the valve widened on a spurious low reading in the tick before the cap fires, the culprit
log names a window that had just been *widened* — the diagnostic the owner asked for would
misdescribe the state that produced the breach. The guard should record whether the last valve
action was a widen, or sample the width before `apply_memory_pressure` runs.

Established facts behind the above: `SUMMARY_WINDOW_FLOOR_MS = 5 * 60_000` (read at
`span_window.rs:40`), narrowing is `(effective_ms / 2).max(FLOOR)`, widening is
`(effective_ms * 2).min(configured_ms)` and is **not** floor-clamped, and `configured_ms` is
`86400000` (24 h). So CLAUDE.md's "5-minute rolling span window" describes the *floor* — the
degraded state — not the configured design.

Consequence for this card, unchanged by any of the above: `spans.inMemory = 317` is the *valve's
output*, so it bounds what `SpanWindow` holds **now** and says nothing about its capacity or peak.
And the valve reaches its floor while the process sits at 6.3 GB, so the hard cap is not redundant
with it. (Not "no remaining authority" — see above: it departs the floor ~93 times.)

**DECIDED BY DEFAULT — the owner did not answer in two hours, and the choice is reversible without
a rebuild, so it is not worth blocking on.** Asked ~19:30, restated six times, no answer by 21:45.
The decision taken, and the owner can flip either half in one command:

- **The code ships `2048` as the default.** That is the directive, honoured literally, and it is
  what any other machine gets.
- **This machine runs 2048 as well — deploy and see whether it boots.** ~~`AGENTLENS_RSS_HARD_CAP_MB=7168`
  for one cycle~~ **SUPERSEDED within the hour, by the flaw recorded below.** The override was chosen
  to avoid a culprit log that describes a *booting* process, but installing the guard restarts the
  collector anyway, so the 6265 MB process the override was sized against does not survive the
  deploy. A fresh process crossing 2048 exits with a log describing a grown process — the same
  diagnostic, without pre-emptively widening the cap.

**FLAW THAT SUPERSEDED THE OVERRIDE, found before acting on it.** The argument for 7168 was "at 2048 the guard breaches on its first tick, so the culprit log
describes a booting process." **That describes the process that is running now, and installing the
guard destroys it** — deploy requires `cargo build --release` → copy → `codesign` → server restart.
A fresh collector starts small and grows; whenever it crosses 2048 it exits with a log describing a
**grown** process, which is precisely the diagnostic 7168 was chosen to obtain. The crash-loop worry
needs a fresh process to breach 2048 *during boot*, and that is **UNVERIFIED**: the "boot scan peaks
at 0.97–1.00 GB" figure this card leaned on came from a compacted summary, and `grep` does not find
it anywhere in `design/tasks/`. If it is right, a fresh boot sits at half the cap and 2048 is simply
correct; if it is wrong, nobody has measured what a fresh boot costs.

**So the resolving measurement is one restart with the guard at 2048**, watching whether it survives
the boot scan — which is acceptance criterion #4, already on this card.

**THE CRASH LOOP DOES NOT EXIST — VERIFIED, and it inverts the risk this card has reasoned about
all evening.** `~/Library/LaunchAgents/com.agentlens.spool.plist` runs `agentlenspro spool ensure`
(NOT the collector), `RunAtLoad` only, **no `KeepAlive`**. `standalone/cli.ts:47` spawns alcore and
its `child.on('exit')` merely sets `process.exitCode` and resolves — **no respawn path**. So a guard
breach means the collector **stays down until a human restarts it**. Every "crash loop" risk on this
card and in four review passes was assumed, never checked; the real exposure is the opposite one — an
observability product silently dark for hours with nobody watching. That makes an **unattended**
deploy the thing to avoid, not the cap value.

**Also verified: the diagnostic APPENDS.** `write_log_file` opens with
`.create(true).append(true)` then `writeln!` → `flush` → `sync_all`, so successive breaches
accumulate and the first (most informative) entry is never overwritten.

**DO BEFORE DEPLOYING — pid 30984 is a 6.9-hour grown specimen and a restart destroys it.** Regrowing
one costs ~7 h. These are answerable ONLY on a live, grown process, and all four bear on the C++
side that the cap is really about:
- `SET SESSION memory_limit='1GB'` on a live connection — the scope falsifier (errors ⇒ global).
- `SELECT current_setting('memory_limit')` per store — does each connection hold the value its own
  `SET` asked for, or did a later `SET` win?
- How many distinct DuckDB **instances** the process holds — the additive unit the retracted
  ≈5.25 GB sum needed and never had.
- The parquet-metadata retention figure (~8,459 live sets vs ~1,587 sealed files) re-read now. 7168 buys information only
if 2048 cannot boot, and that is the thing to find out first, not to route around.

**OPEN DEFECT — the backstop stands in front of what it backs.** The two thresholds are keyed
on DIFFERENT counters and ordered backwards: the soft valve compares **RSS** against
`rss_budget_bytes()` = **4096 MB**, while the hard cap compares **phys_footprint** against
**2048 MB**. Footprint runs BELOW RSS here (6265 vs 6590–7930), so a process growing from cold
crosses footprint 2048 well before RSS 4096 — the hard cap fires before the valve has narrowed
once, and `rss_guard.rs`'s own module doc ("this is the backstop" to a valve that "already
narrows the window as RSS climbs") describes a sequence the shipped defaults prevent. Needs a
decision, not an edit: put both on the same counter, or set the cap above the valve's budget.

**CORRECTED — `memory_limit` is NOT untried; it is set everywhere, and that is the finding.**
The first version of this paragraph said "nothing in the tree appears to set it". That was a guess
dressed as an observation, and one `grep -rn memory_limit rust-core/ --include='*.rs'` refutes it.
**VERIFIED — exactly seven `SET memory_limit` statements** (the other four grep hits are two
comments, a `SELECT current_setting` readback, and a function signature):

| statement | limit |
|---|---|
| `card_store.rs:131` (`MEMORY_LIMIT`) | `256MiB` |
| `session_summary_sql.rs:127` | `1GB` |
| `transcript_sql.rs:402`, `:574` | `2GB` each |
| `statusline_store.rs:237`, `agentlens-store/lib.rs:144`, `bodies_evidence.rs:78` | parameterized |

**NOT VERIFIED, and an earlier version of this paragraph asserted it anyway: that these sum.** It
claimed `memory_limit` is per-connection and that the literals therefore license ≈5.25 GB. Two
reasons to distrust that: DuckDB's `memory_limit` is very likely a **database-instance** setting,
not a session one — in which case connections to the same instance share one budget and the last
`SET` wins — and a `SET` statement is not a connection either way (`open_store()` takes the limit
as a *parameter*, so one line can serve N callers). **The additive unit is distinct DuckDB
instances, and the grep cannot see how many there are.** Falsifier, one command:
`SET SESSION memory_limit='1GB'` — if it errors, the scope is global. `card_store.rs:328`'s
`SELECT current_setting('memory_limit')` readback is a hint someone already worried about
clobbering, which is a global-setting concern.

**VERIFIED and more useful than the sum was: four of the seven sites also `SET temp_directory=''`**
(`session_summary_sql:127`, `statusline_store:237`, both `transcript_sql` sites). That **disables
spilling**, so on those connections hitting the limit is a hard error, not degradation. Tightening
limits to reach 2048 MB therefore risks a collector that **fails its queries instead of exiting with
a log** — worse than the breach it prevents, because the exit is loud and produces the culprit file
the directive asked for. (Whether such a failure is logged or swallowed is unread — say "fails",
not "quietly fails", until a call site is checked.)

**Sharper than either the sum or its retraction, and it follows from evidence already in hand:**
seven `SET`s carry **five different values** across two crates. If the scope really is
per-instance-and-last-`SET`-wins, then whichever statement runs last silently governs every
connection to that instance — and `card_store.rs:328`'s `256MiB` readback assertion becomes a
latent failure waiting on ordering. Same falsifier settles it.

`card_store` asking for `256MiB` makes it *unlikely* to be the 5.1 G — not established: a
`memory_limit` bounds the buffer manager, not everything the store allocates; the readback's result
was never read; and under global scope a later `SET` may mean that connection is not at 256MiB at
all. `statusline_store` also sets `preserve_insertion_order=false`, i.e. someone has tuned that
connection for memory before.

A limit governs DuckDB's buffer manager, not the process, and per-reader parquet metadata is not
obviously charged to it — so the measured retention ratio (~8,459 live
`FileMetaData`/`SchemaElement`/`ColumnChunk` sets against ~1,587 sealed files) may be untouched by
any limit. Retention stays a Rust-side decision (readers not closed, a pool unbounded, re-globbing),
and ~619 MB sits in `MALLOC_*(empty)` free-list retention.

So the claim this paragraph supports is the narrow one: **zeroing the Rust HEAP does not reach 2048,
and `memory_limit` is already set at every site — so the untried lever is reader/instance retention,
not the limit value.** Whether limits sum is the open question above; settle it with the one-command
falsifier before building on either answer.

**NOT worth doing:** a restart with `MIMALLOC_SHOW_STATS=1` — those stats print at process **exit**,
so a restart yields nothing about the state under investigation, and it would destroy a 6.6-hour
specimen. `mi_process_info` (already linked by `466775af`) reads the same numbers live.

## WHY

OWNER DIRECTIVE, verbatim (2026-09-07): *"alcore must not use more than 2 gb of ram. if it ever
uses more than that, it must exit with error and a log that will allows to identify the culprit,
so we will fix the code."*

The existing valve is `SpanWindow::apply_memory_pressure`, called from `lib.rs::prune_window`
against `AGENTLENS_RSS_BUDGET_MB` (default 4096). It only NARROWS the span window — it cannot
stop growth anywhere else in the process, and it never fails loudly. The live process sat at a
5.4 GB physical footprint with that valve active.

## Measured starting point

Live collector, pid 30984, ~5 h uptime, measured 2026-09-07:

| metric | value |
|---|---|
| physical footprint | 5.4 GB (3.6 G resident-dirty + 1.8 G swapped) |
| resident | 8.8 GB |
| virtual | 17.3 GB |
| spans in the 5-minute window | 397 |
| largest vmmap region | `IOAccelerator` 4.5 G resident / 2.2 G dirty |

The `IOAccelerator` attribution to the mimalloc heap came from an UNOPENED memory-note title and
is **not verified**. It is 51% of resident and 61% of dirty, so it is the single largest lead and
nothing should be concluded about the cap's reachability until it is identified.

## The trap this card must not fall into

**The culprit log must not report counters for things already measured to be tiny.** A log that
prints "397 spans, small card store, 5.4 GB" leaves the owner exactly where they started and
fails the directive's own stated purpose. The diagnostic must carry an allocator/region
breakdown — at minimum `task_vm_info`'s `phys_footprint`, `internal`, `compressed` and
`external`, plus malloc-zone sizes.

**Which counter the cap is keyed on is a real decision, not a detail.** Physical footprint is
what macOS charges against jetsam and what Activity Monitor shows; RSS includes resident-but-clean
pages the OS reclaims for free, so an RSS-keyed guard can kill a healthy process and then indict
clean pages nobody needs to fix. Portability is the counter-argument — `phys_footprint` is
macOS-only via `task_info`/`TASK_VM_INFO` and Linux has no equivalent. Resolution: footprint on
macOS, RSS on Linux, and the log line names which one it measured.

## Acceptance

1. The guard fires deterministically in a test that allocates past a low cap set by env, and the
   process exits non-zero.
2. The culprit log is written, flushed and `fsync`ed to a known file path BEFORE the exit. stderr
   is not a destination — a prior startup crash on this project left `server.log` empty, which is
   exactly the failure mode that makes the directive unserved.
3. The log names the counter it measured and carries a region/zone breakdown, not just aggregate
   counters.
4. The guard's tick interval is stated, and the card records that a tick is a detector, not a
   guarantee: a fast allocation reaches the OOM killer first.

## Derived risks

- **Crash loop.** At a 5.4 GB footprint against a 2 GB cap the process breaches immediately,
  exits, restarts, breaches. The owner's observability product is then down and collecting
  nothing. This is the foreseeable outcome of shipping the 2048 default today, and it is the
  subject of the unanswered question above. `AGENTLENS_RSS_HARD_CAP_MB` is an env var, so the
  decision is reversible without a rebuild — that makes it cheap, not unimportant.
- **Torn writes.** An abrupt exit mid-append can leave a span segment half-written. `cards.duckdb`
  is a spill file replaced at boot and is safe; appended segments are not obviously so.
- Landing this REMOVES nothing, but TRDD-KBM09XHB later deletes `apply_memory_pressure` along
  with `SpanWindow`. This card must land first or that change leaves a window with no memory
  protection at all.
