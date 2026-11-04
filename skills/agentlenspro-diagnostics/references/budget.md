# agentlenspro-diagnostics — Budgeting a timed run

> Reference file, read on demand from [../SKILL.md](../SKILL.md). Section names in **bold** that
> are not in this file are listed, with the file that holds them, in that index.

## Budgeting a timed run — will this batch outlive the window? (preflight → watch → abort)

A long batch — a scenario-test round, a fan-out, an audit sweep — has ONE question behind it:
**does the run finish before the rate-limit window does?** The guard alone cannot answer it:
`BURN_SPIKE` fires on *rate*, and its own message says `Window time-left unavailable (capacity not
configured)` unless `AGENTLENS_WINDOW_5H_TOKENS`/`_7D_TOKENS` are calibrated. `get_window_eta`
answers it regardless, because it projects on **cost** (Anthropic meters the windows by cost, not
tokens) and falls back to a same-plan account's observed capacity — always labeled, never guessed.

**The whole workflow is one command — `agentlenspro budget`.** It wraps the preflight, the
verdict, the abort condition and (optionally) the burn guard, and **its exit code is the
interface**: `0` go · `1` ABORT · `2` cannot project. Everything below explains what it decides
and how to fall back to the raw tools; you do not have to assemble it by hand.

```bash
agentlenspro budget --minutes 90                          # preflight: one line, one exit code
agentlenspro budget --hours 2 --watch 120 --with-risks    # arm for the whole run (Monitor-friendly)
agentlenspro budget --minutes 90 --json                   # machine-readable
```

| flag | meaning |
|---|---|
| `--minutes N` / `--hours H` | how long the run needs (**required** — a budget with no duration has no question to answer) |
| `--window 5h\|7d\|binding` | which window must survive it; default `binding` = whichever the payload says runs out first |
| `--margin M` | GO requires `ETA ≥ remaining × M` (default `2`); values below 1 are clamped, so a margin can never make an abort look safe |
| `--watch [SEC]` | keep watching (default 60s). **The minutes still to go derive from t0**, so the check sharpens by itself and exits `1` the moment the verdict turns NO-GO |
| `--with-risks` | fold `[burn-guard]` risk transitions into the same stdout stream — **one Monitor covers both** |
| `--rate-window-min N` | minutes of history the $/min rate is measured over (default 30) |

That last point is why this is a command and not a snippet: a hand-rolled loop makes the caller
re-supply "minutes left" at every checkpoint, and a stale value keeps saying GO for the whole run —
exactly the case the check existed to catch.

**1 — Preflight, BEFORE the first launch.** `agentlenspro budget --minutes 90` answers it
outright. To see the underlying numbers, or to add a cost estimate:

```bash
agentlenspro get_window_eta --rate_window_min 30   # read `text`: $/min · ETA · which window EXHAUSTS FIRST
agentlenspro predict_session_cost --task "<the batch you are about to run>"   # p75 = budget-safe
```

Decision rule — the same one `budget` applies, comparing the window's ETA to the run's duration:

| ETA vs expected duration | do |
|---|---|
| `willExhaustAtCurrentRate: false` ("won't exhaust at this rate") | **GO** — the rolling window plateaus below the cap |
| ETA > 2× duration | **GO** |
| ETA 1–2× duration | GO, but arm the guard (step 2) and re-check at every checkpoint (step 3) |
| ETA < duration | **DO NOT START** — wait for the window to roll, or cut the batch down |

Read `capacity.source` before trusting the threshold: `observed` = this account's own calibration
(trust it); `same-plan-proxy` = another account on the same plan (order-of-magnitude — treat the
boundary as soft and leave margin); absent = no ETA is projected at all, calibrate first.
`bindingWindow` is a plain string (`"5h"` or `"7d"`) naming which window binds — check it, because
a 90-minute batch is usually bounded by the 5h window even when the 7d one exhausts sooner overall.

**2 — Arm the guard for the whole run** (one stdout line per risk TRANSITION, so it interrupts you
rather than needing to be polled):

```
Monitor(command: "agentlenspro budget --hours 2 --watch 120 --with-risks", description: "budget+guard — <batch name>", timeout_ms: 1800000)
```

