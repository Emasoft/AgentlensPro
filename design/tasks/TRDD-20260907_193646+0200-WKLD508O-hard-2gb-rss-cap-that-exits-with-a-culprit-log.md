---
trdd-id: WKLD508O
title: alcore exits with a culprit log rather than exceed a 2 GB memory cap
column: dev
created: 2026-09-07T19:36:46+0200
updated: 2026-09-07T22:23:24+0200
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

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-07 21:59

**CODE LANDED, NOT DEPLOYED.** `466775af` (worker's implementation) + `f9776548` (two defects I
found by reading the 244 lines I had committed after reading ~60). The worker has finished and
released the crate. 8/8 tests green.

**DEPLOY STATE (durable — the chat transcript is not).** `cargo build --release` is **DONE**,
exit 0: `rust-core/target/release/alcore`, 55,409,760 bytes, 2026-09-07 21:56 (from `stat`).
`bin-native/darwin-arm64/alcore` still holds the **old** binary (55,104,624 bytes, 2026-09-06
04:13) — a fresh `target/release/alcore` is NOT a deployed one, and a later reader who sees only
the mtime will get that wrong. Three commands remain:

```
cp rust-core/target/release/alcore bin-native/darwin-arm64/alcore
codesign -s - --force bin-native/darwin-arm64/alcore
agentlenspro server restart
```

**Do NOT call the copy risk-free — I did, in chat, and it was wrong.** CLAUDE.md records `cp`
over a RUNNING, mapped binary as the live competing explanation for the exit-137 silent-SIGKILL
incident (the copy there *did* precede the restart, with the old process still alive — exactly
this shape). Keep copy + codesign **adjacent to the restart**, not staged hours ahead. Only the
`cargo build` was ever free.

**The restart destroys pid 30984** (~7 h uptime), and with it the only live specimen. Three of
the four questions I have been calling "specimen-only" do **not** need it — the `memory_limit`
scope falsifier and the `current_setting` readback are DuckDB semantics reproducible anywhere,
and the parquet-retention re-read is on-disk. Only *reconciling* `rssMb 7930` vs `ps` 6.6 GB vs
`footprint` 6265 MB needs the live process. I over-scoped that set across several turns.

**No launchd respawn — now verified structurally, not by grep.** `plutil -p` (binary-plist-safe;
a raw `grep` for an ASCII key can return a false 0 on a bplist, and this machine's `grep` hides
binary matches without `-a`) on the **only** agentlens job anywhere under `~/Library/LaunchAgents`,
`/Library/LaunchAgents`, `/Library/LaunchDaemons`: `com.agentlens.spool`, `RunAtLoad: true`, no
`KeepAlive`, and `ProgramArguments` = `agentlenspro spool ensure`. That subcommand only re-creates
the RAM-disk spool (`src/cli/spoolCli.ts`) — **it does not start the server.** So the one launchd
job on this machine cannot bring the collector back.

**What that scan STILL cannot see — it rules out a differently-NAMED job, not a differently-
REFERENCED one.** Re-run 22:04 matching on decoded CONTENT rather than filename (24 plists: 15
user + 2 `/Library/LaunchAgents` + 7 `/Library/LaunchDaemons`), same single hit, and `launchctl
list` shows only `com.agentlens.spool` loaded. But the matcher is still three literal substrings,
so the blind spots are one indirection away: a wrapper script in `ProgramArguments[0]` (the plist
stays clean, the script does the work — the likeliest real shape), `sh -c "$VAR serve"`, a symlink
or short alias, a generic supervisor with the collector in ITS config, a `launchctl submit` job
with no plist on disk at all, and `/System/Library/Launch*` which was not scanned. Also unchecked:
cron, login items, and `server start`'s own retry logic. **A machine with a differently-named
supervisor and a machine with no supervisor produce identical output from this scan** — so it
corroborates, it does not discriminate. Treat "no respawn path" as well-supported, not proven.

**THE CAP IS RE-READ EVERY TICK — verified at the call site, not inferred.**
`rss_hard_cap_bytes()` is invoked at `lib.rs:698`, inside the `CulpritSnapshot` built for each
`check_and_enforce` call in `prune_window` — i.e. per tick, not cached at startup. So the value is
env-sourced continuously; a restart is still needed in practice only because a running process's
environment cannot be changed from outside. **"Costs a restart, not a rebuild" is now verified.**
Earlier I asserted it from the unit test alone, which only ever proved the "not a rebuild" half.

