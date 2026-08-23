---
trdd-id: ZFX0MPYZ
title: Standalone server sustains 27 percent of a core and 1.4 GB RSS — check_cache_expiry probe walks
column: complete
created: 2026-08-20T18:31:34+0200
updated: 2026-08-23T16:29:00+0200
current-owner: unassigned
task-type: bugfix
priority: high
severity: high
task-scope: standalone-server
---

# Standalone server sustains ~27% of a core and 1.4 GB RSS — `check_cache_expiry` probe walks

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-23 16:29

This card is ~700 lines of append-only investigation across four sessions and two compactions.
**Read this block, not the body, for what is currently true.** The body is a record of how the
answers were reached — including several that were WRONG and were corrected in place.

**⚠ THE STANDING LESSON OF 2026-08-23, EARNED OVER FIVE COMMITS EACH CORRECTING THE LAST.** Almost
every defect in that chain was a VERDICT WORD attached to a number that did not carry it — "steady
state, not a leak" (no sensitivity), "reads high in every bucket" (untested, false), "not biased"
(an unsupported null replacing an unsupported positive), "agree inside the uncertainty" (no
criterion set before looking), "every number from one frozen snapshot" (a method claim, false), "the
lock guard refusing a second claimant, working as designed" (a mechanism fitted to one row, no log
checked). **So: publish the number with its derivation and its n, and stop attaching the adjective.**

Two riders, both learned the hard way in the same chain:
- **The lesson does not protect the commit that adds it.** The commit introducing this paragraph
  ALSO shipped the lock-guard story and a 61.24 s period derived by mixing one snapshot's row count
  with another's timestamp — the mixing error a previous commit had already written a lesson
  against. Writing the rule down is not applying it.
- **"I removed adjectives this round" is itself an unfalsifiable adjective.** Every withdrawal above
  is therefore written as an explicit WITHDRAWN line rather than by quietly editing the old text
  away, so a reader can audit them. **No COUNT is quoted**: I offered "16 withdrawal markers" from a
  `grep -co`, which counts matching lines (and `grep` here is ugrep, whose `-c` differs again) and
  sweeps in every meta-sentence that merely mentions withdrawing. A proxy handed over as "the
  checkable form" is the same defect one level up.
- **Correcting a verdict with the opposite verdict is not a correction.** "Held steady" → "the rate
  DECLINED" swapped one two-point story for another; both are withdrawn, and what remains is the
  two period-means with no trend claimed.

And when the question is what a tool MEASURES, **read the tool, then test it on your own data.**
The `ps` line in the 20-line sampler settled in one call what two rounds of argument-from-column-name
could not — but the follow-up claim about what `%cpu` *means* was still quoted from memory, and only
the lifetime-average test on this file actually established it.

**WHERE IT STANDS.** Acceptance boxes **1 ✓ 2 ✓ 4 ✓ 5 ✓**, box **3 answered on a PARTIAL series
(69.5%) and left open until the full one lands ~16:13**. `column: todo` — one queued read, waiting
on a clock, nobody working it right now. **Box 3 is the ONLY open box, and when it ticks this card
is done:** the unfixed runaway is `TRDD-YST9ZJ90`'s card, not this one's remaining work.
The MECHANISM is settled: the trigger is an HTTP REQUEST (`check_cache_expiry`, 36.6% of
main-thread busy), not a timer; the caller is OUTSIDE this repo (ai-maestro-janitor detectors,
147 calls/hour over the FIRST 5h14m — see the rate warning below); the amplifier was a pre-walk
cache stamp and is FIXED.

**⚠ 147 CALLS/HOUR IS NOT A RATE LAW, and both this card and TRDD-YST9ZJ90 size their argument on
it.** Re-measured 2026-08-23 06:55 on the same log with the same marker: **1478 calls over
7h49m37s** of uptime. That is 189/hour cumulative, and the INCREMENTAL rate over the 2h35m since
the first measurement is **273 calls/hour — 1.86× the 147**. Mean duration also drifted, 947 → 992 ms.
The cause is UNATTRIBUTED: open-session count was not recorded at either point, so this is NOT a
test of the session-scaling hypothesis (that still needs the rate at two known session counts).
What it does establish is that a single window's average must not be quoted as a steady rate —
the sizing in YST9ZJ90 is a LOWER BOUND.
**Its SCOPE is narrower than "the workload", and box 1 is met as WORDED rather than as a total:**
the profile covers ONE process's main thread, while a large and CHANGING share of logged call-cost
belongs to earlier processes never profiled — **51.8% as of 06:58**, and falling as the live
process accumulates (entry 8 has the timestamped triple and the method; do not quote the older
68.4% or the derived 769 that appeared here). The rate figure is unaffected by that split.

**COLUMN — `dev` → `blocked` → `todo`, and the middle step was WRONG TWICE OVER.** `dev` was false
(it asserted active work across an eight-hour gap in which nothing touched the card), so at 12:38 I
moved it to `blocked` with `blocked-by: [YST9ZJ90]`. Both parts of that were defects:
1. **`blocked-by: [YST9ZJ90]` was not true of THIS card.** Its only open box is a measurement that
   needs nobody's permission. I imported the *project's* blocker onto a card whose own remaining
   work is unblocked — the honest state is `todo`. **Flagged as a UNILATERAL scope narrowing:** it
   reads box 3's wording (characterise RSS as steady-state or leak) as the card's whole remainder,
   on a card whose TITLE is about an unfixed runaway. Defensible from the acceptance criteria — all
   five are characterisation plus the amplifier fix — but it is my reading, and if the user intends
   this card to stay open until the runaway itself is fixed, it belongs back on `blocked` (and then
   the drift-coverage loss in 2 must be handled some other way).