One Monitor, both signals: `[budget]` verdict transitions **and** `[burn-guard]` risk transitions
on the same stream, silent while nothing changes. (Arming only the guard —
`agentlenspro --guard 15` — is still correct when there is no fixed run length to budget against.)

**Every watch ends after at most 30 minutes** (10 in a `-p` run — roughly 3x the re-arms for the
same batch length) — Claude Code notifies you when it does; **re-arm with the minutes still
left, not the original figure**. `--hours 2` / `--minutes N` count from THIS invocation's own
`t0`, so replaying the same flag after time has already passed tells `budget` the run still
needs that much *more* time and double-counts what already elapsed. A 2-hour interactive batch
needs 3-4 re-arms this way, each with a smaller N. The guard sees nothing between one watch's
deadline and the next re-arm — that gap is blind. **`TaskStop` it early when the batch finishes**,
so a guard armed for a short run doesn't keep emitting until its own deadline. If Monitor is unavailable in this environment (see
the guard section above), fold `agentlenspro --risk` into the step-3 checkpoint loop instead.

**3 — Re-check at checkpoints, not just at the start.** The $/min at minute 0 is not the $/min at
minute 40 — one fan-out moves it by an order of magnitude. Re-run `get_window_eta` after each phase
(and on every `BURN_SPIKE` the guard emits) and re-apply the table above.

`agentlenspro budget --minutes N --watch [SEC]` IS this loop — it re-derives the remaining time
from t0 itself and exits `1` on NO-GO, so wire its non-zero exit to however your harness
terminates. The equivalent hand-rolled form, for a harness that cannot shell out to the CLI
(swap `fiveHour` → `sevenDay` to bind on the weekly window):

```bash
RUN_MIN_LEFT=90          # minutes of batch still to go — update at each phase
while sleep 120; do
  agentlenspro get_window_eta --full 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const w=JSON.parse(s).fiveHour;
      if(!w.willExhaustAtCurrentRate) process.exit(0);          // plateaus below cap — fine
      if(w.etaMinutes==null) process.exit(0);                   // no capacity ⇒ no ETA; never guess
      const left=Number(process.argv[1]);
      if(w.etaMinutes < left){
        console.error(`[abort] 5h window exhausts in ${w.etaHuman} < ${left}m of run left`);
        process.exit(1);
      }
    })' "$RUN_MIN_LEFT" || break     # non-zero ⇒ stop the batch
done
```

Keep the pipe direct, as written. Capturing the JSON into a shell variable first and replaying it
with `echo "$J"` **corrupts it under zsh**, whose builtin `echo` expands `\n` by default — the
escaped newlines inside the `text` field become real ones and `JSON.parse` dies on "Bad control
character in string literal". Use `printf '%s'` if a variable is unavoidable.

**4 — The abort itself is YOURS. Know what each brake does and does not do:**

| lever | what it actually does |
|---|---|
| your runner, driven by `budget --watch`'s exit code | **the only thing that can stop your batch.** AgentlensPro measures and decides; it does not own your process tree. `budget --watch` exits `1` at the abort point — wiring that to your kill path is the whole mechanism |
| burn-gate at `gate=enforce` (the default; `agentlenspro --hooks` shows it) | DENIES agent launches matching the **four measured disaster signatures** — THRASH_ACTIVE, RUNAWAY_FANOUT, COLD_RESUME_FANOUT, FORK_STORM_FORMING. That is disaster prevention, **not** a window budget: it will never stop a well-behaved run that is simply too long |
| `agentlenspro --hooks gate=warn` | the opposite of a brake — loosens the gate for a legitimate mass fan-out. Restore to `enforce` after |
| `agentlenspro disable` | stops AgentlensPro **storing** telemetry, raw bodies and hook events (the status line keeps being stored); the hooks and the burn-gate stay on, and it does **not** stop your burn (see Emergency stop above) |

So a batch that must be able to abort itself needs the stop condition in **its own loop** — the
snippet in step 3 is that loop; wire its non-zero exit to however your harness terminates.

**5 — After the run, attribute what it cost:** `get_cost_rollup --groupBy subagent --windowHours
<run length>` for the per-agent bill, and if the window did drain, `get_rate_limit_report` (what
exactly filled it) or `investigate_burn --windowHours 5` (ranked causes with evidence).