**SPECIMEN CAPTURED before the restart destroys it — pid 30984, 22:03, uptime 07:45:23.**

| metric | value |
|---|---|
| `ps` RSS | **8892 MB** |
| `vmmap` physical footprint | **6.2 G** |
| footprint peak | **9.9 G** |

**The ordering has INVERTED since 21:0x** (then: footprint 6265 MB > `ps` RSS ~6.6 GB… i.e. close;
now RSS exceeds footprint by ~2.5 G). RSS counts resident pages including clean/reclaimable ones;
`phys_footprint` does not. **The guard measures RSS** (`server_stats::rss_bytes`), so it fires on
the larger, partly-reclaimable number — and its culprit log would indict pages the OS would have
given back for free. That is an argument for measuring footprint on macOS, and it is now backed by
a measured 2.5 G gap rather than by theory. Peak footprint also grew 8375 MB → 9.9 G in one hour:
**the process is still growing, so a fresh boot's peak remains the unmeasured quantity that
decides whether 2048 is reachable at all.**

**THE STRONGEST LEAD ON THE ~5.1 G OF C/C++ ALLOCATOR, and the first that is not a guess:
39,781 parquet files in the LIVE store** (`~/.agentlens/store`: 2.3 G `parts`, 1.7 G `blobs`,
133 M `bodies`). Another 14,555 sit in `store.old-v2-prerepair-…`, 1,588 under `statusline`, 1,026
in `store.old-v0` — those are archives the running process should not be opening, and separating
them is the point of counting per-subtree. DuckDB holding metadata across ~40 k parquet files is a
plausible multi-GB consumer, and it is Rust code that decides how many readers exist. **NOT yet
established** that this is where the memory is — it is a lead with the right order of magnitude,
and the next measurement should test it directly.

**⚠ THE FULL REGION TABLE (22:07, pid 30984) REVERSES THIS CARD'S CENTRAL SPLIT, AND KILLS THE
PARQUET LEAD I POSTED 20 MINUTES AGO.** `vmmap` (full, 4,717 lines — not `-summary`):

| region type | resident | dirty | swapped | regions |
|---|---|---|---|---|
| **IOAccelerator** | **4.4 G** | **2.9 G** | 63.9 M | 49 |
| MALLOC_SMALL | 2.6 G | 246.2 M | 38.5 M | 1833 |
| MALLOC_SMALL (empty) | 1.1 G | 12.8 M | 0 | 397 |
| MALLOC_LARGE | 418.9 M | 418.9 M | **2.6 G** | 197 |
| MALLOC_LARGE (empty) | 630.3 M | 630.3 M | 0 | 79 |
| **`mapped file`** | **80 K** | 0 | 0 | **1** |
| TOTAL | 9.4 G | 4.2 G | 2.7 G | 4628 |

`MALLOC ZONE DefaultMallocZone`: 4.1 G resident, 711.8 M dirty, 2.7 G swapped, **3,712,017 live
allocations**, 4.9 G allocated, 0% fragmentation.

**Three hypotheses die on this one table:**

1. **Parquet metadata — DEAD.** `lsof` on pid 30984: 34 open fds total, **3 parquet files open**,
   not 39,781. And the arithmetic I never did before calling it "the right order of magnitude":
   5.1 G ÷ 39,781 = **134 KB of resident metadata per file**, where a parquet footer is
   single-digit KB. Ten to a hundred times too high, and the files are not even open. I posted
   that lead to the card AND to the owner one commit ago (`3ece83dc`); it is retracted.
2. **Mapped-file page cache — DEAD.** `mapped file` is **80 K resident in one region**. The 2.3 G
   of RSS growth in the last hour is not file-backed pages.
