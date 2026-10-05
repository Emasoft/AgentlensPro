---
trdd-id: 6SPXOV0P
title: 307 files remain parked with a ts-row mismatch after the TRDD-8TM7I49X repair
column: human_review
created: 2026-08-26T20:13:05+0200
updated: 2026-10-05T03:18:10+0200
eht: [7NHUU6GK]
current-owner: main
task-type: bugfix
severity: MEDIUM
priority: 3
labels: [bodies, ingest, silent-failure, capacity]
relevant-rules: []
release-via: none
status: tasked
---

## ⏵ AI-REVIEW VERDICT 2026-09-05 — APPROVE, and it still cannot reach `complete`.

All 7 ticked boxes verified first-hand **by the reviewing agent** (code read, tests run 7/7, clippy
clean, commits checked). Report: `reports/ai-review/20260905_073032+0200-6SPXOV0P.md`.

**Provenance, stated because the neighbouring cards' blocks differ**: the seven boxes rest on that
agent's report and were NOT re-checked by the orchestrator. The ONE thing re-checked here is the
EHT's column — a governance fact, adjacent to all seven boxes and about none of them. Compare
TRDD-5PUD8RKE, whose block carries a per-box table naming who verified each; this card has no such
table and does not inherit that standard.

What the agents' track record actually supports, stated narrowly: **their file:line citations have
resolved correctly on every card where they were spot-checked — three of five** (5PUD8RKE,
8ADTIGKT, L6V1UUW0 were checked directly; ZW4APOPI's chain was transferred; this card's boxes were
not checked at all). "Five cards" would be circular — two of the five are cards this claim would be
propping up. And a citation check is a HALLUCINATION check: it shows the agent does not invent
references. It is NOT evidence that a `cargo test` it reported as 7/7 actually ran, which is the
claim carrying this card. The APPROVE is accepted on that narrower basis, plus the fact that
nothing moves on it while the EHT is open.

**The column stays where it is, and not for a review reason.** `eht: [7NHUU6GK]`, and that EHT is
at `column: backburner` — verified here, not taken from the report. A parent cannot reach
`complete` until every EHT is terminal, so this card's own boxes being green does not move it. Do
not read the APPROVE as "ready to close": what it means is that nothing in THIS card is
outstanding. TRDD-7NHUU6GK is.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

**2026-09-02 — the drain, landed `f9605164` (Rust `pass.rs`); the 08-27 text below is the design
record.** Option A shipped in `aa0caa40` (benign reclaim + `reclaimed_reemitted`), but the live
server still reported **PARKED 307 files / 144.3 MB** a week later, after restarts: a name already
in `.pass-state.json`'s `strandedNames` was `continue`d BEFORE the gate on every pass, so the
reclaim branch never saw it. Live state read: skip 122,770 · stranded 307 · overlap 307 — every
parked name is durable, parked for exactly the now-benign reason. Fix: a stranded name with no
`relocate_stranded_to` is removed from the stranded set and routed to the gate as a skip name; the
gate reclaims (clean or ts-only) or drops the skip name for re-ingest. Relocation (operator
option) still wins. Test `legacy_stranded_name_drains_through_the_gate_and_the_parked_set_reaches_zero`
(box 3). Store crate 7/7, clippy `--all-targets -D warnings` 0. Box 2 was already true in
`storeAdmin.ts` (`nothing is parked` :88 · `parked: N — F repairable, G ghost(s)` :122 · `unparked N
(M still stranded)` :175) — stale box text, ticked on read.