2. **`blocked` is NOT in `trdd-drift`'s `ACTIVE_COLUMNS`** (`{dev, testing, backburner, todo,
   dispatch, ai_review, human_review}` — `scripts/lib/trdd_common.py:253`; the detector `continue`s
   on anything outside it at `detectors/trdd-drift.py:203`). So the move silently switched OFF the
   one automated control this very block names as covering the card. Verified by reading the set,
   not assumed. A card can be honestly re-columned into invisibility; **check the detector's column
   set before any re-column, because the drift nudge is what catches the next stall.**
`todo` is both true and drift-covered. (A "trip-wire" note lived here for 10 minutes
and was DELETED: it was prose read only
on resume, while the failure it guarded is *nobody resuming* — it could not fire in the one case it
existed for. Worse, it duplicated a real automated control: `trdd-drift` covers this card by
default, which is exactly what `review-after:` exists to opt OUT of. A decorative control stacked
on a working one makes the working one look optional.)

**⚠ THE SAMPLE COUNT WAS WRONG; THE COMPLETION TIME WAS RIGHT, AND MY "CORRECTION" TO IT BROKE IT.**
Reading the sampler (`…/df3b097d-…/scratchpad/rss-sampler.sh`, pid 82388, ppid 1, alive) fixes one
of these and settles the other:
- **TRUE:** it loops `seq 1 720`, so the finished file is **720 data rows + 1 header = 721 ROWS**,
  not "721 samples". Verify the row count before treating the series as complete.
- **TRUE:** **no rows have been dropped** — all 506 intervals measure 60–61 s — so loop iterations
  and written rows have stayed 1:1. (This matters because the loop is bounded by ITERATIONS: if the
  grep ever misses, the file can never reach 721 rows and a row-count precondition would hang.)
- **WITHDRAWN — "the period is 61.24 s, so completion is ~16:28, +15 min later than the ~16:13 this
  block said".** The true cadence is **60.06 s** and the last row is due **~16:14:12**, so the
  original ~16:13 was right to within a minute. I produced 61.24 by **dividing the FROZEN file's
  row count (508) by the LIVE file's latest timestamp (12:51:02)** — the frozen file ends at
  12:41:01. That is snapshot-mixing, and it shipped **in the very commit that added the lesson
  against it**. *The real evidence is `min=60, max=61` over all 506 intervals* — the two
  "self-consistent snapshots" (60.06 s at 508 rows, 60.059 s at 526 rows) share the same anchor row
  and 96% of the same data, so they are ONE measurement reported twice, not corroboration.
- **WITHDRAWN — "the 16:19 job would have read an incomplete series".** With the true ETA of
  16:14:12 it would have been fine. The job now sits at 16:26 for margin, with a liveness check so
  a DEAD sampler yields "final-but-short" rather than "incomplete" forever.

**NEXT ACTION — NONE. The card is CLOSED (`column: complete`, 2026-08-23 16:29).** The 12 h series
finished at 16:14:14 with all 721 rows, the floor read ran on the complete file, and **box 3 —
the last open box — is ticked**. Its full result, its sensitivity, and the scope limit that keeps it
from being over-read are in the box-3 entry below; the derivation is
`reports/cpu-runaway/20260823_162921+0200-box3-rss-floor-12h-full.md`.

**The unfixed runaway is NOT this card's remaining work — it is `TRDD-YST9ZJ90`** (in
`design/proposals/`, `column: proposal`, tier 2, awaiting USER). Do not reopen this card to do it.

**⚠⚠ SCOPE LIMIT ON EVERYTHING BELOW — TWO EARLIER SERVER PROCESSES DIED OF JS HEAP EXHAUSTION, ONE
OF THEM IN UNDER 16 MINUTES.** Found 2026-08-23 14:45 in the ~22k log lines a `head -5` census had
left unexamined — found by fixing a methodology defect, not by looking for it.
`~/.agentlens/server.log` carries **2 × `FATAL ERROR: Ineffective mark-compacts near heap limit —
Allocation failed - JavaScript heap out of memory`**, one per pid — **verified by exact adjacency,
not by "the nearest preceding pid"**: lines 54161–54162 are 73785's two Mark-Compact traces and the
FATAL is 54164; lines 270543–270544 are 20885's Scavenge + Incremental Mark-Compact and the FATAL is
270545. Two or three lines apart in both cases, so the attribution is not an inference across
distance. (This also corrected my own extraction: I had reported "traces=1" per pid, because the
regex matched only the first form and missed `Mark-Compact (reduce)` / `Incremental Mark-Compact`.
There are **two** trace lines per pid.) **Neither pid is 21567 or 19113.**

**Whose processes were they? "The server's" is PLAUSIBLE, NOT VERIFIED — say "processes writing to
the server's log".** That file is a ~6-week append across many restarts and carries **four distinct
pids** (20885, 25527, 73785, 7186). No line names a non-server entrypoint — 0 hits for
`standalone/cli.js` or an `agentlenspro <tool>` invocation — which is consistent with server-only
but does not establish it, since a child or a process inheriting the redirect would not have to
name itself.

| pid | uptime at its trace | V8 **heap** | implied mean growth |
|---|---|---|---|
| 73785 | **9.25 h** | 6135 MB (6191 committed) | ~0.66 GB/h |
| 20885 | **0.26 h — 15.6 min** | 6080 MB (6108 committed) | **~23 GB/h** |

**I wrote "undatable" and that was too fast.** Wall-clock, yes — but the V8 line's `NNNN ms:` is a
PROCESS-UPTIME counter, and it answers the question that matters: how long each process survived.
One died after 9¼ hours; **the other reached a ~6 GB heap in under sixteen minutes.**

**This does not contradict box 3 — it shows box 3's instrument is aimed three orders of magnitude
away from the failure that actually kills this server.** The floor test resolves a leak faster than
~0.03 GB/h; pid 20885's average was **~23 GB/h, roughly 780× that**. So "no leak signature" is not
merely *narrow* — it is measured in a regime unrelated to the observed failure mode. Box 3 answers
*"did pid 21567 leak slowly during this window"*, and nothing more.
**Units, stated because the scope sentence crosses them:** 6135 MB is V8 **HEAP**; box 3's
1.10–1.26 G is process **RSS** (RSS ⊇ heap, so those processes' RSS was ≥ ~6 GB — ~5× the current
process's entire RSS). Do not read the two figures as the same quantity.
**Also in the trace: `average mu = 0.080`** — 8% mutator utilisation, i.e. GC consuming ~92% of the
time. That is a heap-death spiral, and it is the shape a *runaway* takes.
**Unknown and not to be guessed:** when these happened, whether they predate `581524c`, and what
those processes were doing. Handed to **`TRDD-YST9ZJ90`** as evidence the user should weigh — stated
as facts, not as a recommendation to approve.

**BOX 3, PARTIAL ANSWER (501/721 samples, 04:14→12:34, read 12:36): NO LEAK SIGNATURE DOWN TO
~0.03 GB/h — FOR pid 21567's 8.4 h ONLY; see the scope limit above.** Stated with its sensitivity, because a bare "steady state, not a leak" is the exact
move this box has already withdrawn four statistics for. Per-hour RSS floor for pid 21567 over
8h20m of continuous uptime: 1.167 / 1.188 / 1.225 / 1.173 / 1.151 / 1.143 / 1.133 / 1.259 /
1.099 GB. Regressed on the hour:

| buckets | slope | interval | sensitivity floor |
|---|---|---|---|
| all 9 (two partial) | **−0.0045 GB/h** | [−0.020, +0.011] | 0.015 GB/h |
| 7 complete only (n≥59) | **+0.0001 GB/h** | [−0.024, +0.025] | **0.025 GB/h** |

**Quote the 7-bucket row** — dropping the partial 04:00 (n=46) and 12:00 (n=41) buckets removes the
unequal-n bias in a MINIMUM statistic (fewer draws ⇒ the min reads high), and it is the weaker,
therefore honest, claim. **Read these as order-of-magnitude sensitivity floors, one significant
figure — NOT calibrated 95% intervals**; this box already ruled that a block-minimum is an
extreme-value quantity and not t-distributed however many buckets there are, and an hour-minimum is
the same statistic. So: *this window resolves a leak faster than ~0.03 GB/h; anything slower stays
invisible.* Against the 65-minute window's 0.3–0.4 that is **roughly an order of magnitude** — the
measured ratio is 14×, but it divides two MDEs whose σ̂ come from 4 and 5 df and are each uncertain
by ~2×, so it is good to about 4× and must not be quoted as "12×" or "14×". **Independent
corroboration, which the card had already derived and I failed to use:** SE ∝ σ√Δ/T^1.5 over a
7.69× longer window predicts **0.014–0.019 GB/h**, against **0.025 measured** — a factor of
**1.3–1.8 apart**. *Stated as the ratio, with no verdict word attached:* I first wrote that these
"agree inside the σ̂ uncertainty", having set no agreement criterion before looking — which is
fitting the word to the gap. Both are the same order of magnitude; whether that counts as agreement
is the reader's call, not a conclusion this data licenses.
Peaks likewise flat at 1.45–1.63 G. The box stays unticked because the series is 69.5% complete.
Report: `reports/cpu-runaway/20260823_123633+0200-box3-rss-floor-8h20m-partial.md`.

**CPU, from `cpu_time` DELTAS — and the columns are VERIFIED FROM THE SAMPLER SOURCE plus a test on
the data, not from their header names and not from a man page quoted from memory.** The sampler
runs `ps -eo pid,etime,%cpu,time,rss,command` (`/bin/ps`; `ps --version` errors with a BSD-style
usage string, which shows it is **not GNU** — that is not the same as proving it is BSD, and it does
not matter, because the data test below settles the semantics without needing the provenance).
Col 4 is `%cpu`, col 5 is `time` (cumulative CPU).
**Col 4 is NOT a lifetime average — settled on this file rather than on the man page**, since a
lifetime average would make cols 4 and 5 nearly the same statistic and void the whole distinction:

| row | col 4 | 100×cputime/elapsed | diff |
|---|---|---|---|
| 1 | 13.1 | 27.44 | −14.3 |
| 150 | 6.3 | 27.05 | −20.8 |
| 300 | 1.5 | 25.99 | −24.5 |
| 450 | 79.3 | 25.84 | +53.5 |

The lifetime average is nearly flat across 8.4 h while col 4 swings 1.5 → 79.3 between adjacent
minutes. So col 4 is a short-window/decaying measure and col 5 is cumulative: **same quantity,
different estimators** — asserted from a column NAME two turns ago, adopted from a reviewer one turn
ago, and only now actually measured.
**From that same test, two results — one solid, one I read backwards.**

***WITHDRAWN — "the 25.1% closes against an independent method."** The two methods are one method.*
Σdeltas **telescopes** to (cpu_last − cpu_first), which IS the endpoint numerator — measured:
`sum(deltas)=7588.22`, `(last−first)=7616.86`, gap **28.64 s** = exactly the two intervals dropped
at the pid change. So both figures divide one numerator; the only differences are −28.6 s on top
(−0.376%) and 30240 vs 30388 s underneath (−0.487%). *("Same sign, so they cancel" was loose twice
over and is corrected: the two quantities do both shrink, but shrinking the DENOMINATOR raises the
ratio, so their **effects oppose** — and they do not cancel, they leave a residual.)* Net
**+0.112% on the ratio = +0.0280 pt**, matching the observed difference of **+0.0280 pt** to four
decimals — an algebraic **identity** with that difference, not an independent prediction of it.
**That is the finding, not a caveat on it:** the entire gap between the two
figures is accounted for by two known bookkeeping artifacts, leaving exactly nothing for
"agreement between methods" to mean. It would hold just as well against a fabricated col 5,
provided it were monotone — so it carries **no power to corroborate the measurement**, and I
published it as corroboration. *(Not literally "zero diagnostic power", which overstated it in my
own favour the other way: a corrupted FIRST or LAST endpoint moves the endpoint numerator but only
one delta, so the comparison does detect endpoint corruption and non-monotonicity. It just cannot
say anything about whether col 5 measures CPU.)*
**The genuinely independent estimator is col 4** — a different measurement, not a rearrangement of
the same one — and it does NOT closely agree: **+2.75 pt** (that is the bias test above). That
disagreement is the honest comparison, and it is why col 5 is preferred on the grounds of being a
monotone counter rather than on the grounds of agreeing with anything.

*Read backwards — **WITHDRAWN**: "~26% has been sustained across its whole ~13 h life".* The
lifetime average is a CUMULATIVE figure, so splitting it is the whole point:

| period | duration | mean CPU |
|---|---|---|
| **before my window — NEVER SAMPLED** | 5.15 h | **27.44%** |
| the measured window | 8.44 h | **25.07%** |
| whole life (row 1 → 12:41) | 13.59 h | 25.96% |

**Both of my readings of this table were verdicts on two points with no variance.** First "~26% held
across its whole life" (the reassuring one); then, correcting it, **"the rate DECLINED, real and
unexplained"** — which is **also WITHDRAWN**. Two exact period-means cannot distinguish a declining
rate from a different workload in the unsampled period, and a candidate confound is visible in the
server log: 289 `bodies → store: ingested N … 0.50GB read` spool-backfill lines.
**They cannot be dated — but it took THREE attempts to state the evidence correctly, each one the
same defect one layer down.** (i) "The log carries no timestamps at all" — FALSE, and asserted from
`head -3` of a 394,171-line file. (ii) "All 37 date-bearing lines are segment filenames" — ALSO
FALSE, and asserted from `head -12` of a `cut -c1-130` view: twelve of thirty-seven, truncated.
Three of them carry **full ISO datetimes with times** (usage-window boundaries in account
auto-calibration lines), which are not filenames at all.

(iii) "33 are segment names, the rest usage-window datetimes" — **WRONG NUMBER, and wrong the same
way again.** I read a `grep -oE … | uniq -c` listing, which counts **MATCHES, not lines**: the 37
lines yield **78 matches**, because `compressed sealed segment X.ndjson → X.ndjson.gz` carries two
dates and is listed twice. Counting the LINES:

| category | lines |
|---|---|
| `span store: compressed sealed segment …` | **32** |
| `retention: deleted segment …` | **2** |
| `window capacity auto-calibrated …` | **3** |
| | **37 ✓** |

So it is 34 segment names, not 33, and my "33" had also silently dropped the retention pair.
**Every one is still a date describing DATA — which segment, which window — never the time the line
was written**, which is the only part of this that ever mattered.

**The evidence for "no per-line timestamps" is the line FORMAT, not a regex's silence.** Full prefix
census (one read; the log is live, so totals drift by a few lines between reads): **351,534 lines
begin with `[AgentLens] `**, **42,380** are stack-trace continuations (`    at …`), and the tail is
~166 blank, 52 `(node:…)`, 15 `Debugger listening…`, 10 `[GATE-PROBE]`, 4 `[LogReader]`, plus a V8
crash dump. **No category carries a timestamp field** — the V8 lines' `[pid:0xaddr] NNNN ms:` is a
process-relative counter, not wall clock. (Earlier I gave `348,785 of 394,171` from `head -5` of
that census, leaving ~22k lines unexamined — head-for-the-file inside the claim replacing
head-for-the-file. Now enumerated in full.) A scan for three formats the first regex would have
missed — epoch millis, `Aug 23 08:12`, bracketed `[08:12` — returns **0**.
⇒ **The backfill cannot be dated and stays a *candidate* confound.** (The earlier "1 backfill line
within 50 lines of a timestamp" is **non-probative** and withdrawn: line proximity in an
untimestamped log says nothing about datability.)
**What is measured:** the unsampled first 5.15 h averaged 27.44%, the measured 8.44 h window
25.07%, whole life 25.96%. **No trend is claimed.**
On the title: it says *"27 percent of a core"*, from the original 2026-08-20 observation. The
measured figures here are **25.07% (window)** and **25.96% (life)** — so read the title as ~25–27%
rather than as 27; not worth a rename, but do not quote 27 as a measurement.
True CPU per hour (Δcol 5, pid 21567, `p` reset on pid change): 25.8 / 26.7 / 25.7 / 23.8 / 22.0 /
21.1 / 23.8 / 30.9 / 26.6 **% of one core**; **25.1% overall** across 504 intervals — a tight 21–31
band, stable while RSS is flat.

**THE BIAS QUESTION, SETTLED PROPERLY — and BOTH of my previous answers were unsupported.** I first
wrote the gauge "reads high in every bucket" (refuted: 6 of 9). I then wrote it is "noisy in both
directions, **not biased**" — which replaced an unsupported positive claim with an unsupported
NULL, in the very entry whose subject was that failure. Tested on all **504 paired observations**
rather than 9 hourly means:

> `n=504  mean(gauge−true) = +2.75 pt  SD=37.08  SE=1.65  t=+1.66  95% CI [−0.49, +5.98]`

**|t| < 2, so a high bias is NOT established — and neither is its absence.** Autocorrelation was
raised as an objection and MEASURED rather than argued: lag-1 ρ = **+0.032**, AR(1) inflation
**1.03×**, so SE 1.65 → 1.71 and t 1.66 → **1.61**. Conclusion unchanged. (A ~1-minute decaying
average sampled at 60 s is very nearly independent, which is why the correlation is negligible —
the objection assumed it would be large enough to invert the ranking below; it is not.)
The correct wording is **"no bias detectable to ±3.4 pt"** (MDE = 1.965 × 1.71); a real +2.75 pt
lean (≈10% of a 25% base) is entirely consistent with this data. Never write "not biased" for a
test that failed to reject.
**How much the finer test bought — and my own answer to this was a proxy read too.** I compared the
two SEs (1.68 hourly vs 1.71 AR-inflated paired) and concluded "essentially nothing". **SE is not
power**: the critical value differs too, 2.306 at df 8 against 1.965 at df 503. On MDE —

| test | t_crit | t_{.80,df} | SE | CI half-width (t·SE) | MDE @80% ((t+t_{.80})·SE) |
|---|---|---|---|---|---|
| 9 hourly means | 2.306 | 0.889 | 1.68 | 3.87 pt | 5.37 pt |
| 504 pairs (AR-inflated) | 1.965 | 0.8423 | 1.71 | 3.36 pt | 4.80 pt |

**≈13% better on the interval, ≈11% on power — not 98% (as first claimed against me) and not
"essentially nothing" (as I claimed back).** Two wrong answers, both from comparing one component
of a quantity instead of the quantity. (The power column uses **t_{1−β,df}**, not z: at df 8 that is
0.889 rather than 0.842, which is why an earlier "≈9%" here read low.)
**⚠ LABEL CORRECTION THAT APPLIES TO THIS WHOLE CARD, NOT JUST THIS ENTRY.** What this card has
called "MDE" throughout — including the original `MDE ≈ 0.39 GB/h` in the box-3 entry below — is
**t_crit × SE, the CI HALF-WIDTH**: the effect the interval just excludes. The minimum detectable
effect at 80% power is **(t_crit + 0.842) × SE**, about **37% larger**. The numbers are right for
what they are; the name was wrong, consistently, from the start. Read every "MDE" on this card as a
CI half-width, and inflate by ~1.37 if you want the 80%-power figure — so the floor sensitivity is
**~0.025 GB/h as an interval half-width, ~0.035 GB/h as a true MDE**.
Also withdrawn: *"exceeding 100 proves it is not the same quantity"* — a `cpu_time` delta is
thread-summed core-percent too and exceeds 100 above one core. **Prefer col 5 because it is a
monotone counter, not because col 4 leans one way.**
**The rule that does survive: column 5 is a monotone counter, so prefer its deltas; column 4 is a
sampled gauge whose hourly mean depends on when the samples landed.** And the deltas are exact only
if `p` is RESET on a pid change — carrying it across row 239 silently divided a 120 s interval by
60 and understated hour 08 by 0.4 pt (22.4 → 22.0; the giveaway was n=59 where 58 was right).

**RETRACTED by this read: the 65-minute "floor trend −0.108 GB/h".** The 8h20m slope is
+0.0001 GB/h (7 complete buckets), 1000× smaller and of the opposite sign; sustained, −0.108 would
have drained ~0.9 GB. It was one-hour noise. Quote no floor slope, in either direction, from less
than several hours. (Like-for-like: both are floor-minima regressions, hour buckets here vs
10-minute blocks there — the comparison is of slopes, not of two different statistics.)

**GOTCHA — the sampler is NOT PINNED TO A PID, and this is now READ, not inferred.** Its selector is
literally `grep 'standalone/server.js' /tmp/rss-snap.$$ | grep -v grep | head -1`: it re-resolves by
COMMAND STRING every sample and takes whichever process `ps` lists first. Exactly one row of 507
(239, 08:12:47) carries pid 19113 / `elapsed=00:00` / 28 MB. **CAUSE UNKNOWN — and the story I
first published here is WITHDRAWN.** I wrote that it was "a genuine second `standalone/server.js`
that lived under a minute — the data-dir lock guard refusing a second claimant, working as
designed": a causal mechanism plus a *working-as-designed* verdict, fitted to ONE row, with no log
checked, **shipped in the commit that added the rule against exactly that.** Checked since:
`~/.agentlens/server.log` carries **no data-dir refusal, no "already running", no second-instance
message**; its only `lock_contended` lines are a *usage-refresh* mutex, a different lock entirely.
**But that absence proves less than I then claimed** — I never confirmed the guard logs anything on
refusal, and a second process would most likely write to its OWN stdout, not the incumbent's file.
And my replacement explanation, *"28 MB is below node's baseline RSS so it plausibly never reached
the lock"*, was **a new unmeasured mechanism swapped in for the old one** — node's baseline RSS on
this machine was never measured. **WITHDRAWN too.** What is actually known is the row's contents:
pid 19113, `elapsed=00:00`, 28 MB, argv matching `standalone/server.js`. Anything with that string
in argv matches the grep — a status call, a probe, a restart attempt. **Do not cite this row as
evidence the lock guard works, and do not cite the log's silence as evidence it did not fire.**
Frequency, stated as the count rather than as a verdict: **1 foreign row in 507 samples over
8.4 h**; that is not enough to call it a one-off (the earlier "one-off, not recurring" was the same
one-run-for-the-variance error deleted elsewhere in the same commit). **The server did NOT restart,
and this
is arithmetic rather than a single-pair inference:** across row 239, wall 04:14:33→08:13:47 and
pid 21567's own `elapsed` 05:08:47→09:08:01 are both exactly **3h59m14s (14,354 s)** — the process
clock never reset. A per-block MINIMUM has no resistance to a single outlier by construction, so
0.2% bad data set a whole block's floor and invented `block23 min_rss=0.028G`, a fabricated collapse
shaped exactly like a restart. Always list pid changes before trusting any aggregate:

```bash
awk -F'\t' 'NR>1{if($2!=p){printf "row %d  %s  pid=%s  elapsed=%s\n", NR-1, $1, $2, $3; p=$2}}' \
  reports/cpu-runaway/rss-series-20260823_041323+0200.tsv
```

**AND COPY THE FILE FIRST — then recompute EVERYTHING from the copy, which the first correction
said it had done and had not.** The sampler is still appending, so successive awks over the live
path read successive *different* files (the original three hit 501, 503 and 508 rows). I froze the
series, re-ran only the REGRESSION against it, and then wrote "every number in this correction came
from one frozen 508-row snapshot" — while the floor table beside it was still the 501-row read. The
tell was visible in my own two commits: the 12:00 gauge mean is 22.7 in `925672d` and 23.1 in
`6f534c1`, disagreeing in exactly the bucket the 7 new rows landed in.
**Re-run on the frozen copy: the nine floor VALUES are unchanged** (1.167 … 1.099 — no hourly
minimum moved), **but the n column did**: 12:00 is n=41, not the n=35 I published. So the slope was
fitted to the right floors, and the claim about where the numbers came from was false anyway. *A
conclusion surviving does not make the method claim true, and the method claim is the one a later
reader relies on.* Freezing the file is not the discipline — re-deriving every published number
from the frozen file is. (**No "snapshot-invariant" generalisation is claimed** — two snapshots 7
rows apart is one run, not a variance estimate. The direct re-derivation licenses the slope; a
general claim would not have been supported and is not needed.)
**And the "501/721 samples" label was wrong in BOTH numbers.** The floor table was computed at 500
pid-samples / 502 rows, not 501, and the target is 720 samples / 721 rows. Arithmetic closes on one
foreign row: 500 + 1 = 501 samples = 502 rows then; 506 + 1 = 507 = 508 rows now.

**BLOCKED ON THE USER — the actual runaway is NOT fixed.** Everything landed so far removes an
AMPLIFIER. Even with a perfect memo, 147 calls/hour each pay ONE full 14,509-file walk. The shape
that follows is: memoize the ANSWER (the tool reports against a 60-minute TTL, so a seconds-fresh
answer is not required) + abandon server work on client disconnect. That CHANGES OBSERVABLE
BEHAVIOUR, so it is a PROPOSAL awaiting the user's call — do not build it unprompted.
**IT NOW HAS ITS OWN CARD: `TRDD-YST9ZJ90`** (`design/proposals/`, `column: proposal`). It was
prose inside THIS block until 2026-08-23 06:50, which meant that when this card goes terminal the
real problem would have left the board silently, archived as if solved. Prose is not a queue.

**LOAD-BEARING GOTCHAS** (each cost real time; the body has the full account):
- `ps %CPU` is a **1-minute decaying average** on macOS, not a lifetime one. Sustained = `TIME/ELAPSED`.
- `ps -o time=` prints **`MM:SS.ss`** here, not `HH:MM:SS`. Count the colons.
- `out/logReader.js` is a STALE artifact; the live test build is **`out/test/logReader.js`**.
- A Python shim shadows `/usr/bin/sample` — use the absolute path.
- `setsid nohup &` from a tool call is REAPED; use `scripts_dev/detach-run.py`, verify **ppid 1**.
- `.mocharc` `spec:` is ADDITIVE with positional args — isolate a test with `--grep`, not a path.
- A mocha **test's** `this.timeout()` does NOT cover its **hooks**; only the SUITE's does.
- The walk is **not a constant**: 126–1902 ms over 14,509 files (n=20, p50 633, p90 750).

**SUPERSEDED — do NOT carry forward:**
- ~~"sustains 150–270% CPU and 2.4 GB RSS"~~ → 27.4% of one core, 1.4 GB (title already corrected).
- ~~"the process is 83.3% idle, so this is bursty not sustained"~~ → inverted; the burn IS sustained.
- ~~`_collectJsonlFiles` is 72.0% of busy~~ → **17.4%**; the 72% was a 4.1× recursion double-count.
- ~~implied leak of `(2.47−1.36)/8h = 0.139 GB/h`~~ → FABRICATED (cross-process); never quote it.
- ~~`27.4%/13.3% = 2.1×`~~ → same cross-process defect, withdrawn.
- ~~"~0.8s of extra worst-case staleness"~~ → p90 quoted as a max; observed max walk is 1902 ms.
- ~~any `95% CI [a,b]` on the RSS floor~~ → a block MINIMUM is not t-distributed; read as
  "no signature at this resolution".
- ~~"REFUTED: most of the call-cost does NOT belong to earlier processes (before = 0)"~~ →
  **FALSE, and it was the most dangerous omission in the first version of this block.** The split
  used `Loaded .* spans from`, which the CURRENT build no longer emits (live marker:
  `OTLP receiver →`). The dismissed review was RIGHT: most of the logged call-cost belongs to
  processes never profiled. Grepping for a string that no longer exists returns zero and is
  indistinguishable from a clean refutation.
  **THE ONLY NUMBERS TO QUOTE ARE THESE, WITH THIS TIMESTAMP** (`server.log`, marker
  `OTLP receiver →` at line 371,025; boundary tested `NR<b` vs `NR<=b` — IDENTICAL, so no call sits
  on the marker line):
  **2026-08-23 06:58 — before 313 / 1576.1 s (5036 ms mean) · after 1478 / 1466.5 s (992 ms mean)
  · total 1791 / 3042.7 s → unprofiled share 51.8%.**
  **This split is a TIME SERIES, not a constant, and treating it as one produced two artefacts:**
  (i) the unprofiled share DECAYS — numerator frozen (those processes ended), denominator growing
  (the profiled one still runs) — so the 68.4% quoted earlier was 51.8% two and a half hours later;
  (ii) an apparent arithmetic contradiction, `313 + 770 = 1083` against a `total` row of `1082`,
  which is NOT an off-by-one: the parts were counted after the total, on a counter that had
  advanced. Nothing was wrong; the readings were simultaneous only in the writing-up. The earlier
  `after = 769 / 728.8 s` was DERIVED by subtracting two such snapshots and then stated as
  measured — do not repeat that.
  The overstatement factor is **3.03×** (`2210.7 / 728.8`), not the 3.2× first written here: 3.2 is
  `2304.9 / 728.8`, which is "the true TOTAL is 3.2× the profiled process's consumption" — a
  different quantity from "I overstated that consumption". Arithmetically real, semantically
  mislabelled — the same collision as the two 68.4%s below, shipped in the commit that flagged them.

**⚠ TWO DIFFERENT NUMBERS ARE BOTH "68.4%" — do not conflate them:**
`1576.1/2304.9` = cost in **unprofiled earlier processes** (the entry above).
`12.01/17.56` = the **main thread's share of the profiled process's CPU** (box 1's scope).
Numerically identical to one decimal, semantically unrelated. Always say which.

**ARTIFACTS TO READ FIRST** (all under `reports/cpu-runaway/`, gitignored):
`20260823_040232+0200-live-profile-check-cache-expiry.md` (the profile, with its own corrections
header), `20260823_043026+0200-who-calls-check-cache-expiry.md` (the caller), and
`20260823_041540+0200-box5-disk-attribution.md` (box 5 excluded).

> **TITLE CORRECTED 2026-08-23.** It read *"sustains 150-270% CPU and 2.4 GB RSS"* — the 268.8%
> is a **1-minute decaying average**, not a sustained figure, and the body spent a night
> establishing that. The most-read line of the document asserted the exact reading everything
> below it corrects. Sustained is **27.4% of one core** (`TIME/ELAPSED`, flat across 94 samples);
> the 2.47 GB RSS belongs to a different process on 2026-08-20 and is not this one's 1.4 GB.
> Filename slug left unchanged so existing references still resolve.

## Observation (2026-08-20, measured, not inferred)

The janitor's `system-daemon-runaway` detector fired on the live `standalone/server.js` process,
over the bar on two consecutive checks. A `ps` snapshot taken immediately after:

| field | value |
|---|---|
| elapsed | `08:12:40` |
| `%CPU` (1-min decaying avg) | **268.8** (detector reported 154 on its own sample) |
| RSS | **2,472,192 KB ≈ 2.47 GB** |
| UTIME / STIME | 60:00.45 / 5:34.51 |

**60 minutes of USER cpu-time over an 8-hour uptime, across at least two busy threads** (85.9% and
21.7% on the per-thread view). This is sustained work, not a burst: the process has spent ~12% of
its wall-clock life executing, on a machine that was mostly idle.

Host disk was simultaneously at **96% (83 GB free of 1.9 TB)**. The disk figure is NOT attributed to
the server here — this repo's own `rust-core/target` was 41 GB at the time — but it is recorded
because the detector reported the two together and a future reader should not re-derive the split.

## Why this is a NEW card and not an append

`TRDD-0XGU6NE2` (*"Audit response — maintainer claim that the server self-restarts and eats 2G/hr of
disk"*) is `column: complete` and therefore frozen. It answers a DIFFERENT claim: self-restart
behaviour and disk growth rate. Neither its question nor its evidence covers sustained CPU with a
flat 8-hour uptime — in fact the 8-hour uptime is direct evidence AGAINST the self-restart claim it
examined, which is worth noting when this is investigated.

## The leading hypothesis, and why it is only a hypothesis

`CLAUDE.md` records a prior incident of exactly this shape (2026-08-17, "server burns one core
continuously"), traced to a **full-store rescan when `windowHours` was absent** — minutes of one
pegged core per call on a 5.5M-span store. The fix was `scanOtelCallEventsIndexed` (TRDD-7I5805QM),
which serves sealed days from per-day sidecars and parses only the live segment.

That makes the indexed scan the first place to look, NOT the conclusion. Two threads busy at once
does not match a single unindexed scan, and nothing here has yet been traced to a call site. Do not
open with "it is the window scan again" — that is the shape of a confident wrong answer.

## 2026-08-22 — NOT reproducing, and the reason threatens the whole method

Sampled while working a neighbouring card:

```
pid 5644  elapsed 24:16  %CPU 8.7  RSS 1,380,000 KB   (standalone/server.js)
```

8.7% and 1.38 GB against this card's 268.8% and 2.47 GB. **That is not a refutation** — this
process is 24 minutes old and the original observation was at 8h12m uptime, so it has not had
time to reach the state being investigated. A young process reading healthy proves nothing about
an old one, which is exactly the trap the acceptance criteria already guard against by demanding
a series rather than a second snapshot.

**The problem is that an 8-hour uptime may no longer be obtainable.** The server was replaced
between 21:09 and 21:51 with no human or session action, and `~/.agentlens/.daemon-revive.lock`
is being rewritten every ~minute — so something restarts this process, and the 8h12m sample this
card rests on may have been the exception rather than the norm. Full measurement and the
candidate causes: the 2026-08-22 amendment on **TRDD-4FMHW124**.

**Consequence for the method, and it is load-bearing:** the first acceptance box asks for a
profile "against a server reproducing the condition". If the reviver clears the process before it
reaches the condition, that box is unsatisfiable in the field, and the reproduction has to be a
LONG-RUNNING SCRATCH server (see the note below about `--data-dir`) deliberately kept outside
whatever restarts the default one. Identify the reviver first — profiling a process that keeps
being replaced measures start-up, not the runaway.

Also seen in the same snapshot, unrelated to this card but recorded so it is not lost: an
`alcore serve` has been running **9h+** (8h54m, then 9h09m an hour later — still climbing)
against a `/var/folders/.../tmp.imEiZwa9vD` data dir at 0.0% CPU / 15 MB RSS. An orphan: its data
dir is temporary, so nothing consumes what it serves.

**Its origin is NOT established, and my first note here overclaimed it as "test-spawned".** The
correction matters because it changes who owns the fix: the only test that spawns alcore is
`src/test/alcoreCutover.test.ts` (single `child.kill('SIGTERM')`, :117), but that suite makes its
temp dirs with node's `mkdtemp` — which yields an `agentlens-*` prefix, **not** the `tmp.XXXXXXXX`
form of shell `mktemp -d`. So this was more likely started by a script than by mocha, and
attributing it to the test suite would send someone to harden a teardown that may already be
correct.

**Deliberately NOT killed.** It costs 0.0% CPU and 15 MB, its origin is unverified, and it is not
mine to reap on a guess — the cost of being wrong exceeds the 15 MB. Recorded instead.

## 2026-08-23 — PROFILED against a live reproduction; the trigger is a REQUEST, not a timer

Full evidence: `reports/cpu-runaway/20260823_040232+0200-live-profile-check-cache-expiry.md`.

The condition WAS obtainable after all: pid 21567 at **4h48m uptime, `ps %CPU` 93.6, RSS 1.39 GB**,
running the 23:00 bundle (pre-dating the 03:47 perf commit, so it is the code the original
observation was made on). SIGUSR1 + inspector, 45 s, 257,123 samples.

> **CORRECTED 2026-08-23 04:12 — two claims in the first version of this section were FALSE and
> are struck below. An adversarial review caught them and I verified both first-hand. A third
> defect it alleged is REFUTED, also first-hand. Read the corrections, not the originals:**
> `reports/cpu-runaway/20260823_040828+0200-adversarial-review-of-033ad2b.md`.

**~~The process was 83.3% IDLE during the window; `ps %CPU` is a LIFETIME AVERAGE, so this is
bursty, not sustained.~~ FALSE — INVERTED.** macOS `man ps` is explicit: "%cpu — The CPU
utilization of the process; this is a **decaying average over up to a minute** of previous (real)
time." This card's own line 24 already said "1-min decaying avg" and was RIGHT; I contradicted it
without addressing the contradiction, then built a headline on the contradiction.

**The correct sustained figure comes from `TIME/ELAPSED`, not `%CPU`:**

| process | elapsed | cpu time | sustained |
|---|---|---|---|
| profiled pid 21567 | 5:03:15 (18,195 s) | 83:07 (4,988 s) | **27.4% of one core** |
| original incident (2026-08-20) | 8:12:40 (29,560 s) | 65:35 (3,935 s) | **13.3%** |

**The burn IS sustained** — the card's original framing was right and my "bursty" correction was
wrong. The 83.3% idle reading is a true measurement of a 45 s window that caught a quiet stretch,
which is precisely the one-snapshot error this card warns about for RSS, committed here for CPU.
Minute scale is genuinely spiky (93.6% at one sample, 12.9% two hours later); lifetime is not.

**27.4% is a STABLE property of that process, measured**: across 94 samples of the series it reads
27.4, 27.5, 27.5, 27.3, 27.1, 27.1, 27.1% — slope −0.35 pct-points/hour, flat over the observed
window. That is what carries "sustained".

> **~~The profiled process burns 2.1× the original incident's sustained rate.~~ WITHDRAWN — same
> defect class I removed for RSS, left standing here.** Killing `(2.47−1.36)/8h` fixed the
> INSTANCE, not the CLASS: 27.4% ÷ 13.3% is still a cross-process ratio. Different processes,
> different days, different code (this one runs the 23:00 bundle; whatever ran on 08-20 is
> unrecorded), different machine load (~30 Claude sessions now, unknown then), a corpus that has
> grown — divided as if like-for-like, and both quoted to three significant figures from single
> `ps` readings with no interval. It also earns nothing: "the burn is sustained" follows from
> 27.4% on one process alone. Deleted rather than qualified.

**~~`_collectJsonlFiles` 72.0% inclusive~~ FALSE — a 4.1× double-count. TRUE value: 17.4%.** My
inclusive rollup walked each sample's ancestor chain and added to a map keyed by frame LABEL,
deduping node ids but not labels — so a self-recursive function (`_collectJsonlFiles` recurses per
directory) was counted once per stack frame instead of once per sample. Verified by re-running
with per-sample label dedupe: `counted=72.0% TRUE=17.4%`. **My own `roots.mjs` had already printed
17.4% in the same session and I published both numbers without reconciling them** — the discrepancy
was in my own output, not hidden.

**The non-recursive figures are UNAFFECTED** (same re-run: `handleCheckCacheExpiry` 36.6%,
`getLastRequestMs` 36.1%, `statSync` 25.6% — identical before and after dedupe), so the trigger
attribution below stands. The top self-time chain
`statSync <- collectFileMeta <- transcriptPathFor <- getLastRequestMs` at 20.3% of busy is a
leaf-node measurement and was never subject to the double-count.

**Trigger, by root-to-leaf chain:** 36.6% of busy enters through `wrappedHandler →
handleCheckCacheExpiry` — an HTTP request, i.e. the `check_cache_expiry` MCP tool, reached from
`agentlenspro cache-expired` (`src/cli/cacheExpiredCli.ts:115` → `callTool`). The periodic
`runLogScan` timer is only 8.2%. **The dominant trigger is a request path.**

Cost from the server's own log: **1022 calls, 2210.7 s total**, mean 2169 ms, p50 771 ms,
p90 3930 ms, **p99 25.6 s, max 65.1 s** — against a CLI budget of 1500 ms, so the CLI abandons the
request while the server keeps working.

> **CORRECTED AGAIN 2026-08-23 04:20 — the paragraph that stood here "refuted" the review and was
> itself WRONG. Third correction on this section; the review was right both times.**

**~~This cost belongs to the profiled process; the review's contrary claim is REFUTED.~~ FALSE.**
I split the log on `Loaded N spans from …` and found the last at line 10,753 with zero calls
before it. **That marker is a RETIRED log format.** The current one reads
`Loaded N span(s) (last 24h window) from …`, so my grep matched only old-format boots and I
concluded "no boots after line 10,753" about a log with 199 successful boots (counted on the
`OTLP receiver →` line, which is emitted once per successful start; the 423 `Refusing to start`
lines are FAILED starts and must not be counted as boots).

**Correct split, on the real last boot (line 371,025 of 379,175):**

| window | calls | total | mean |
|---|---|---|---|
| **after last boot — the profiled process** | 769 | **728.7 s** | **947 ms** |
| before last boot — earlier, never-profiled processes | 313 | **1576.1 s** | 5035 ms |
| total | 1082 | 2304.9 s | |

So **68.4% of the cost belongs to processes I never profiled**, and I overstated the profiled
process's own consumption by **3.2×**. Worse for the earlier framing: the earlier processes averaged
**5035 ms/call against the profiled one's 947 ms**, so the p99/max outliers this card leaned on
most likely belong to those, not to the process the profile describes. Corroborating: the three
calls captured during a 60 s instrumented window measured 1193/693/1685 ms — the 947 ms regime,
not the 5035 ms one.

## 2026-08-23 04:20 — ~~BOX 1 UNTICKED~~ RETRACTED at 04:31; the off-main CPU is V8 GC, not fs

**The untick was an OVERCORRECTION and both of its premises were false.** Established twice
independently — by a 30 s `/usr/bin/sample` of all threads I ran myself, and by a third
adversarial review that reached the same two conclusions. Having overclaimed twice, I underclaimed
once; the record of all three is deliberate.

**FALSE — "the async `readdir`/`stat` load runs on those invisible threads".** All-thread sample
(`reports/cpu-runaway/20260823_042349+0200-allthreads-sample.txt`):

| thread class | in-window state |
|---|---|
| 4 × `libuv-worker` (the actual fs threadpool) | **23338/23338 samples in `uv_cond_wait` — 100% idle**, ~2.1 s lifetime total (0.04%) |
| 4 × `node-V8Worker` | ~98% idle in-window; their lifetime CPU is **V8 concurrent GC** (`ConcurrentMarking::RunMajor`) |
| main thread | the only meaningfully busy thread |

The fs threadpool does essentially nothing — that part is a direct read of the sample.

**The GC attribution is WEAKER than I first wrote it, and the overstatement is corrected here.**
I said this "measures box 2's GC-pressure candidate at ~21.6% of process CPU". It does not. The
21.6% comes from `ps -M` columns, which say those threads burned CPU but not what they burned it
on; the GC label comes from a thread NAME (`node-V8Worker`) plus one observed stack frame
(`ConcurrentMarking::RunMajor`). That is a strong indication, not a measurement — upgrading a
label into a number is the same move that produced three earlier defects. **To actually measure
it:** `--trace-gc` on a restarted server, or a `v8.getHeapStatistics()` delta series. Until then:
~21.6% of process CPU is off-main and *most likely* V8 concurrent GC.

**FALSE — "11.3% of a core, so the profiler is blind to the majority".** I computed that as
`busy_samples × 100 µs`, assuming the interval I requested. V8 never honoured it — effective
interval was **170.7 µs**. And the busy *fraction* is also wrong, because samples are NOT
uniformly spaced (a stalled sampler yields larger deltas on busy samples). The profile carries
`timeDeltas`; summed, they cover **100.0%** of wall clock, and the correct figure is:

| profile | main-thread busy | share of a core | my published figure |
|---|---|---|---|
| 45 s | 10.68 s | **23.5%** | (16.7% busy-fraction) |
| 60 s | 13.29 s | **22.0%** | **11.3% — wrong** |

**The "58–96% of process CPU" band I first published here was itself a window mix and is
withdrawn.** Its two numerators came from different windows over a bursty process — 22.0/23.5%
from the profiles' own intervals, 23.0–38.2% from three per-minute `TIME` deltas — so the band's
WIDTH was an artifact of the mismatch, not real uncertainty.

**Measured properly, both numerators from ONE identical window** (`ps -o time=` read immediately
before and after a 60 s profile):

**Four independent paired windows** (the first at 60 s, three more at 40 s — the harness makes
extra windows nearly free, so the n=1 version of this table was replaced rather than caveated):

| window | wall | process CPU | main-thread busy | main share |
|---|---|---|---|---|
| 1 | 60.3 s | 17.56 s | 12.01 s | 68.4% |
| 2 | 40.4 s | 12.09 s | 8.24 s | 68.2% |
| 3 | 40.4 s | 13.61 s | 9.63 s | 70.8% |
| 4 | 40.4 s | 8.69 s | 5.92 s | 68.1% |

**Mean 68.9%, range 68.1–70.8%** — but stated precisely, because the general form is not what was
measured: **across a 1.6× swing in absolute process CPU (8.69 s → 13.61 s) within one ~5-minute
cluster, the main-thread SHARE moved less than 3 points.** That is meaningful precisely because
the swing was large. It is NOT the claim "the ratio is stable" in general — four windows minutes
apart on one process are a cluster, not a sample of the regime space, and the series records
extremes (93.6% vs 5.4% `%CPU`) that no window here spans.

`ps -M` lifetime says 78.4% main, about 10 points higher than the windowed 68.9%. **Both support
"the main thread is the majority"; the cause of the gap is UNMEASURED.** An earlier version of
this line explained it as main-thread-heavy startup — plausible, probably true, and never
measured. Offering an unmeasured mechanism is worse than stating the bare discrepancy, because it
closes a question the reader would otherwise check.

**TRAP, hit while taking exactly this measurement:** `ps -o time=` prints **`MM:SS.ss`** here
(`90:45.41` = 90 minutes), not `HH:MM:SS`. Parsing it as `HH:MM:SS` yielded "1422 s of CPU in 60 s
of wall" — impossible, and only caught because it was impossible. A less absurd process would have
made the same bug invisible. Count the colons (`NF`), never assume the format.

**Box 1 is RE-TICKED with its scope stated:** the main thread is profiled and its frames named,
and the main thread is where the majority of the CPU is. The remaining ~21.6% is measured and
attributed to V8 concurrent GC, but not frame-attributed.

## 2026-08-23 04:30 — WHO calls it (measured) and a session-scaling HYPOTHESIS (not measured)

Inside AgentlensPro `check_cache_expiry` has exactly one caller — `src/cli/cacheExpiredCli.ts:115`
→ `callTool` → server HTTP. Nothing else in `src/`/`standalone/` calls it; the `agentlenspro gate`
and `agentlenspro hook` hooks do NOT.

The verb is driven from **outside this repo**, by **ai-maestro-janitor 3.3.26**:
`scripts/lib/agentlens_probe.py` (`DEFAULT_CACHE_EXPIRED_COMMAND = "agentlenspro cache-expired"`,
5 s subprocess timeout, fail-open), invoked by the heartbeat detectors
`scripts/detectors/window-burn-rate.py:50` and `scripts/detectors/token-usage-anomaly.py:37`,
plus `scripts/lib/external_clear.py`.

(The version is right for a better reason than the one I first had: the dispatcher stub
**re-resolves "latest cached version"** by its own documented design, so 3.3.26 — the highest of
the 11 cached — is what executes. My original basis was that it sorts last, which is the same
disk-artifact-for-the-thing shape as the retired-log-format defect above.)

**MEASURED:** 769 calls over 5h14m = **147 calls/hour**, each a full recursive `readdir` +
`statSync` over 14,509 files. That is an average over one window, not an observed rate law.

**HYPOTHESIS, NOT MEASURED — flagged because the first version of this section asserted it as
fact in its own heading.** The shape `cost = N_sessions × N_detectors × beat_rate` predicts the
burn scales with how many Claude sessions are open rather than with uptime. **I never measured
it.** One machine state, one session count, one rate — the causal arrow is asserted. Three
specific weaknesses, each fatal on its own:

- **`N_sessions` is itself a proxy.** The "30 `claude` processes" is `grep -c claude` over a `ps`
  snapshot, which counts helper processes, MCP children and this session's own subagents — not
  janitor-armed sessions.
- **It is self-undermining.** If load scaled with sessions, the pre-boot processes averaging
  5035 ms/call would imply MORE sessions then — yet I also explained that same gap by corpus size
  and by event-loop contention. Three explanations for one observation, none discriminated.
- **The 08-22 "healthy young server" is not evidence for it.** That process had 24 minutes of
  uptime, and this card already records that a young process proves nothing — then I reused it as
  confirming evidence for a different hypothesis.

**The discriminating experiment** (cheap, not yet run): sample the call counter and the
janitor-armed session count together at two points an hour apart. If calls/hour tracks the armed
count, the hypothesis holds; if not, this reframing is wrong and the fix target moves again.

**Neither timeout bounds the server:** the janitor abandons at 5 s, the CLI at 1500 ms
(`src/cli/main.ts:92`), and neither cancels server-side work — hence 25–65 s calls nobody awaited.

**NOT established:** the per-detector cadence/gating, so 147/hour is measured but its decomposition
across the 30 sessions is not. Full note:
`reports/cpu-runaway/20260823_043026+0200-who-calls-check-cache-expiry.md`.

**TWO HYPOTHESES WERE DISPROVED BY MEASUREMENT, and no fix was shipped on them.** (1) That
`collectFileMeta()`'s 2 s TTL is *born expired* because `_fileMetaCacheAt` is stamped with a
PRE-walk `Date.now()` — the code is exactly that (`src/logReader.ts:324`/`:387`) and the
arithmetic (`lifetime = TTL − walkDuration`) is real, but the measured walk is **820–879 ms over
14,509 files**, so it does not trigger at this corpus size.
**→ AMENDED 05:10, RE-AMENDED 05:20.** Injecting a 2500 ms stall into the walk (TTL left at its
real 2000 ms) turns 5 probe candidates into **5 full walks** — past the cliff the memo does not
degrade, it DISAPPEARS. But **"CONFIRMED" overstated it and is withdrawn**: that proves the
MECHANISM (*if* `walkDuration > TTL` *then* collapse), not that the antecedent has ever held in
production. The only time it held is when I forced it. Correct phrasing: **reachable and
mechanically confirmed, not yet reached.**

**THE WALK TIME IS NOT A CONSTANT — that is the real finding, and my first two attempts to state
it were both wrong.** I quoted "820 ms" as *the* walk time throughout the night. Then, correcting
that, I promoted **1507 ms** to the operative headroom number — **the mirror image of the same
error**, a single draw from a dispersed quantity, this time the alarming end instead of the
convenient one. The defensible form is the distribution. n=16, all on the **same** 14,523-file
corpus:

**NO SUMMARY STATISTIC IS CLAIMED, and the third attempt at this paragraph is why.** The 16
observations come from three NON-EXCHANGEABLE designs and pooling them describes no real
population: 8 in-process repeats (warm process, warm allocator, JIT already compiled — samples 2-8
are conditioned on sample 1), 5 fresh-process runs (each paying startup + JIT warmup), and 3
ad-hoc samples taken hours apart. The in-process design contributed HALF the pool and structurally
cannot occur in production — the server does one walk per request from a long-lived process with a
cold memo, never eight in a row — so any pooled median is dominated by the cheapest condition.
**All that is defensible from these 16: the range is 143–1507 ms and the count is 16.**

A clean single-design measurement (20 fresh-process single-walk runs, 30 s apart) is running as of
05:19 → `reports/cpu-runaway/walk-clean-20260823_051928+0200.txt`. **Deliberately started BEFORE
writing the conclusion**, because the failure this card keeps repeating is not single-sample
reasoning — it is reaching for the number that supports the sentence already being written (820
supported "latent"; 1507 supported "urgent"; 317 supported "comfortable headroom"; each defensible
alone, each pre-selected).

> **PRE-REGISTERED 05:24, before the file was read:** the statistic is **p90 of the 20 runs against
> the 2000 ms TTL**, whatever it says; n/min/p50/p90/max all reported, verdict keyed to p90.

**RESULT (n=20, one design — fresh process, one cold-memo walk, 30 s apart):**
`126, 129, 133, 135, 146, 155, 317, 586, 624, 633, 658, 660, 666, 672, 679, 734, 737, 750, 769, 1902`

| | ms | % of the 2000 ms TTL |
|---|---|---|
| min / p50 | 126 / 633 | 6% / 32% |
| **p90 (pre-registered)** | **750** | **38%** |
| max | **1902** | **95%** |

**VERDICT — the tail is UNCHARACTERISED and that is what decides anything; the normal regime is
comfortable (p90 = 750 ms, 38% of the cliff).** Sentence deliberately inverted: it previously led
with the reassuring clause and appended the caveat, and a skimmer takes the first half. The
pre-registration binds which STATISTIC the verdict keys to (p90, honoured above), not which clause
comes first. A walk crossing 2000 ms collapses the memo into 5× amplification, and the exceedance
rate that governs how often that happens is bounded only as 0–15%. The pre-registration also
selected **the wrong FAMILY of statistic**, which matters more than its instability.

> **THE FAILURE IS A THRESHOLD EVENT, so the operative quantity is the EXCEEDANCE PROBABILITY, not
> a central quantile.** Any SINGLE walk over 2000 ms collapses the memo for that request's whole
> probe burst. p90 answers "where do most walks land" — a question nobody asked, because 90% of
> walks finishing comfortably is entirely compatible with the cliff being crossed several times an
> hour.
>
> **What the data actually bounds:** 0 of 20 runs exceeded 2000 ms. By the rule of three, the 95%
> upper bound on P(walk > TTL) is **3/20 = 15%**. At the measured 147 calls/hour that admits **up
> to ~22 memo collapses per hour**; even a 1% exceedance rate gives ~1.5/hour, each costing 5×
> walks by the stall measurement above.
>
> **Honest verdict from n=20: the exceedance rate lies somewhere in 0–15%, and this sample cannot
> distinguish those.** That is a materially different card from "38% of the cliff".

**Stated operationally, so neither number can be taken without the other:** *90% of walks finish
within 750 ms*, and *1 walk in 20 came within 98 ms of collapsing the memo*.

**The distribution is a MIXTURE. My first partition of it was NOT the gap-based one I called it.**
I cut at round numbers (200, 1000) after looking at sorted data and narrated the result as
clustering. The gaps are 3,4,2,11,9,**162**,**269**,38,9,25,2,6,6,7,55,3,13,19,**1133**; cutting at
the top two gives:

| | n | range | max as % of TTL |
|---|---|---|---|
| low | **7** | 126–**317** ms | 16% |
| main | **12** | 586–769 ms | 38% |
| tail | 1 | 1902 ms | **95%** |

The tell is **317**: its larger adjacent gap is *above* it, so gap-clustering puts it in the LOW
group — I had assigned it to MAIN (reporting 6/13 instead of 7/12) to make my round-number cut
work.

**But the gap partition is NOT "the true" one either, and calling it that repeats my own error one
level down.** Largest-gap clustering has **no stopping rule**: it yields k groups for whatever k you
ask, and here the 2nd and 3rd gaps (269 and 162) are not well separated. What is actually
established is only the NEGATIVE — that my round-number cuts were not the algorithm I said they
were. **No partition of these 20 points is established**; the numbers below are one defensible
reading, not a discovered structure.

**p90 = 750 ms is nevertheless robust to the partition — CHECKED, not asserted:** pooled n=20 → 750,
my MAIN → 750, gap-corrected main → 750. Identical under all three. The objection I was answering
(six fast values dragging the pooled p90 below main's own) is real in general and simply fails
numerically here. One line of arithmetic would have established that; I reasoned around it instead.

**WITHDRAWN — "the outlier is a distinct event, not the tail".** That rested on 769→1902 being the
largest gap, which in a right-skewed sample is the gap below the maximum **by construction** — it
restates that 1902 is extreme rather than showing a separate mechanism. Tested by bootstrapping the
top gap against a fitted null.

**And the first null I used was the most favourable of four — checked, because fitting σ on a sample
that CONTAINS the outlier inflates σ and biases the test toward "ordinary", which was the answer I
wanted.** Re-run four ways:

| null | P(top gap ≥ 1133 ms) |
|---|---|
| lognormal, fitted on all 20 *(what I first reported)* | 0.226 |
| lognormal, leave-one-out | 0.143 |
| exponential, mean-matched | 0.149 |
| exponential, leave-one-out *(most adverse)* | **0.107** |

**Reported as a RANGE, not a threshold verdict: p = 0.107–0.226 across four nulls.** The range IS
the finding. My first phrasing — "every null exceeds 0.10" — smuggled in a cutoff I never justified
and had picked after seeing the values. The sensitivity analysis itself is sound (two families ×
with/without the point under test, all specified before their values were known, all reported
including the one nearest the boundary); compressing it to a threshold was not.
**I then reported the WRONG ERROR BAR, and it was the flattering one.** I quoted Monte-Carlo
intervals ([0.196, 0.268], [0.122, 0.192]) — those measure how many draws I took from the
*simulator*, not how much p would move given 20 *different real walks*. The observed 1133 ms gap
enters the calculation as a fixed constant when it is itself a single draw from a high-variance
statistic (the maximum spacing of 20 points). "Precisely estimated" was true of the estimator and
false of the estimate.
**The interval that matters — resampling the 20 observations, refitting the null on each:
median p = 0.327, 95% [0.117, 0.773].** Note the MC interval was **not a too-narrow version of this
one — it was an interval on a DIFFERENT QUANTITY**, which is the whole distinction; calling it "9×
too narrow" blurred exactly the point.
Two properties of that band worth knowing before leaning on it: ~36% of replicates contain no 1902
at all ((19/20)²⁰ = 0.358), and those drive the median to 0.327 and stretch the upper tail; ties
from resampling with replacement also inflate max-spacing. So its width is real but its shape is
dominated by outlier-PRESENCE, not by anything about the outlier's nature.

**The conclusion needs none of that machinery, and the simple argument is the right one: there is
exactly ONE observation in the tail, and one point cannot characterise a tail.** That was true
before the first bootstrap and needed no simulation. A CI on a p-value is generically wide — p near
0.2 has an interval roughly this wide at any n — so [0.117, 0.773] is *consistent with* "n=20
cannot settle this", not what establishes it.

> **SCOPE, which matters more than the statistics and should have been asked first:** whether
> 1902 ms is a separate regime or a tail draw **changes no action on this card**. Either way walks
> occur near the cliff, the memo collapses if one crosses, and the fix is identical. Several rounds
> went into a question with no decision attached to it.
σ inflation from including the outlier was **+8%** (0.819 → 0.760 LOO). **I claimed that inflation
CAUSED the 0.226 → 0.143 shift; I did not isolate it.** The LOO null is fitted on 19 points but
still compared against a 20-point draw containing the outlier, so the change mixes the σ shift with
a sample-composition shift. Naming an unseparated mechanism is the same shape as the page-cache
attribution already withdrawn on this card.

**ALSO WITHDRAWN — "1 run in 20 = 5% of runs".** Exact binomial 95% CI for 1/20 is
**[0.13%, 24.9%]**, a ~190× range quoted as one number. The rule-of-three bound (0–15% for
exceedance) is the defensible form.

**What survives is narrower than I wrote.** I had reported the sample SORTED, destroying the
temporal evidence; recovered, the sub-200 ms runs fall at positions **3, 11, 12, 16, 19, 20 —
interleaved, not contiguous.** That excludes **MONOTONIC** drift (a page-cache warm-up would put
them contiguously at one end) — **it does not exclude a load-driven or cyclic pattern**, and I
wrote "per-call, not drift" as if it did.
That distinction is load-bearing here, because the escalation loop above is *precisely* load-driven:
if fast walks cluster when the machine is quiet, slow walks cluster when it is busy — the
correlation that would make the cliff dangerous. Five of the six do fall in the second half, so I
tested it rather than eyeballing: mean position 13.5 vs 10.5 expected, **permutation p = 0.076**
(MC-95% CI [0.069, 0.086]). A load-driven pattern is **neither shown nor excluded**. (One correction
to the review that prompted this: three of six are in the last five slots, not four.)

> **No verdict word attaches to either p on this card.** Both are weak evidence with a stated
> direction, which is what n=20 supports. (I had called p=0.076 "not significant" while treating
> p=0.107 as a conclusion that "survives" — 0.031 apart, read in opposite directions, against a
> cutoff stated nowhere. The full account is in commit `6cd3fd0`; it does not belong in the card.)

Caveat kept: p90 of n=20 is the 18th order statistic and is not a stable estimator. The
pre-registration discipline worked; the CHOICE was poor, and naming p50 + max would have been
better.

**The cause of the spread is UNATTRIBUTED — and my refutation of my own explanation ALSO went too
far.** I wrote it was "OS page-cache warmth and machine load", which I never measured. I then
claimed the ordering (fresh-process runs 721, **1507**, 325, 172, 143) *refuted* page cache since a
cold-cache effect would put the max first. **That only kills a naive monotonic-decay model, which
is not how page cache behaves** — eviction is driven by memory pressure from other processes, and
on a machine running ~30 Claude sessions plus a 1.4 GB-RSS server, cold-warm-cold within five runs
is ordinary. So page cache is **not ruled out**; it is one of several candidates that **no design
here can separate**. Replacing an unearned mechanism with an unearned dismissal would leave the
next reader believing it had been excluded.
What survives: a 0.1% change in file count (14,509 → 14,523) cannot plausibly explain a 10×
spread, so the variance is not corpus-size driven. (Not run: `sudo purge`-separated cold/warm
walks — needs an interactive password in an unattended session.)

**Escalation path — two steps measured, two NOT.** A blanket "inference" label was not enough,
because this loop is the only thing making the defect urgent rather than merely latent, and its
measured endpoints made the whole chain read as measured:

| step | status |
|---|---|
| a slow enough walk collapses the memo | **MEASURED** (stall experiment) |
| collapse turns one walk per probe into N | **MEASURED** (5 candidates → 5 walks) |
| server load slows the walk | **NOT MEASURED** |
| the extra walks meaningfully raise load | **NOT MEASURED** |

Evidence: `reports/cpu-runaway/20260823_051050+0200-born-expired-mechanism.md`. The FIX is still
open (the advisor question on data-age vs cache-lifetime). (2) That `transcriptPathFor` is an
O(all-files) scan run 12× per probe — structurally true, but **measured at 0 ms for 12 lookups
with 0 extra walks**, because entries are sorted newest-first and the probe ranks the newest
sessions, so lookups hit the front. Both are recorded in the report so they are not re-derived.

**What the 25–65 s tail actually is: wall-clock under contention, not that tool's CPU.** The
slowest calls OVERLAP each other and interleave with span ingest in the log; Node is
single-threaded, so a reported duration absorbs event-loop time spent on other work. That moves
the fix target from "one slow function" to the synchronous fs work blocking the loop plus the
absence of any concurrency control on overlapping probes.

**NOT established:** which call sites produce the p99 (contention is implicated, not proven
per-call); whether RSS is a leak or steady state (needs the series box 3 asks for); box 5. **And
the profile is ONE 45 s window** — it names the frames of the work it caught, which is what box 1
asks, but it is not proof that this mix holds across the other 5 hours. A second window at a
different hour would cost 45 s and is the cheap way to settle it; until then treat the mix as
sampled, not characterised.

**Trap recorded:** `out/logReader.js` is a STALE artifact of an older layout and lacks
`transcriptPathFor`; the live test build is `out/test/logReader.js`. A script requiring the
former silently measures old code — it cost two failed runs here.

## Acceptance criteria

- [x] The busy stack is IDENTIFIED, not guessed — a CPU profile (`node --cpu-prof`, or SIGUSR1 +
      inspector) taken against a server reproducing the condition, naming the hot frames.
      2026-08-23: ticked → unticked → RE-TICKED the same night; the untick was an overcorrection
      on two false premises (see the section above). Two inspector profiles (45 s / 257,123 and
      60 s / 353,511 samples) of pid 21567 name the MAIN-THREAD frames, and a paired measurement
      over ONE identical 60.3 s window (both numerators from the same interval) puts the main
      thread at 12.01 s busy against 17.56 s of process CPU = **68.4% of process CPU**. SCOPE,
      stated rather than glossed: the other ~31.6% is off-main and MOST LIKELY V8 concurrent GC
      (thread name + one stack frame — indicated, not measured); the libuv fs threadpool is
      100% idle, so it is not fs work.
- [x] The work is attributed to a trigger: a periodic timer, a request path, the log watcher, the
      span-store compaction, or GC pressure from the 2.47 GB heap.
      2026-08-23: on the MAIN THREAD, a REQUEST path (`check_cache_expiry`, 36.6% of busy)
      dominates; the `runLogScan` timer is 8.2%; GC 0.98%. Survives both correction rounds
      unchanged (the frames are non-recursive, so the double-count never touched them). CAVEAT:
      this attributes main-thread work only — see the box above.
- [x] RSS growth is characterised as steady-state or as a leak — one measurement cannot tell them
      apart, so this needs a series, not a second snapshot.
      2026-08-23 04:50 — FIRST READ (32 samples, 1-min cadence, into
      `reports/cpu-runaway/rss-series-20260823_041323+0200.tsv`). RSS oscillates between
      1.17 and 1.53 GB.
      **THE DISCRIMINATOR IS THE SAWTOOTH FLOOR, not the mean, the slope, or the direction
      changes.** Sawtooth RSS is what ANY garbage-collected runtime produces, leaking or not; a
      leak shows as a rising FLOOR, and the floor moves long before the mean does.
      **65-minute read (04:14→05:18, n=65), per-10-minute minima:**
      1.347 → 1.348 → 1.167 → 1.334 → 1.262 → **1.239 GB**. Floor trend **−0.108 GB/h**;
      first-to-last delta **−0.107 GB**.
      **WITHDRAWN — the "implied leak of (2.47−1.36)/8h = 0.139 GB/h" was FABRICATED.** It
      subtracts the RSS of ONE process from a DIFFERENT process and divides by the first one's
      uptime, silently assuming the 2026-08-20 process started at the value today's process happens
      to show. **Nobody measured that process's starting RSS.** At 2.0 GB the rate is 0.059; at
      0.8 GB, 0.209 — a 3.5× range, quoted as one figure to three decimals and then used as a
      verdict target.
      **AND THE FIRST FIX LEFT IT ALIVE.** My replacement paragraph still used 0.139 as the signal
      size in a power argument, one paragraph after deleting it — a section that says no legitimate
      target exists, then computes power against one.
      **BOX 3'S ANSWER, stated without any target rate — the MINIMUM DETECTABLE EFFECT.** From the
      floor's own scatter over 65 min: slope −0.108 GB/h, SE 0.104. With **n=6 the multiplier must
      be t at df=4** (2.776 + 0.941 = 3.72), not the normal 2.8 I first used: **95% CI
      [−0.397, +0.181] — spans zero**, and **MDE ≈ 0.39 GB/h**. Both corrections run in the
      conservative direction: the window is *less* sensitive than I claimed, and the "underpowered"
      conclusion is stronger, not weaker. σ̂ from 4 df is itself uncertain by ~2×, so quote this as
      **order 0.3–0.4 GB/h, one significant figure**.
      *This window can only resolve a leak faster than ~0.4 GB/h; anything slower is invisible.*
      SE(slope) ∝ σ√Δ/T^1.5, so scaling to the 12 h series is **720/65 = 11.1× the window → 37×
      finer → MDE ≈ 0.01 GB/h**. (I previously wrote ~8×/0.04 by applying a reviewer's *4× example*
      ratio to an 11× window — arithmetic on someone else's illustration instead of my own data,
      and it understated my own instrument by 4.6×.)
      On the block-minimum estimator I flagged: a CONSTANT block size makes its upward bias roughly
      constant across blocks, which shifts the intercept and not the slope — so trend estimation
      here is defensible after all.
      **INTERIM READ, 2026-08-23 06:25 (12 complete 10-min blocks, ~2 h of the 12 h series).**
      Floor minima 1.347, 1.348, 1.167, 1.334, 1.262, 1.239, 1.327, 1.331, 1.330, 1.351, 1.188,
      1.338 GB. **Flat — no rising signature.** Deliberately stated without a rate: the
      least-squares slope over these blocks is ~5e-4 GB/h, and quoting that to any precision would
      be spurious against a 0.18 GB band of block-to-block scatter. "No rising floor at this
      resolution" is the entire content. The 12 h read is what settles the box.
      **BUT THAT DEFENDS THE SLOPE, NOT THE INTERVAL — a later review's point, and it is a
      different one.** Constant bias rescues the *point* estimate; it says nothing about the
      *distribution* of a block-minimum statistic, which is an extreme-value quantity and not
      t-distributed however many blocks there are. So the `95% CI [a, b]` notation imports a
      distributional claim this estimator does not support. **Read every interval in this box as
      "no leak signature is visible at this resolution", not as a calibrated 95% interval** — the
      MDE remains useful as an order-of-magnitude sensitivity floor, which is all it was ever used
      for here.
      **The per-process rate, for construction not for value** (pid 21567, uptime 308→375 min,
      n=68): RSS 1.379 → 1.361 GB, endpoint **−0.016 GB/h**, least-squares **−0.046 GB/h** —
      **consistent with zero**, as the CI above shows. The contribution is that it uses ONE process
      across a known uptime interval; the number itself decides nothing.
      Two statistics I first published here are WITHDRAWN as non-discriminating: "19 of 24 steps
      reverse direction" (a real leak at this scale — ~2.5 MB/min against tens of MB of jitter —
      would flip direction just as often, so the count measures noise-to-step ratio, not
      monotonicity), and the mutual corroboration with the GC finding (circular: that attribution
      is itself only "indicated, not measured", and sawtooth does not discriminate leak from
      steady state either way).
      **The slope is REPORTED BUT NOT RELIED ON, and the reason is a modelling point worth
      keeping.** OLS gives −0.181 GB/h; residuals are NEGATIVELY autocorrelated (Durbin-Watson
      2.70, rho −0.36 — mean reversion, i.e. sawtooth), which makes the OLS standard error
      CONSERVATIVE (an alternating series carries more information than n independent points), so
      corrected |t| ≈ 4.1. **But that is a VARIANCE correction answering a BIAS objection.** The
      real worry is misspecification: a line fitted to an oscillation has a slope set by where the
      window cuts the cycle, and no standard-error adjustment touches that — shrink the SE to zero
      and a biased point estimate stays biased.
      Tested rather than argued, in two stages, and the second stage RETIRES the first.
      Sub-window slopes are 5/5 negative — but those windows overlap by 10 of 15 points, leaving
      only **2 independent** windows in 35 minutes. And the sign test has a precondition I never
      established: it discriminates drift from cycle-phase ONLY if a window spans a full
      oscillation. **Measured the autocorrelation to settle it: there is NO coherent period.**
      Max ACF is +0.37 at lag 2 min and +0.25 at lag 7, everything else below 0.15, decaying to
      ~0 by lag 11 and mildly negative after — no dominant cycle, so "phase" is not well-defined
      and the phase-artifact alternative is itself weakly supported. But that does not rescue the
      slope: **2/2 sign agreement is p = 0.25 under the null**, which is not evidence.
      **VERDICT: the drift is UNDETERMINED over this window.** Every support for it was removed in
      sequence — the t-statistic (computed inside a model the data contradicts), then the 5/5
      (non-independent), then the sign test (no discriminating power without a period) — while the
      confidence word "probably real" survived each removal unchanged. That is momentum, not
      evidence, and it was costing nothing to keep, which is exactly why it had to go.
      **Box 3 rests on the FLOOR, not on any of this.**
      **STILL OPEN:** ~35 minutes cannot exclude an hours-scale leak; the card's own observation
      was 2.47 GB at 8h12m against 1.36 GB here. An hour of data is enough to settle it, but state
      that in terms of the FLOOR, not the slope — an earlier version derived it from a
      linear-trend power calculation, which is computing power for a statistic this card has since
      retired as the wrong parameterisation of "leak". Read the FLOOR when the 12 h series lands.
      TRAP, cost one failed start: a `setsid nohup … &` sampler launched from a tool call is
      REAPED with the process group. macOS has no `setsid`; use `scripts_dev/detach-run.py`
      (double-fork) and verify **ppid 1**. Already recorded in LOCAL memory as
      `detach-long-jobs-from-session-lifecycle`.
      **2026-08-23 12:36 — 8h20m READ (501/721 samples, 04:14→12:34): NO LEAK SIGNATURE DOWN TO
      ~0.03 GB/h.** Per-hour floor for pid 21567: 1.167 / 1.188 / 1.225 / 1.173 / 1.151 / 1.143 /
      1.133 / 1.259 / 1.099 GB (verified unchanged when recomputed from the frozen copy); peak flat
      at 1.45–1.63 G. Regressed on the hour: all 9 buckets slope **−0.0045 GB/h**, sensitivity
      ~0.015; the 7 COMPLETE buckets (n≥59, dropping partial 04:00 n=46 / 12:00 n=41, whose unequal
      n biases a minimum high) slope **+0.0001 GB/h**, sensitivity **~0.025 GB/h**. **Quote the
      7-bucket row — it is the weaker claim.** Per this box's own earlier ruling these are
      order-of-magnitude sensitivity floors, NOT calibrated 95% intervals: an hour-minimum is the
      same extreme-value statistic as the block-minimum, and is not t-distributed however many
      buckets there are. *Resolves a leak faster than ~0.03 GB/h; anything slower is invisible* —
      **roughly an order of magnitude** finer than the 65-minute window's 0.3–0.4 (measured ratio
      14×, but two σ̂ at 4 and 5 df make it good to only ~4×; do not quote a two-digit ratio).
      **Corroborated by the card's own scaling law**, which I had and did not use: SE ∝ σ√Δ/T^1.5
      over a 7.69× window predicts 21× ⇒ 0.014–0.019, against 0.025 measured.
      **The first version of this entry said "FLAT FLOOR, STEADY STATE" with no sensitivity at
      all** — a bare null, in the one box whose entire history is four statistics withdrawn for
      exactly that. Corrected within the hour, on review.
      Stays **unticked**: the series is 69.5% complete and the full read is due ~16:13. A partial
      series reported as the settled 12 h result would be the same proxy-for-the-thing substitution
      this card keeps catching.
      Report: `reports/cpu-runaway/20260823_123633+0200-box3-rss-floor-8h20m-partial.md`.
      **CPU: use `cpu_time` (col 5) DELTAS, never the mean of `pct_cpu_1min` (col 4).** True CPU per
      hour is 25.8 / 26.7 / 25.7 / 23.8 / 22.0 / 21.1 / 23.8 / 30.9 / 26.6 **% of one core**;
      **25.1% overall** over 504 intervals — tight 21–31, stable while RSS is flat.
      **VERIFIED FROM THE SAMPLER SOURCE** (`ps -eo pid,etime,%cpu,time,rss,command`; `/bin/ps` is
      BSD here, so the GNU shadowing that affects stat/date does not reach it) **AND TESTED ON THIS
      FILE**: col 4 is not a lifetime average — `100×cputime/elapsed` is nearly flat (27.4→25.8
      across 8.4 h) while col 4 swings 1.5→79.3 between adjacent minutes. Same quantity, different
      estimators — asserted from a column NAME, then adopted from a reviewer, then quoted from a
      remembered man page, and only settled by the test.
      **That test ALSO shows the rate DECLINED, which I first published as "held steady".** Split
      the cumulative figure: the **unsampled** first **5.15 h ran at 27.44%**, the measured 8.44 h
      window at **25.07%**, whole life 25.96%. The early period was 2.4 pt (~9%) hotter. The
      headline survives — it is about a *sustained* ~25–27% and that holds — but the decline is real
      and unexplained, and the period it happened in has no samples.
      Independent closure of the window figure: endpoint arithmetic gives **25.07%** against the
      delta-sum's **25.09%** — 0.03 pt apart by two different methods.
      **Three things I wrote about col 4 are WITHDRAWN**, in order: it does NOT read high in every
      bucket (6 of 9; 07/08/12 read LOW); ">100 proves it is not per-core" is a non-sequitur (col-5
      deltas are thread-summed too); and the replacement claim **"noisy in both directions, not
      biased" was an unsupported NULL** — on all **504 paired observations**, mean(gauge−true) =
      **+2.75 pt, SD 37.08, SE 1.65, t=+1.66, 95% CI [−0.49, +5.98]**. |t|<2, so a high bias is not
      established AND neither is its absence. Autocorrelation was raised and MEASURED, not argued:
      lag-1 ρ=+0.032, AR(1) inflation 1.03×, t 1.66→1.61 — unchanged. Honest wording: **"no bias
      detectable to ±3.4 pt"** (MDE = 1.965 × 1.71).
      **How much the 504-pair test bought over the 9-hour one — both published answers were wrong,
      mine included.** SE is not power: MDE is **3.87 pt** (t_crit 2.306 × SE 1.68) vs **3.36 pt**
      (1.965 × 1.71) ⇒ **≈13% better**, not 98% and not "essentially nothing".
      Also: deltas are exact only with `p` RESET on pid change; carrying it across row 239 divided a
      120 s interval by 60 and understated hour 08 by 0.4 pt (22.4→22.0, n=59 where 58 was right).
      **On the completion time: the sample COUNT was wrong, the TIME was right.** `seq 1 720` ⇒ 721
      ROWS finished, not 721 samples — that stands. But "61.24 s/sample ⇒ ~16:28" is **WITHDRAWN**:
      the true cadence is **60.06 s** (two self-consistent snapshots) and the last row is due
      **~16:14:12**, so the original ~16:13 was right. 61.24 came from dividing the FROZEN file's
      row count by the LIVE file's timestamp — snapshot-mixing, shipped in the very commit that
      added the lesson against it. No rows have been dropped (506 intervals, all 60–61 s), which
      matters because the loop is bounded by ITERATIONS: a missed grep would make 721 rows
      unreachable and hang any row-count precondition.
      **RETRACTS the 65-minute floor trend −0.108 GB/h above.** The 8h20m slope is +0.0001 (7
      complete buckets) — 1000× smaller, opposite sign; sustained, −0.108 drains ~0.9 GB. Like for
      like: both are floor-minima regressions. Third quantity in this box withdrawn for being read
      off too short a window. Quote no floor slope, either direction, from under several hours.
      **GOTCHA — the sampler is not PINNED to a pid; it re-resolves each sample** ("by name" is
      inferred from the shape, not read from the sampler). Row 239 (08:12:47) carries pid 19113 /
      `elapsed=00:00` / 28 MB. **The server did NOT restart — arithmetic, not a single-pair
      inference:** across that row, wall 04:14:33→08:13:47 and pid 21567's own elapsed
      05:08:47→09:08:01 are both exactly 3h59m14s (14,354 s). The old block-minimum command did not
      filter on pid, so one row in 501 (0.2%) produced `block23 min_rss=0.028G` — a fabricated
      collapse shaped exactly like a restart. **A minimum has no resistance to a single outlier by
      construction.** Filter on pid; list pid changes first; and **copy the file before analysing
      it** — the sampler is still appending, and the three reads behind this entry hit 501, 503 and
      508 rows without noticing (commands in the STATE block).
      **⚠ READ `## Approval log` (end of file) BEFORE THIS ENTRY — three of its statements are
      withdrawn there, including "not an outlier artifact" and both later attempts to fix it. This
      pointer is the only body edit made after the card went terminal; it asserts nothing new.**
      **FULL SERIES, 2026-08-23 16:29 — THE BOX'S SETTLED ANSWER. This ticks it.**
      Series complete and clean: **721 rows** (720 data), span 04:14:33→**16:14:14** (43,181 s), 719
      intervals of **679×60 s / 39×61 s / 1×62 s** (mean 60.06 s). Sampler pid 82388 exited. **719
      rows are pid 21567; exactly ONE foreign row** — row 240, 08:12:47, pid 19113, `elapsed=00:00`,
      29,840 kB — excluded from every figure. Predicted last-row time missed by 2 s over 12 h.
      Per-hour floor (pid-filtered), **11 complete buckets n≥59, hours 05–15**, floors **1.0522 –
      1.2594 GB**:
      **OLS −0.01393 GB/h (SE 0.00460)**, Theil–Sen **−0.01481**, and dropping the one high bucket
      (11:00) gives **−0.01525 (SE 0.00157)** — *more* negative and 3× tighter, so it is not an
      outlier artifact. R² 0.505, resid SD 0.048 GB.
      **PIPELINE CHECK — this same code restricted to the partial's own window reproduces the
      published partial to five decimals: 05–11, n=7, +0.00010 GB/h, half-width 0.0245** (published:
      +0.0001, 0.025). So the sign change is not a method change; the hours the partial could not see
      are the hours that carry it. 12–15 alone (n=4) is −0.01127 with half-width 0.0307 — wider than
      its own point estimate, so no single new bucket does it.
      **Sensitivity: half-width 0.010 GB/h vs the partial's 0.025 — 2.4× finer**, and the card's own
      `SE ∝ σ√Δ/T^1.5` scaling had predicted order 0.01 for this window from the 65-min read. **Still
      an order-of-magnitude sensitivity floor, NOT a calibrated 95% interval** — an hour-minimum is an
      extreme-value statistic however many buckets there are. That caveat is not retired by the
      series being complete.
      **The floor did not rise.** The signature this box was posed to detect is absent at ~0.01 GB/h
      over 12 h. The point estimate is negative in all three estimators; **nothing in this series
      identifies why**, and no adjective is attached to it.
      **SCOPE, because this answer is easy to over-read.** It characterises ONE process over ONE 12 h
      window at ~0.01 GB/h. `~/.agentlens/server.log` carries two JS-heap OOM crashes at ~6 GB (pids
      20885, 73785 — neither is 21567), one at 9.25 h uptime, one at **15.6 min**; a 15-minute death
      to 6 GB implies order **23 GB/h**, ~3 orders of magnitude above what this instrument resolves.
      **This series neither observes nor excludes whatever produced those crashes** (provenance
      plausible-but-unverified, wall-clock dates unknown).
      CPU re-derived on the complete file: **25.02% of one core over 718 intervals** (11.99 h wall,
      10,804.3 s CPU) — the partial's 25.1%/504 holds. Its 12:00 bucket was n=41 at 26.6 and
      completes at **25.7** (n=59); 04:00 moves 25.8→25.7 on one added interval. The unsampled first
      5.15 h at 27.44% still has no samples.
      Report: `reports/cpu-runaway/20260823_162921+0200-box3-rss-floor-12h-full.md`.
- [x] A fix lands with a REGRESSION GUARD that fails on the pathological input, not merely a
      measurement showing the number dropped on one run.
      **FIX `581524c`** — `collectFileMeta()` stamped `_fileMetaCacheAt` with a PRE-walk
      `Date.now()`, so the memo's usable life was `TTL − walkDuration`. Once a walk outlives its
      TTL the entry is born expired, and because the replacement walk each miss writes is ALSO
      longer than the TTL, the collapse is **self-sustaining**: N probe candidates cost N full
      recursive readdir+stat passes, for any N. Stamp taken after the walk.
      **GUARD `ab02e17`** — and the first guard was not good enough. The 2500 ms stall injects the
      delay INSIDE the walk, so inflating `walkDuration` and then moving the stamp past it share
      one primitive; that experiment **could not fail**, and showed the guard sensitive to the knob
      the fix turns rather than showing the fix. The settling test reaches `walkDuration > TTL`
      from the **corpus** side instead — 6000 files, 3 ms TTL, **no injected stall anywhere**:
      red on the pre-walk stamp with "got 6" (walk 27.6–31.6 ms), green after, 3/3 each way.
      It also refuses to pass vacuously — it asserts the walk really did exceed the TTL, so a
      machine fast enough to walk 6000 files in under 3 ms turns it red with "raise N".
      **A review proposed a different settling test (TTL = 1 ms, no stall, on the 5-file fixture)
      and it was VACUOUS**: a real walk over 5 files here is 0.04–0.09 ms, so the entry is not born
      expired, the OLD code passes too — and under that proposal's own criterion ("green on both
      means the mechanism story is wrong") shipping it unmeasured would have argued a real bug away.
      **CONSUMERS OF THE LOOSENED STALENESS BOUND, enumerated rather than asserted** (the previous
      claim named the batch-loader and then did not analyse it): `standalone/server.ts:1888` is the
      startup batch — it runs once at boot behind a `restoredFromDisk` early-return, on a **cold**
      cache, so there is no entry to be stale; `src/cli/searchCli.ts:126` is a one-shot CLI in a
      fresh process, likewise cold; `transcriptPathFor`/`reparseSession` are the probe itself, which
      re-runs every request. And the bound that loosened was never being delivered: the old lifetime
      `TTL − walkDuration` is *smaller* than TTL and shrank as the corpus grew, so no consumer was
      receiving the tight freshness the comment defended.
      **STILL UNFIXED, and it is the actual runaway:** this removes an amplifier, not the source.
      147 `check_cache_expiry` calls/hour each pay ONE full 14,509-file walk even when the memo
      works perfectly. The shape that follows — memoize the ANSWER (the tool reports against a
      60-minute TTL) plus abandon server work on client disconnect — changes observable behaviour
      and is **proposal only, pending the user**.
- [x] The 96%-disk observation is either attributed to the server or explicitly excluded, with the
      measurement that decided it.
      2026-08-23: **EXCLUDED.** The server's ENTIRE data dir `~/.agentlens` is **6.2 GB** — 0.33%
      of a 1.9 TB volume; it cannot produce a 96% figure. This repo's `rust-core/target` is
      **69 GB**, 11× the server's whole footprint, and the card recorded it at 41 GB on 2026-08-20
      — so the build cache grew 28 GB in three days while the server held 6.2 GB. The volume has
      also recovered on its own to 90% / 202 GB free with no server change, which a server-caused
      figure would not do. Measurement:
      `reports/cpu-runaway/20260823_041540+0200-box5-disk-attribution.md`.
      (Noted, not acted on: `store.old-v0` (270 MB) looks like a stale migration artifact.)

## Notes

- Reproduce against a server started on a SCRATCH `--data-dir`, never `~/.agentlens` — one data dir
  admits exactly one server, and pointing a second one at the live store is how the store gets
  corrupted.
- The measurement above was taken from a `ps` SNAPSHOT written to a file and then searched, never a
  live `pgrep`/`ps | grep` pipeline (which matches its own shell and reports a false positive).

## Approval log

- 2026-08-23T16:29:00+0200 — COMPLETED. The 12 h RSS series finished at 16:14:14 with all 721 rows;
  the pid-filtered floor read ran on the complete file and box 3 — the last open box — is ticked
  (5/5). USER directed the close in the same instruction that carried the reading protocol: *"if box
  3 ticks the card is complete, since the unfixed runaway is TRDD-YST9ZJ90's card."* The remaining
  fix work is `TRDD-YST9ZJ90` (`design/proposals/`, tier 2, awaiting USER), not this card.
- 2026-08-23T16:47:00+0200 — **QUALIFICATION on the closing claim, from the adversarial review of the
  closing commit `f9cb8aa`.** Appended here rather than into the body because the card is terminal
  and `## Approval log` is the append-only exempt channel. **The tick STANDS; three of its published
  statements do not, and one criterion was silently reworded.**
  1. **THE CARD'S OWN FAILURE SHAPE, FRESH INSTANCE — a proxy published without the precondition
     that makes it a proxy.** The hour-floor is a valid leak proxy only **at constant workload**. I
     measured, in the same read, that CPU fell 26.7%→19.6% across the same 11 buckets (**−27%
     relative**), and that the *whole* distribution moved down with it (mean 1.366→1.276, peak
     1.591→1.456) — then published the floor slope without connecting the two. A real +0.01 GB/h
     leak inside a −0.025 GB/h load-driven decline reads out as −0.014, the measured value.
     Settling test run: **r(floor, CPU) = +0.390, n=11, +0.0079 GB per CPU-point** — under the
     |r| ≳ 0.6 that would make the confound plainly live, but at n=11 its 95% band is ~[−0.26,
     +0.79], so **it neither establishes nor excludes the confound**; and floor tracks CPU more
     closely than mean (+0.242) or peak (+0.101) does. **So "no rise at ~0.01 GB/h" bounds NET
     DRIFT at a workload that fell 27% — it is NOT a leak bound at constant load.**
  2. **"not an outlier artifact" is WITHDRAWN as stated** — a smuggled verdict word resting on
     backwards evidence. 11:00 is the one bucket *opposing* the slope, so dropping it must make the
     slope more negative and tighter; that is arithmetic, not robustness, and its **SE 0.00157 must
     never be quoted as the sensitivity**. The real evidence is Theil–Sen (−0.0148, all 11 points,
     resistant by construction) landing within 0.001 of OLS.
  3. **The pipeline check is a REGRESSION check, not an independent one** — same file, same rows,
     same estimator family, so agreement was near-certain by construction. It licenses exactly the
     narrow claim made on the card ("the sign change is not a method change") and nothing more; the
     report's "validating my whole pipeline" over-read it and is corrected there.
  4. **The box asked "steady-state OR leak" and got NEITHER — say so rather than let
     "characterised" stand.** A floor moving ~0.17 GB over 12 h is not steady state, and nothing
     rose, and nothing in the data explains the decline. The tick is on a **reworded criterion**: a
     leak is excluded at a stated sensitivity, under a stated load qualification. That is a real
     answer and it is why the tick stands — but it is not the binary the box's text asks for, and a
     reader who takes "characterised" at face value will over-read it.
  Corrections landed in `reports/cpu-runaway/20260823_162921+0200-box3-rss-floor-12h-full.md`.
- 2026-08-23T17:05:00+0200 — **POINT 1 ABOVE IS WITHDRAWN. The correction was itself the card's
  failure shape.** A second adversarial review attacked the qualification and was right; I measured
  it first-hand before accepting.
  **"The workload fell 27%" was ENDPOINT ARITHMETIC on a series with no trend.** Measured over the
  same 11 buckets: **CPU ~ hour = −0.0248 pt/h, r = −0.026, SD 3.22 pt.** The 27% was 26.7→19.6,
  first bucket to last, where 15:00's 19.6 is the minimum of all 13 buckets and 16:00 — which I had
  printed and did not mention — bounces back to 29.9. **A first-and-last difference standing in for
  a slope is the same shape this card withdrew a statistic for once already**, and I reproduced it
  in the very entry correcting a proxy read.
  **The decomposition, which I had every number for and did not run:** floor~hour simple
  **−0.01393**, floor~hour **controlling for CPU −0.01375** (CPU coef +0.0075 GB/pt) → **the CPU
  variation explains 1.3% of the slope. THE CONFOUND IS NOT LIVE.** A confounder must correlate with
  the exposure (time) as well as the outcome; CPU does not. I ran a bare correlation instead, got an
  ambiguous r = +0.390, and published a hedge on it — and with CPU~hour ≈ 0 that correlation is
  nearly orthogonal to the time trend, so it never could have settled the question.
  **The evidence in fact runs the OTHER way:** mean RSS falls near-monotonically (**−0.01008 GB/h,
  r = −0.875**) while CPU has no trend at all — evidence *against* a load-driven decline, from the
  same two tables I read as evidence for it.
  **Also withdrawn: the r-ordering as "weak directional support."** At n=11 the Fisher-z SE is
  1/√8 = 0.354, so +0.390 / +0.242 / +0.101 are mutually indistinguishable and none differs from
  zero; and a load mechanism would move peak and mean most and the post-GC floor least, so the
  ordering points against the confound if it points anywhere.
  **Lesson recorded rather than buried: I published a 95% band ([−0.26, +0.79]) I had NOT computed**,
  inside a correction whose thesis is that numbers ship with their derivation. Computed properly it
  is [−0.274, +0.802] — close enough that nothing downstream moved, which is exactly why the habit
  survives review. The derivation is the deliverable, not the digits.
  **NET EFFECT ON THE TICK: it stands, and on the STRONGER reading.** With the confound tested and
  dismissed, −0.014 GB/h is a **leak bound at ~0.01 GB/h**, not merely a net-drift bound. Points 2,
  3 and 4 of the previous entry are unaffected and stand.
  **The honest residual limit that replaces the withdrawn one:** CPU is the only workload proxy this
  frozen file carries; it shows no trend, so the confound asserted on it is withdrawn — whether some
  *unmeasured* load dimension trended is unknown and this file cannot answer it.
- 2026-08-23T17:22:00+0200 — **FINAL ENTRY. "THE CONFOUND IS NOT LIVE" (previous entry) IS ITSELF
  WITHDRAWN, and this closes the correction chain.** Measured first-hand before accepting.
  **The 1.3% rests entirely on a slope whose SE is 13× its own magnitude.**
  `CPU~hour = −0.0248 ± 0.3237 pt/h, 95% [−0.757, +0.707]`. Propagating that interval through the
  same decomposition, **the confound share ranges −38% … +41%** — point estimate +1.3%. **So the
  test can neither establish nor exclude the confound.** Round 2's specific claim still dies, but on
  its own false premise (a "27% decline" that was endpoint subtraction on a trendless series), not
  on this test. **This was the card's already-withdrawn "not biased" move — an unsupported null
  replacing an unsupported positive — reproduced one entry after quoting the lesson that names it.**
  **THE ONE NUMBER I HAD NEVER PUBLISHED WITH ITS OWN VARIANCE, and the point of this entry:**
  `floor~hour = −0.01393 ± 0.00460 GB/h, 95% [−0.0243, −0.0035], r = −0.711, n=11.`
  **ALSO WITHDRAWN:** (a) the r-ordering as directional support — floor/mean/peak over the same
  buckets are *dependent* correlations, so marginal Fisher-z SEs are the wrong comparison and at
  n=11 the right one (Steiger) has no power either; (b) citing **mean RSS** (−0.01008 GB/h,
  r = −0.875) as corroboration — this box's own text says *the discriminator is the sawtooth FLOOR,
  not the mean*, and a statistic cannot be rejected as an instrument and quoted as support in the
  same document; (c) **"a leak bound at ~0.01 GB/h"** — dismissing one confound does not license it.
  That upgrade additionally needs GC completing within every bucket, no heap-limit compaction,
  stationarity in unmeasured load, a window long against any allocation cycle, and RSS tracking
  retention at all (it carries native buffers, mmap and fragmentation; malloc and V8 release pages
  asynchronously). **None of the five is checkable from this file.**
  **BOX 3'S ANSWER, FINAL FORM — the residual uncertainty, published once:** *−0.014 ± 0.005 GB/h
  bounds the OBSERVED FLOOR DRIFT over these 12 h at n=11. No rising floor is visible at ~0.01 GB/h.
  Calling that a leak bound needs assumptions this file cannot check; calling it confound-free needs
  a CPU-trend precision this file does not have.* **The tick stands on THAT, and on nothing stronger.**
  What would close the residual: a request-rate or GC-count series from the server's own logs over
  this same window — CPU%-of-core proxies compute, not allocation.
  **META, and the reason this is the last entry.** Three rounds, each correcting the last, each
  shipping a fresh instance of the same defect. The card's standing lesson says *publish the number
  with its derivation and its n*; I was publishing the number with its derivation and **without its
  variance** — the same failure in a better disguise. The fix is not a better fourth correction, it
  is to publish the uncertainty and stop. **Correction chain CLOSED.** Any further finding is a new
  TRDD, not a fifth append; three rounds of log-only correction reached its limit, which is why a
  single navigational pointer (asserting nothing) was added at the box-3 entry.