3. **"~0.96 G Rust vs ~5.1 G C/C++, about 5:1" — REVERSED, but my first correction of it was
   itself computed wrong. Both are recorded here; the second supersedes the first.**

   **The wrong route (published 22:07 in `a38be9b1`, and to the owner):** IOAccelerator dirty 2.9 G
   + swap 63.9 M ≈ 3.0 G vs *the MALLOC ZONE row* dirty 711.8 M + swap 2.7 G ≈ 3.4 G → "roughly
   1:1". **That comparison is invalid: the `MALLOC_*` region rows and the `DefaultMallocZone` row
   are two views of the same bytes** — which is exactly what the table's own annotation "see MALLOC
   ZONE table below" says, printed on every one of those rows. The arithmetic proves it: the region
   rows already sum to the TOTAL (malloc 4.87 G + IOAccelerator 4.51 G + ~0.32 G of everything else
   ≈ 9.4 G = the TOTAL row). Adding the zone's 4.1 G on top would give ~13.5 G resident against a
   9.4 G total — impossible. **The zone row must not appear in the comparison at all.**

   **The corrected arithmetic — region rows only, all seven `MALLOC_*` rows summed:**

   | column | IOAccelerator | all `MALLOC_*` | ratio |
   |---|---|---|---|
   | RESIDENT | 4.40 G | **4.76 G** | **0.9 : 1** |
   | DIRTY | 2.90 G | 1.31 G | 2.2 : 1 |
   | DIRTY + SWAPPED | 2.96 G | 3.95 G | 0.75 : 1 |

   **The ratio depends entirely on the column, because malloc's memory is heavily swapped (2.64 G)
   and IOAccelerator's is not (63.9 M).** The guard measures **RSS**, and RSS counts resident pages
   and *not* swapped ones — so **the guard's own column is RESIDENT, where it is 0.9 : 1.** "Roughly
   1:1" happens to be right for the guard's metric; it was published on the wrong column by a route
   that double-counted, and it is wrong (2.2:1) on dirty. **Away from 5:1 in every column** — that
   part stands.

   **RSS-vs-footprint — and the "~1.72 G of empty regions" I published is WRONG by 55%.** I wrote
   that `MALLOC_LARGE (empty)` 630.3 M + `MALLOC_SMALL (empty)` 1126.4 M = ~1.72 G is "charged to
   RSS, not to footprint". **`(empty)` and "not charged to footprint" are different properties and
   I conflated them.** `MALLOC_LARGE (empty)` is 630.3 M resident against 630.3 M **dirty** — 100%
   dirty, and dirty anonymous pages are charged to `phys_footprint` whether or not a live
   allocation sits in them, because the allocator has not `madvise`d them away. Only
   `MALLOC_SMALL (empty)` (1126.4 M resident, 12.8 M dirty) is mostly clean. **The quantity is
   ~1.11 G, not 1.72 G.**

   **The number to use instead requires no allocator-internals reasoning at all, and is directly
   measured: RSS 8892 MB vs footprint 6349 MB — a ~2.5 G gap. THAT is the quantity the metric
   choice controls**, and it cannot be wrong the way the sentence above was. (For completeness, the
   resident-but-clean total across every `MALLOC_*` row is 4.76 − 1.31 ≈ **3.45 G**, because
   `MALLOC_SMALL` alone is 2.6 G resident against 246 M dirty.)

   **The better argument for footprint is not about residue at all: RSS can FALL with nothing
   freed**, purely from eviction under system pressure, so an RSS guard is non-deterministic with
   respect to the program's own behaviour — two identical runs on differently-loaded machines
   breach at different times. **But switching metric does NOT save the cap:** footprint 6.2 G and
   RSS 8.9 G are both ~3× over 2048 MB. The metric decides *what fires the guard*, not *whether*.

   **The mimalloc identification is now settled from the BUILD, not from a memory page.**
   `rust-core/crates/agentlens-core/src/bin/alcore.rs:34` — `#[global_allocator] static GLOBAL:
   mimalloc::MiMalloc` — with `mimalloc = "0.1.52"` + `libmimalloc-sys` (`extended`) in that crate's
   `Cargo.toml`. **mimalloc IS alcore's allocator**, so the branch that would have inverted
   everything ("mimalloc isn't in this build, the split is unmeasurable") is closed. What remains
   unproven is only the tag-100 → `VM_MEMORY_IOACCELERATOR` step. Four independent shape arguments
   from this same table support it and none oppose it: 49 regions holding 4.8 G virtual is ~100 MB
   per region (arena allocator, not GPU surfaces); a 256 MB `IOAccelerator (reserved)` region at
   `0x5311a000000` is reserve-then-commit, mimalloc's arena strategy; 66% dirty-of-resident is
   heap-shaped, not the all-or-nothing of a mapped GPU surface; and **63.9 M is swapped, where
   IOKit/GPU memory is wired and cannot swap at all.**