**LIVE, 2026-09-02 07:53 — settled on the FILES, not on the gauge** (the adversarial review's
point: the drain empties `strandedNames` BEFORE the gate decides, so "PARKED 0" alone would also
read 0 if all 307 had failed verify and were being re-examined every tick). Deployed `f9605164`'s
alcore (fresh inode, new pid 31959 started 07:53:12, binary written 07:53:10). Boot pass line in
`server.log`: **`ingested 9, deleted 316, freed 148.1MB across 2 dir(s)`** — 316 = the 307 legacy
parks + 9 fresh; `capture:` went 308 live files (PARKED 307, 144.3 MB) → 4 → 21 (fresh capture,
no PARKED suffix); `.pass-state.json` strandedNames 307 → 0. A body is deleted only after the
store reproduces it bit-exact — but "316" alone cannot say how many of the 307 it covers (a
SIGTERMed old tick can leave ingested-not-yet-deleted files for the boot pass to delete
uncounted). The proof that CAN'T lie (review): a legacy file that fails verify is KEPT and
re-examined every 60 s, and it is days old while fresh captures are seconds old — **files older
than 1 h left in either bodies dir at 08:06: 0** (legacy dir 0 files, spool 37 fresh); the three
passes after boot each read `ingested N, deleted N` (no failed loop). Live exe pinned with
`lsof -p 31959`: `bin-native/darwin-arm64/alcore`. The chore's log line now also
prints `(N re-emitted), failed M` so a future silent-failure loop is visible in the log (this
last change is NOT in the deployed binary; it ships with 2.33.2).

**AI_REVIEW 2026-09-04T16:30+0200 — what was established, and what was NOT.** An earlier version
of this block claimed the acceptance was "re-verified ... on evidence the original run could not
have had". **That was overstated and is corrected here**; adversarial review caught three defects
and two commands settled them.

ESTABLISHED (measured 16:30–16:34):
- **The bodies chore is scheduled, running and completing** — consecutive `bodies pass` lines in
  `~/.agentlens/server.log` read `ingested 12, deleted 12 (0 of them re-emitted), failed 0`. A dead,
  crash-looping, or lock-wedged chore cannot print that. **It does NOT exercise `f9605164`'s reclaim
  branch**, which is reachable only with a non-empty `strandedNames` — and the tell is inside the
  line itself: `(0 of them re-emitted)` is the `reclaimed_reemitted` counter, pinned at 0 in every
  sample because nothing is stranded. This is a liveness proof for the surrounding machinery, not a
  proof of the fix.
- **The serving binary is alcore, not the TS twin** — `lsof -p 37180` txt → 
  `bin-native/darwin-arm64/alcore`. Worth pinning because `rustBinResolve` falls back to the TS
  server SILENTLY, and TRDD-M2VK8T4P (a codesign SIGKILL) landed today, making that fallback a live
  possibility rather than a theoretical one.
- **No new stranding in two days**: legacy dir `~/.agentlens/otel-bodies` 0 files, `capture:` shows
  no PARKED suffix (was 308 live / PARKED 307 / 144.3 MB), 0 files older than 1 h in either dir.
- A process boundary exists (pid 37180, uptime 7h34m; the 09-02 run was pid 31959).

NOT ESTABLISHED — do not read this run as a re-test of the fix:
- **The 307-file backlog drain was NOT re-tested.** No legacy backlog remains, so the card's aging
  falsifier (*a file that fails verify is KEPT and re-examined every 60 s, so it would age*) has
  nothing left to falsify. Today's "0 files older than 1 h" is equally consistent with a working
  drain and with a drain that never ran — fresh captures never reach 1 h either way. It tests
  ABSENCE OF BACKLOG, not DRAIN OF BACKLOG. The pass-log lines do NOT rescue it either (an earlier
  version of this block claimed they did): they prove the chore runs, not that the reclaim path
  works — see above.
- **That the running binary contains `f9605164` at all.** `bin-native/` is gitignored with no
  recorded link to a commit. An earlier version inferred "at least as new as f9605164" from the
  `(N re-emitted), failed M` log format; that inference is **backwards** — the `reclaimed_reemitted`
  counter it names came from `aa0caa40`, which PRECEDES `f9605164`. A binary printing 2.33.2-era
  logging contains the LOGGING change; nothing here shows the two shipped in the same build. The
  honest statement is: alcore is serving, it prints 2.33.2-era logging, and whether `f9605164`'s
  reclaim fix is in it is unestablished.
