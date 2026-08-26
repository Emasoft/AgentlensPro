---
trdd-id: 6SPXOV0P
title: 307 files remain parked with a ts-row mismatch after the TRDD-8TM7I49X repair
column: todo
created: 2026-08-26T20:13:05+0200
updated: 2026-08-26T21:05:00+0200
current-owner: main
task-type: bugfix
severity: MEDIUM
priority: 3
labels: [bodies, ingest, silent-failure, capacity]
relevant-rules: []
---

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
- [ ] The design question this exposes gets an answer: **mtime is a proxy for capture time, and it
      is invalid for any body that is re-materialised.** Either capture time stops being carried by
      a resettable file attribute, or every restore path is made to preserve it — otherwise the
      repair verb and the restore path will keep undoing each other.
- [ ] Established whether newly parked files can drain without an operator running the repair verb.
      If they cannot, the parked set refills on this loop and TRDD-8TM7I49X fixed an instance
      rather than the mechanism.
- [ ] `unparked N name(s) (M still stranded)` distinguishes "unparked nothing because the swap
      already discarded the set" from "nothing was parked" — today both print `0`
      (`src/cli/storeAdmin.ts:165-173`).
- [ ] A test that produces a ts-row mismatch, runs the repair, and asserts the parked set reaches 0
      — the gap this card exists because nothing covered.

## Related

- [[TRDD-8TM7I49X]] — the 1045-name instance, drained 2026-08-26. Its closure line
  `strandedNames 1045 → 0 of the legacy set` is **CONFIRMED correct** by the name-level comparison
  above (zero overlap between the two sets). Nothing about that card's closure needs revisiting;
  this card is about the 307 that appeared afterwards, which are a different population.
- [[TRDD-Z8WJZV8E]] — the sink-status card, whose own premise also needed correcting.