### ⚠ DEPLOYED 22:21 — the binary carrying the guard is in place; the RESTART is not done, and doing it WILL kill the collector

`bin-native/darwin-arm64/alcore` now carries `AGENTLENS_RSS_HARD_CAP_MB` (inode 1550846767,
22:21:45; the outgoing binary is preserved at `alcore.prev`, inode 1550845115). pid 30984 was
untouched by the deploy and is still up.

**The deploy used an ATOMIC RENAME, and the reason is the exit-137 in CLAUDE.md.** Never `cp` over
the destination: `cp` opens the SAME inode `O_TRUNC`, and the running process has that inode
**mmap'd** — overwriting it invalidates the mapped image's code signature and macOS SIGKILLs the
process. `codesign --force` rewrites in place too, same hazard. So: copy and sign a SEPARATE inode
(`alcore.new`), pre-flight it (`--version`, and assert the exit is **not 137**), then `mv` —
`rename(2)` swaps only the directory entry, and the old inode stays mapped and valid until the
process exits. **This makes the "cp over a running mapped binary" explanation in CLAUDE.md the
stronger of the two competing ones, and it means the deploy was always safe to do without a
restart — the hazard was in the METHOD, not in the act.** (Recorded because I deferred the whole
deploy for five hours on a hazard that this three-line form removes.)

**⚠ DO NOT RESTART UNATTENDED.** The live process is at ~8.9 G RSS against a 2048 MB cap. Restarting
arms a guard that will kill the collector — **not a risk, an arithmetic certainty.** Boot peaks
~1 G so it will not crash-loop instantly; it will run some hours, breach, exit, and repeat, and
with no respawn path each death lasts until a human intervenes. Either raise
`AGENTLENS_RSS_HARD_CAP_MB` for the first run (env-read per tick — a restart, not a rebuild) or
land the memory work first.

### THE CAP AND THE DuckDB BUDGETS CANNOT BOTH BE 2048 MB — but "unreachable by construction" over-claimed it

**Retracted wording.** What is proven is the absence of a BOUND, not the presence of a BREACH:
nothing in the configuration bounds this process below 2048 MB. Whether it is *exercised* is a
runtime fact I did not measure. Two things I got wrong by publishing the stronger form:

- **Exactly ONE connection is resident** — `CardStore.conn` at 256 MiB. Every 2 GB site is per-call
  or per-pass, so the 4 GB figure needs two transient connections to *coincide*, which I inferred
  from "both exist" and never showed happens.
- **A guard that fires and names DuckDB is the directive being SERVED, not defeated.** I framed a
  success case as a design failure. And "unreachable by construction" is exactly the sentence
  someone quotes to justify raising the cap to 8 GB — which defeats the directive, whose whole
  point was to make the process die so the culprit surfaces.

**To earn the stronger word:** measure peak DuckDB buffer during one real bodies pass. Peak 1.8 GB
⇒ earned. Peak 150 MB ⇒ it is a config-hygiene finding, correctly stated as the weaker claim above.

Independent of every allocator question above, and verified first-hand by reading all seven call
sites (`grep -rn "memory_limit\|Connection::open" rust-core/crates --include='*.rs'`):

| call site | connection | limit | lifetime |
|---|---|---|---|
| `card_store.rs:131` | `Connection::open(cards.duckdb)` | 256 MiB | **resident** (`CardStore.conn`) |
| `statusline_store.rs:237` (`open_duck`) | `open_in_memory()` | **2 GB** (`AGENTLENS_DUCKDB_MEMORY_LIMIT` default) | per read and per seal |
| `session_summary_sql.rs:127` | `open_in_memory()` | 1 GB | per call |
| `bodies_evidence.rs:78` (`with_duck`) | `open_in_memory()` | **2 GB** (env-overridable) | per call |
| `store/lib.rs:144` (`open_store`) | `open_in_memory()` | **2 GB** — `chores.rs:288` passes it, **every 60 s inside the resident server** | per pass |
| `transcript_sql.rs:402` (`query`) | `open_in_memory()` | **2 GB** | per call |
| `transcript_sql.rs:574` (`DuckSession`) | `open_in_memory()` | **2 GB** | per session |