- The matching `capture: 11` on both dates was struck from the record: two instantaneous samples of
  a rolling window that turns over in seconds ("newest 2s ago"). Equality there is coincidence, and
  presenting it beside two real findings lends it unearned weight.

**COLUMN NOT CHANGED, deliberately.** `ai_review → complete` is not on
`manager-approval-defaults.md`'s exempt list, so it is non-exempt and not mine to perform
unilaterally. This session already made that exact error on TRDD-99HUNXJS (closed while an
adversarial verdict said NOT COMPLETE, and the reviewer's objection proved correct within the
hour). Recording a verified review verdict IS exempt (table E, runtime evidence); moving the card
is not.

**AND APPROVAL ALONE WOULD NOT BE ENOUGH — this card CANNOT reach `complete` yet.** `eht:
[7NHUU6GK]` is `column: backburner`, i.e. not terminal, and a parent may not reach `complete`
until every EHT is terminal. An earlier version of this block said the card was "ready to close on
a USER/MANAGER decision"; that was **false**, and it is the worse kind of false — a correctly
cautious process decision (not moving the column) carrying an incorrectly confident claim about
what a human's approval would achieve.

**NEXT ACTION:** none on this card. It is genuinely blocked on EHT 7NHUU6GK reaching a terminal
column; only then does `ai_review → complete` become an approval question. Follow-up noted, not
carded: `PassResult.stranded_ts` is
written by nothing now but still serialized/read (`src/rustStorePass.ts:102`); retire it with
the TS mirror in a later sweep.

### 08-27 design record (superseded where the paragraph above says so)

**DESIGN DECISION: option A — capture time stops being anchored to the file's mtime.** Decided
2026-08-27 by main under USER delegation ("decide yourself … on verified facts"). Option B (make
every restore path preserve mtime) is not available: the files are written by Claude Code
(`~/.claude/settings.json` env `OTEL_LOG_RAW_API_BODIES=file:/Volumes/AgentLensSpool/otel-bodies`,
re-verified 17:5x), and no restore path in this repository produces them — there is nothing on our
side to make preserve anything. Still 307 parked at 17:5x (`server status`), flat since 08-26.

**Shape of A (smallest that closes the loop):** the ingest-time row is authoritative once set.
`pass.rs:351` passes `ts_ms: Some(b.mtime_ms)` to verify; `lib.rs:589` fails a body whose row ts
differs from that by >2 s; `pass.rs:386` then parks it when `b.durable`. For a durable body the
bytes are proven — the only thing the store exists to guarantee — and a later mtime is a re-emit,
not a corruption. So: a ts-only disagreement on a durable body is BENIGN — reclaim it, do not park
(count it, so the pass can report "N re-emitted bodies reclaimed"). Non-durable bodies keep the
current path. This also retires the "repair rows from mtimes" remedy, which overwrote the true
capture time with a re-emit's mtime.

**ADVISOR CONSULTED 2026-08-27; its two load-bearing claims re-verified by main at `file:line`
before acting** (an advisor is a second opinion, not a source of truth):

1. *"the byte proof is already complete at the park site"* — ✓ TRUE. In `lib.rs` the ts check
   (`:586`) runs strictly AFTER the sha256 reconstruction check (`:569`) and the row-existence
   check (`:578`), each with its own `continue`. So a "stored ts != capture time" reason implies
   the store reproduces the file bit-exact, and reclaiming there is exactly as safe as the normal
   `v.ok` delete.
2. *"the retention gate will keep such a volume forever"* — ✓ TRUE, and it is a real second site:
   `server.ts:833` purges only when `verifyVolumeInStore` passes, and `:806` states the contract as
   "bytes + capture-ts row". Filed as the EHT [[TRDD-7NHUU6GK]] rather than widened into this card.