**Six of the seven are `Connection::open_in_memory()`, which is a SEPARATE DuckDB instance by
construction** — separate `DBConfig`, separate buffer manager. So these seven `SET memory_limit`
statements do not compose into one budget: **whatever is concurrently alive, their ceilings SUM.**

The consequence is arithmetic, not inference: **the bodies chore alone (`open_store(…, "2GB", 2)`,
every 60 s, in the resident server) permits 2048 MB of DuckDB buffer — the entire proposed process
cap — before one byte of Rust heap, span window, or card store.** An HTTP request landing in
`transcript_sql::query` or `bodies_evidence::with_duck` while that pass runs permits **4 GB
concurrently.** A 2048 MB process cap and a 2048 MB single-connection DuckDB budget cannot both
hold; **the cap and the DuckDB limits have to be sized together, or the guard fires on correct,
in-spec behaviour.**

Two honest limits on this finding: a `memory_limit` is a **ceiling, not a reservation** — DuckDB
takes what a query needs up to it, so "4 GB permitted" is not "4 GB used"; and it governs DuckDB's
**buffer manager**, not every allocation DuckDB makes. It does not by itself explain 9.4 G resident.
It does explain why 2048 is not reachable without changing these numbers.

`rust-core/crates/agentlens-store/tests/memory_limit_scope.rs` (4/4, my own run) measures
`memory_limit` to be per-connection-handle, with `SET SESSION memory_limit` rejected outright
(`option "memory_limit" cannot be set locally`). **Its load-bearing test is the SAME-FILE one, not
the `open_in_memory()` one** — I had this backwards in `de505185`'s commit message. `open_in_memory()`
settles instance separation on its own, so testing it adds nothing; but `card_store.rs` uses
`Connection::open(path)`, where two handles to one file *could* plausibly share an instance. Test 4
shows they do not. That is the only site the argument could not reach without a measurement.

### ⚠ `SELECT * FROM duckdb_memory()` IS STRUCK — my own finding above killed it, and four reviews had named it the top measurement

It reports the memory of **the connection it runs on**. Since the seven sites are seven separate
instances with seven separate buffer managers, **no connection's `duckdb_memory()` answers "how much
is DuckDB using in this process"** — not even after a restart. Worse, the one route in (a SQL
endpoint) goes through `transcript_sql::query`, which opens a *fresh* connection per call and would
report that new connection's near-zero usage: a confident wrong number, strictly worse than none.
**Replacement, and it is a code change rather than a specimen measurement: have the guard call
`duckdb_memory()` on every LIVE connection and sum them into the culprit log.** This also removes
the reason pid 30984 was being treated as precious.

**`server_stats::rss_bytes()` VERIFIED at `server_stats.rs:313` — it really is RSS.** macOS branch:
`proc_pidinfo(PROC_PIDTASKINFO)` → returns `pti_resident_size`. Linux branch: field 2 of
`/proc/self/statm` × page size. Both are resident-set size; neither is `phys_footprint`. **This was
the weakest link in everything above** — every metric argument assumed it from the function's NAME,
and a name is not behaviour. It resolved in favour of the assumption: RESIDENT is the guard's
column, the 0.9:1 ratio is the operative one, and the footprint recommendation is a live change
rather than a no-op. Had it returned `phys_footprint`, the operative ratio would have been 2.2:1.

**"The ordering inverted" (previous section) is WRONG — correct it when next edited.** At 21:0x
RSS ~6.6 G was already above footprint 6265 MB. Nothing flipped. What happened: **footprint stayed
flat (6265 → 6349 MB, +84 MB, ~1%) while RSS grew ~2.3 G in an hour.** Flat footprint with rising
RSS means growth in pages footprint does not charge — and since `mapped file` is 80 K, the
remaining candidate is the IOAccelerator/tag-100 region's accounting, not page cache.

**FAILED MEASUREMENT, recorded rather than dropped:** `agentlenspro server status` returned EMPTY
this turn and last. That is the surface that produced `rssMb 7930` at 21:0x, so the three-way
reconciliation is still open — I have two numbers, not three. Unknown whether the cause is the
invocation, a timeout, or an unresponsive server; **the last would change the restart calculus**
and is unchecked.

**STILL UNRUN and specimen-bound: `SELECT * FROM duckdb_memory()`** — DuckDB's own per-tag
accounting. It would name the culprit tag directly, and if the answer is a DuckDB tag then the
guard's culprit log as specced (span counts, card rows, segment counts, uptime) **can never name
it** — that would be a design defect in the deliverable, not a research nicety.

**MEASUREMENT ERROR, mine, recorded so the number is not quoted later:** the first parquet pass
reported "0.0 MB total". That is garbage — `find` on this machine is `bfs`, which does not support
`-printf`, so the byte stream was empty and `awk` summed nothing. The COUNTS came from `wc -l` and
are sound; the byte figures above come from `du`. No byte total from that first pass is usable.

**OPTION B IS THE STRUCK 7168 PROPOSAL RETURNING, and I owe the owner that label.** I have put two
options to them: deploy at 2048 now, or start once at a high value and tighten to 2048 with them
present. The second is the override I proposed and struck earlier tonight, now bounded to one
night. The difference is real (a staging value with a named end condition is not a shipped
default) but smaller than the framing implies: **during the overnight window the directive is not
enforced under either version**, which is exactly what I argued against when I struck it. The
sunset also depends on a future action by me, and this session's record is twelve docs commits and
zero deployments. The owner should weigh it knowing it is the same proposal.

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

**CAP VALUE — 2048, per the directive. An override was considered and REJECTED.** An earlier version
of this header read "DECIDED BY DEFAULT — the owner did not answer in two hours … restated six
times", which was wrong twice over: the owner was absent, not unresponsive (silence is not a stall
and cannot grant consent), and what survived is the owner's own directive, so there was never a
default to take. The header now describes its own contents.

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

**NO RESPAWN PATH FOUND — and it inverts the risk this card has reasoned about all evening.**
`~/Library/LaunchAgents/com.agentlens.spool.plist` runs `agentlenspro spool ensure` with `RunAtLoad`
and no `KeepAlive` (`grep -c KeepAlive` on the whole file = **0**, so that absence is conclusive for
the literal key). `standalone/cli.ts:34` spawns alcore and its `child.on('exit')` merely sets
`process.exitCode` and resolves — no respawn. So a guard breach most likely leaves the collector
**down until a human restarts it**. Every "crash loop" risk on this card and in four review passes
was **assumed, never checked** — that much is certain — and the real exposure looks like the opposite
one: an observability product silently dark for hours with nobody watching. That makes an
**unattended** deploy the thing to avoid, not the cap value.

**Scoped honestly, because this is a NEGATIVE existence claim and an earlier version shouted it as
VERIFIED:** `spool ensure`'s *implementation* was never read — "not the collector" is inferred from
the subcommand name. And `cli.ts`'s `runServerForeground` is the FOREGROUND path; a 6.9-hour
collector was plausibly started some other way, and that launcher's exit handling is unread. What IS
solid: no loaded launchd job but `com.agentlens.spool` (status `-  0`, not running), nothing in
`/Library/Launch{Daemons,Agents}`, and `KeepAlive` literally absent. Not checked: cron, shell
wrappers, `server start`'s own retry logic.

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
- The parquet-metadata retention figure (~8,459 live sets vs ~1,587 sealed files) re-read now.

**FIRST OF THOSE ANSWERED, and it undercuts the instance theory.** `lsof -p 30984 | grep .duckdb`
returns exactly **two** paths, and **both are EXTENSIONS** — `.duckdb/extensions/v1.5.5/osx_arm64/{json,parquet}.duckdb_extension`.
**No database file is open at all**: no `cards.duckdb`, no store db. So the "many DuckDB instances,
each with its own `memory_limit` budget" theory gets no support from the live process — whatever the
seven `SET` sites are configuring, the grown process is not holding open database files. Candidates:
in-memory (`:memory:`) databases, or connections opened and closed per operation. Either changes what
`memory_limit` can bound. NOT yet checked: whether `lsof` would show a `:memory:` database (it would
not — that is the point), so this **narrows** the theory rather than refuting it outright.

**And the no-auto-restart finding is now properly verified**, closing a gap in the version above:
`launchctl list` (which sees agents regardless of directory) shows only `com.agentlens.spool`, status
`-  0` (not running); `/Library/LaunchDaemons` and `/Library/LaunchAgents` hold nothing matching; and
`grep -c KeepAlive` on the plist returns **0**. The earlier claim rested on a `grep -A2` that could
have hidden a `KeepAlive` key; it cannot now. 7168 buys information only
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