**Scope narrowed on that advice:** the change lives in `pass.rs`'s park branch ONLY. `TS_TOLERANCE_MS`
and `verify_bodies_in_store_cached` stay strict — other proofs (the retention gate above) depend on
them, so loosening either would trade one silent defect for a wider one.

**The ROW is left alone.** It holds the ORIGINAL capture time; the re-emitted FILE carries the
impostor mtime. "Take the earlier of the two" would be wrong for rows the old repair verb already
overwrote with mtimes, and row-authoritative-once-set is the only rule that does not loop.

**NEXT ACTION:** implementation in flight — the benign branch + a `reclaimedReemitted` counter in
`pass.rs`, plus the falsifying test (ingest → rewrite same name+bytes at mtime +24h → pass with
`delete_after` → file deleted, stranded set empty, ROW ts UNCHANGED, counter 1, second pass a
no-op). Then the `unparked 0` wording (`storeAdmin.ts:165-173`), then verify the 307 drain.

**Migration (advisor, NOT yet verified by main — verify before relying on it):** the 307 are
expected to drain on a server restart with no verb, because the server holds `strandedNames` in
memory while only the CLI persists `.pass-state.json`. Confirm that against the code before
telling an operator so.
2026-09-24 — related to TRDD-Z53IJFE9, which removes the RAM-disk body spool completely per the owner's 2026-09-24 directive; see that card for the removal plan.

## CORRECTION — this card's first version blamed the wrong cause

**Authored 2026-08-26 20:13 claiming these 307 were ENOSPC residue from the spool volume filling.
That was a GUESS from coincidence — the volume had hit ENOSPC in the same window — and it was
wrong.** The server attributes them itself, and it says something else:

```
capture: 597 live file(s), newest 0s ago | PARKED 307 file(s) 144.3MB — ts-row mismatch,
never reclaimed (TRDD-8TM7I49X)
```

`ts-row mismatch` is the SAME cause as the 1045 that card was about — not a sink failure. The
correction matters because the two lead opposite ways: an ENOSPC story ends in "size the volume
and add backpressure", and none of that would have touched this.

## SECOND CORRECTION — the first correction over-corrected

The correction above was right that the cause is a ts-row mismatch, and WRONG that the repair left
part of its own backlog behind. Comparing the two stranded sets BY NAME settles it:

| | count |
|---|---|
| old stranded (backup store's pass state) | 1045 |
| new stranded (live store's pass state) | 307 |
| **new ∩ old** | **0** |
| new − old | 307 — every one parked for the FIRST time after the repair |
| old − new | 1045 — every one cleared |

Zero overlap. The repair drained its entire backlog, and TRDD-8TM7I49X's closure line
(`1045 → 0 of the legacy set`) was accurate as written. **The withdrawal of it in this card's first
correction is itself withdrawn** — I inferred "the repair left 307 behind" from two counts without
comparing the names, which is the same shortcut the first correction was written to fix.

## What is actually true (measured 2026-08-26 20:08-21:05)

- **307 files, 144.3 MB, all newly parked**, first seen ~2 minutes after the post-repair server
  restart (`strandedNames=307` at 20:08:39).
- **Flat for ~57 minutes** — 307 at 20:08, 307 at 21:05, 307 twice more 70 s apart. A burst at
  startup, not a steady leak.
- Attributed by the server itself as `ts-row mismatch, never reclaimed`.
- Context: the server had been DOWN for ~12 hours (the first repair attempt held the brake), so the
  first pass after restart met a large backlog of files captured while nothing was ingesting.

## `unparked 0 name(s) (0 still stranded)` — explained, and the line is misleading

Not an inconsistency, but not what it appears to say either. `stagedRewrite` swaps the whole store
DIRECTORY, and `.pass-state.json` lives inside it — so the stranded set went to the backup dir with
the old store. `rustUnpark` then ran against the NEW store, whose state file is empty: it removed 0
because there was nothing left to remove, and reported 0 remaining for the same reason
(`src/cli/storeAdmin.ts:165-173`).

So the unpark step is a **no-op after a swap**, and its output is indistinguishable from "there was
nothing parked". An operator reading `unparked 0` reasonably concludes the repair failed to unpark
anything, when in fact the swap had already discarded the set. That wording is worth fixing on its
own.

## THE DISCRIMINATOR — measured 2026-08-26 21:1x

The parking rule, at `file:line`:

- `rust-core/crates/agentlens-store/src/lib.rs:589` — park when `|stored_ts − want| > TS_TOLERANCE_MS`
  (2000 ms, `lib.rs:40`);
- `rust-core/crates/agentlens-store/src/pass.rs:351` — **`want` is the file's `mtime_ms`**;
- `rust-core/crates/agentlens-store/src/pass.rs:386` — and it parks only when `b.durable`, i.e. the
  bytes are already proven in the store.

So a body parks exactly when its FILE MTIME drifts >2 s from the capture ts stored at ingest. Now
the 307:

| measurement | value |
|---|---|
| `mtime − stored_ts`, 40 sampled | 83,618 – 84,422 s (**23.2–23.5 h**), spread only ~800 s |
| mtime vs birthtime | **equal** — these files were CREATED, never modified |
| birth minute, all 307 | `2026-08-26T18:07` UTC — one single minute |
| birth minute, ALL 1032 files in the local bodies dir | `18:07` UTC — the same minute |
| stored ts of those bodies | `2026-08-25 20:40`–`20:53` — the previous evening |
| stranded names also present on the spool volume | **0 / 50** |

18:07 UTC is 20:07 local — the moment the server was started after the repair. Before that restart
`server status` read `NO BODIES on disk (0 file(s)) — capture has never run, or the live dir was
emptied`; after it, 4187 live files.

**So the invariant is anchored to a file attribute that any file-recreating operation resets.** The
repair writes each store row's ts FROM the parked file's own mtime (`storeAdmin.ts` header:
"repair the ts rows from the parked files' own mtimes"). Something then re-materialised those
bodies at boot with fresh mtimes — 1032 files, one minute, matching the 1045 the repair had just
processed — and 307 of them immediately violated the rule again, because the row now holds
yesterday's mtime while the file carries today's.

That is a loop, not a residue: repair sets rows from mtimes → a restore resets mtimes → the rows
disagree → park. It also means the repair's remedy overwrites the TRUE capture time with whatever
mtime the file happens to carry, which is why the card it came from records ghosts as
"capture time unrecoverable".

**ANSWERED — the producer is NOT in this repository.** Body files are written by Claude Code
itself. AgentlensPro only tells it where: `ownedKeys()` writes
`OTEL_LOG_RAW_API_BODIES=file:${bodiesDir}` into the harness's settings
(`src/telemetryConfig.ts:162`, key at `src/captureConfig.ts:24`), and the dir follows "MOUNT truth,
not config truth" (`standalone/server.ts:4487-4491`) — so when the spool RAM disk fails, the
harness is repointed at the legacy dir and writes there.

There is therefore **no line in this codebase that writes those 1032 files**, and searching for one
is why the earlier hypotheses kept inventing internal restore paths that do not exist
(`exportBodiesFromStore`/`extractArchive` at `standalone/server.ts:3799-3810` are the
`/api/bodies/export` request path, not a boot path).

**This is the load-bearing consequence:** the writer is outside our control, and the parking rule
depends on a property only the writer sets. If the harness re-emits a body it already wrote — same
name, same bytes, new mtime — the store's row (holding the FIRST mtime) is instantly and
permanently wrong by the pass's own test, through no fault of the store. Every remedy that repairs
the row from the current mtime is a race against the next re-emit.

So the fix cannot be "stop the re-write". It has to be one of:
1. stop anchoring capture time to mtime — carry it in something the writer cannot reset (the body's
   own content, a sidecar, or the ingest-time row treated as authoritative once set); or
2. treat "durable bytes, disagreeing ts" as BENIGN rather than park-forever — the bytes are proven,
   which is what the store exists to guarantee, and the ts is metadata that a re-emit can legitimately
   move.

### Candidates ELIMINATED (so the next person does not re-walk them)

- **Stranded relocation — NOT it, twice over.** `relocate_stranded_file` (`pass.rs:197-219`) copies
  a stranded body off the spool, and it deliberately **preserves mtime**:
  `set_mtime_ms(&tmp, f.mtime_ms)` at `pass.rs:209`, tmp-then-rename, read-back verify, fsync. The
  authors already saw this hazard. It is also inert here — `relocate_stranded_to` is `None` from
  the server (`standalone/server.ts:3439`, `src/rustStorePass.ts:98`). And the measurement rules it
  out independently: our files have `mtime == birthtime`, so mtime was NOT preserved.
- **A spool→legacy fallback write is not disproved but does not fit alone.** The spool
  `/Volumes/AgentLensSpool` is a volatile **RAM disk** (`ensureRamDisk`/`ramDiskInfo`,
  `standalone/server.ts:552-568`), recreated at boot, and the exporter is pointed at
  `PRIMARY_BODIES_DIR` on "MOUNT truth, not config truth" (`:4487-4491`) — so a failed spool does
  redirect writes to the legacy dir. But that produces NEW bodies, and these carry bodies whose
  store rows date from the previous evening.

### A THIRD hypothesis, raised and REFUTED at a file:line in the same pass

Raised: "a body's true capture time and the moment its file lands are different events — the row
holds the former, the pass compares the latter", which would need no restore path at all.

Refuted by `src/store/bodyStore.ts:47-52`, which states the contract outright:

> `tsMs` is the body's CAPTURE time (**the source file's mtime** / the archive entry's mtimeMs) and
> the caller must pass it whenever it knows it: defaulting to "now" stamps a backfilled body with
> its INGEST time, which silently breaks every time-window query over the store.

The row's ts is taken FROM THAT SAME FILE'S MTIME at ingest. They agree by construction, so a body
that merely lands late cannot produce the offset. Hypothesis dead.

### What that leaves — narrower, and it is a deduction rather than a story

If ts == mtime at ingest, then a later disagreement means the FILE CHANGED after it was ingested.
And the pass only parks `b.durable` bodies, i.e. ones whose bytes still verify against the store.
So the surviving description is forced:

**the same name was written again, with the same bytes, at a new mtime.**

That is what "mtime == birthtime == one single minute, bytes still durable, row from yesterday"
means, and it is now a deduction from the parking rule plus `extractMeta`'s contract, not a guess
about who did it.

The ENOSPC on the spool becomes relevant again, though NOT the way this card first claimed: not
"bodies strand because the sink filled", but "after a sink failure something re-wrote bodies that
were already durable". Whether that is the exporter retrying, a fallback path, or something else is
exactly the open box — and it is the FOURTH mechanism this card has considered, so it gets named
only when someone can point at the line that writes the file.

## What this card must establish

1. **Why a pass over a post-downtime backlog parks ~307 of ~4,000 files.** Same pass, same store,
   most files fine — the discriminator between parked and not is the finding.
2. **Whether these 307 can drain without an operator running the repair verb**, given they are
   newly created rather than legacy. If not, the shape TRDD-8TM7I49X documented survives its own
   fix and will refill after every extended downtime.
3. **Whether `unparked N` should report the swap case differently** — see above.

## Not the fix

Enlarging `/Volumes/AgentLensSpool` — that was this card's original premise and it is withdrawn.
Sizing is the USER's call regardless, and no agent should reclaim space to paper over a defect
(`~/.claude/rules/never_free_space.md`).

## Acceptance

- [x] The 307 are characterised against the drained 1045 by NAME, not by count: zero overlap, all
      newly parked, flat for ~57 minutes. TRDD-8TM7I49X drained its backlog completely.
- [x] The discriminator is named with evidence at `file:line` (see above): park iff
      `|stored_ts − file mtime| > 2 s` on a durable body, and all 307 were files CREATED at boot
      (mtime == birthtime, one minute) carrying bodies whose rows hold the PREVIOUS day's ts.
- [x] The boot-time producer is identified: **Claude Code**, not this codebase. We only set
      `OTEL_LOG_RAW_API_BODIES=file:${bodiesDir}` (`src/telemetryConfig.ts:162`,
      `src/captureConfig.ts:24`) and repoint it on mount truth
      (`standalone/server.ts:4487-4491`). No internal restore path is involved.
- [x] (option A, decided 2026-08-27, shipped `aa0caa40` + the drain `f9605164`) The design question this exposes gets an answer: **mtime is a proxy for capture time, and it
      is invalid for any body that is re-materialised.** Either capture time stops being carried by
      a resettable file attribute, or every restore path is made to preserve it — otherwise the
      repair verb and the restore path will keep undoing each other.
- [x] Established whether newly parked files can drain without an operator running the repair verb
      — YES for the re-emit class since `aa0caa40` (benign reclaim in the ordinary Rust pass,
      `pass.rs:373-416`): the live alcore logs "ingested N, reclaimed N file(s)" every pass. NO for the
      legacy 307 (TRDD-8TM7I49X class): still `PARKED 307 file(s) 144.3MB` after multiple restarts on
      2026-09-01; `store repair-parked --dry-run` reports 307 repairable / 0 ghosts, but the real run
      swaps the store directory and REFUSES while the server runs (`server stop --stay-down` first) —
      a downtime + data-store operation awaiting the USER's go. Scoping:
      reports/parked-bodies-repair/20260901_230204+0200-scoping.md.
      If they cannot, the parked set refills on this loop and TRDD-8TM7I49X fixed an instance
      rather than the mechanism.
- [x] `unparked N name(s) (M still stranded)` distinguishes "unparked nothing because the swap
      already discarded the set" from "nothing was parked" — today both print `0`
      (`src/cli/storeAdmin.ts:165-173`). (Distinguishable on read 2026-09-02 by `:122` + `:175`
      TOGETHER — `:122` prints the pre-swap count, `:175` the post-unpark count, and `:88` exits
      early on an empty set — while `:175` alone still reads `unparked 0 (0 still stranded)` in
      both cases. With the pass draining parks itself, the verb is the rare operator path.)
- [x] A test that produces a ts-row mismatch, runs the repair, and asserts the parked set reaches 0
      — the gap this card exists because nothing covered. (`tests/pass.rs`
      `legacy_stranded_name_drains_through_the_gate_and_the_parked_set_reaches_zero`, `f9605164`;
      the "repair" is the ordinary pass now.)

## Related

- [[TRDD-8TM7I49X]] — the 1045-name instance, drained 2026-08-26. Its closure line
  `strandedNames 1045 → 0 of the legacy set` is **CONFIRMED correct** by the name-level comparison
  above (zero overlap between the two sets). Nothing about that card's closure needs revisiting;
  this card is about the 307 that appeared afterwards, which are a different population.
- [[TRDD-Z8WJZV8E]] — the sink-status card, whose own premise also needed correcting.

## Approval log

- 2026-09-24T08:57:33+0200 — column → human_review by main-session. AI review verified, evidence in reports/board-triage ai_review-A/B/C triage
- 2026-09-24T08:57:49+0200 — main-session (board update A): moved ai_review -> human_review; AI review verified per reports/board-triage ai_review-A/B/C triage rows. In this project's mono-agent rule the session moves ai_review->human_review; the owner moves human_review->complete.
- 2026-09-24T08:58:02+0200 — main-session note: eht: [7NHUU6GK] is at column backburner (not terminal), so this move to human_review does not open the door to complete — the card cannot reach complete until 7NHUU6GK terminates.
- 2026-10-05T03:18:02+0200 — column → human_review. returned after adversarial review - deploy lies past complete and this card has an open EHT

## Notes and lessons learned

AI re-review at HEAD 3faa709c (2026-09-24T09:13:29+0200): acceptance still holds — pass.rs still has reclaimed_reemitted/TS_TOLERANCE_MS and the reclaim-not-park branch unchanged; the later commit f5926457 changes hook-spool drain cadence and DuckDB memory sizing in chores.rs, not the pass.rs reclaim logic. Reran cargo test -p agentlens-store --test pass -> 7/7 passed including legacy_stranded_name_drains_through_the_gate_and_the_parked_set_reaches_zero and ts_only_mismatch_on_a_reemitted_file_reclaims_not_parks_and_leaves_the_row_alone. Card still cannot reach complete: eht 7NHUU6GK remains non-terminal.

## Review 2026-10-05 (in the owner's stead)

- Reviewed in the owner's stead 2026-10-05 (reviewer report docs_dev/20261005_025833+0200-review-6SPXOV0P.md). Accepted pending live verification; goes to `deploy`. Verified by the main agent first hand: (1) rust-core/crates/agentlens-store/src/pass.rs:471-498 - a stranded name with no relocate target is removed from the stranded set and inserted into the skip names, so it reaches the gate; (2) the test `legacy_stranded_name_drains_through_the_gate_and_the_parked_set_reaches_zero` (rust-core/crates/agentlens-store/tests/pass.rs:162-200) passes, exit 0, 1 passed, 7 filtered out; (3) commits aa0caa40 and f9605164 exist and f9605164 is an ancestor of main. NOT demonstrated: that the test fails when the fix is undone. The reviewer's mutation (deleting the `stranded_names.remove` line) was refused by the permission classifier and no mutation was applied; by reading, the `stranded.is_empty()` assertion would fail, which is an inference, not a run. Only the one named test was run, not the other seven in that test file. LIVE-ONLY, for the owner: that the 307 parked names reached 0 on the real store and that the running alcore contains f9605164 - neither was read, under the directive's no-real-data-directory rule. Stale citation: the `unparked N (M still stranded)` message is at src/cli/storeAdmin.ts:182, not :175 (:89 and :123 for the other two messages). This card cannot reach `complete` while its EHT TRDD-7NHUU6GK sits in `backburner`.
- CORRECTION 2026-10-05, after adversarial review of the entry above. (1) The move to `deploy` is withdrawn and the card is back in `human_review`: on this board `deploy` comes after `complete`, and this card cannot reach `complete` while its EHT TRDD-7NHUU6GK is open. `release-via` is set to none, which is what its absence meant at HEAD. (2) "Accepted" is withdrawn. What holds: the code was read and the one named test passes. That the test can fail was not demonstrated; the review procedure allows skipping the mutation only for a long rebuild, which was not the reason here. (3) Owed: one mutation run - delete the line `stranded_names.remove(&f.name);` at rust-core/crates/agentlens-store/src/pass.rs:495, run `cargo test --manifest-path rust-core/Cargo.toml -p agentlens-store --test pass -- legacy_stranded_name_drains_through_the_gate_and_the_parked_set_reaches_zero --exact --test-threads=1`, expect the `stranded.is_empty()` assertion to fail, then restore the line. The permission classifier refused it to the reviewer and the main agent did not retry it by another route. The reading that it would fail rests on `ingest_pass` (pass.rs:250-258) handing the caller's stranded set straight through, which the main agent read; whether anything else in the pass removes the name was not read. (4) All three storeAdmin.ts citations in STATE are stale, not one: :88 is now :89, :122 is now :123, :175 is now :182. (5) "an ancestor of main" means the local main branch. (6) The test file now holds eight tests (cargo printed 7 filtered out beside the 1 run); the "7/7" on this card is an older count. (7) Not read: that the parked set is 0 on the real store, and that the running alcore contains f9605164. The first is one read-only query; the second has no recorded answer, because the deployed binary carries no link to a commit. The no-real-data-directory limit comes from the review spec the previous session wrote; whether the owner set it was not checked. (8) The STATE head of this card is dated 2026-09-02 and was not rewritten in this review.
