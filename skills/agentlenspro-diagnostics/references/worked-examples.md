# agentlenspro-diagnostics — Worked examples

> Reference file, read on demand from [../SKILL.md](../SKILL.md). Section names in **bold** that
> are not in this file are listed, with the file that holds them, in that index.

## Worked examples

**1 — "I am an AGENT about to orchestrate a batch of sub-agents / a scenario suite, and it must
stop itself before it drains the window."** ← the flagship case

This is the full loop, and it is the scenario this skill exists for. You are the orchestrator; the
batch is expensive; nobody is watching.

```bash
# 1. PREFLIGHT — do not launch anything until this says go.
agentlenspro budget --minutes 90            # exit 0 = go · 1 = do NOT start · 2 = cannot project
```

```
# 2. ARM — one Monitor covers the budget verdict AND the realtime burn risks.
Monitor(command: "agentlenspro budget --minutes 90 --watch 120 --with-risks",
        description: "budget+guard — scenario suite", timeout_ms: 1800000)
```

A Monitor watch always has a deadline (30 minutes max, 10 in `-p` runs — a `-p` run needs roughly
3x the re-arms of an interactive one for the same batch length) — it cannot run unattended for a
90-minute batch. It notifies you when it times out; **re-arm with the time still left, not the
original figure** — `--minutes N` counts from THIS invocation's own start (`t0`), so replaying
`--minutes 90` after 30 minutes have already elapsed tells `budget` the run needs 90 *more*
minutes and silently adds the elapsed time back on. Re-arm as `agentlenspro budget --minutes 60
--watch 120 --with-risks` (90 minus the 30 already spent), shrinking N on each re-arm. The guard
sees nothing in the gap between one watch's deadline and the next re-arm — that window is blind.

**3. React to what arrives on that stream — each line means something different:**

| Line | What it means | Do |
|---|---|---|
| `[budget] ABORT — … — who: proj (sess, rate, share)` | the window will run out before the batch finishes, **and the line names the workdirs draining it** | **stop launching, kill the batch.** The command has already exited 1. If the top culprit is NOT your project, the drain is someone else's — killing your batch may not be the fix |
| `[budget] TIGHT — … — who: …` | it fits, but under the safety margin | stop *adding* work; let what is running finish. Check whether the named culprit is yours |
| `[burn-guard] FANOUT_BURST` / `RUNAWAY_FANOUT` | too many sub-agents launched too fast | pause launching; let the wave settle |
| `[burn-guard] CACHE_THRASH` | the CALLER's prefix is being re-billed every turn | fix the source first (`investigate_burn --windowHours 1`); launches are not the cause, but every new agent rides a prefix that is about to break again — hold them until it is fixed |
| `[burn-guard] COLD_RESUME_RISK` | a rate-limit stall just ended | warm with ONE agent before resuming the fan-out |
| nothing for a long time | normal — it is silent until something changes | no action |

**4. TaskStop the monitor when the batch ends** — otherwise it keeps emitting until its own
30-minute deadline, then notifies you to re-arm it (a 90-minute interactive batch needs 2-3
re-arms; a `-p` run, capped at 10 minutes per watch, needs about 9). It sees nothing in the gap
between one deadline and the next re-arm.

**Two things this does NOT do, so plan for them:**
- **It cannot stop your batch.** AgentlensPro measures and decides; it does not own your process
  tree. Wire `budget --watch`'s **non-zero exit to your own kill path** — that IS the mechanism.
- The **burn-gate** (`--install-hooks`) denies only the four measured disaster launches. It will
  never stop a well-behaved batch that is merely too long. That is what `budget` is for.

**2 — "Something is eating the window right now."**

```bash
agentlenspro --risk                                 # 1. WHO — 40ms, only the ACTIVE risks
agentlenspro investigate_burn --windowHours 1       # 2. WHY — ranked causes with evidence
agentlenspro get_skill_attribution --window 6       # 3. WHICH skill/plugin, if that is the shape
```

**Read it in that order, and stop as soon as you have the culprit.** `--risk` names the session,
workspace and model in each line, so it often ends the investigation by itself.

`investigate_burn` returns `verdict` (read this first — it is a plain sentence naming the culprits),
`findings` (ranked, each with its evidence), `attribution` (by workspace) and `totals`.

> **It is a FORENSIC tool: it reads raw request/response bodies off disk, so it is only as good as
> the capture.** If `coverage.blind` is set (or the verdict starts with `BLIND`), it saw NOTHING —
> that is an absence of DATA, never evidence that nothing burned. `coverage.dirsScanned` /
> `dirsMissing` tell you where it looked. Run
> `agentlenspro setup` (it wires raw-body capture), and meanwhile use **`agentlenspro --risk`** and
> **`get_burn_status`** — they read the LIVE feed and never go blind. Never close an investigation
> on a blind result: a `--windowHours 1` scan once reported "nothing burned here" while
> `get_burn_status` showed 2.3M tokens/min, because it was reading the wrong directory
> (fixed in 2.11.3 — but capture can still be off, and the window can still predate it).

The finding codes tell you what to change:

| Finding | What actually happened | Fix |
|---|---|---|
| `FORK_STORM` | forks of a fat parent into a cold cache — each re-pays the whole prefix | compact the parent first, or stop forking it |
| `SUBAGENT_BOOT_TAX` | many short-lived agents, each paying its own boot | fewer, longer-lived agents |
| `PREMIUM_MODEL_FANOUT` | an expensive default model across a fan-out | pin a cheaper model for the bulk work |
| `FAT_SESSION_REWRITES` | one huge session re-writing its prefix | `/clear` or compact — see the Cache TTL section |
| `IDLE_FLEET_KEEPWARM` | agents kept warm doing nothing | shut the idle ones down |
| `IMAGE_BLOB_RESIDENT` | screenshots riding forward in context every turn | analyze images in a sub-agent, or compact immediately |
| `RATE_LIMIT_COLD_RESUME` | a fan-out resumed into a dead cache after a stall | warm with ONE agent, then ramp |

⚠️ `get_skill_attribution` counts each message **once**; a naive sum over the same rows
over-counts 2–5×. Read `duplicateRowsSkipped` if the number looks too small — that is the
correction, not a loss. Also check `pricedMessages` vs `attributedMessages` for coverage.

**3 — "Alert me whenever cache-creation spikes in this session."**

```bash
agentlenspro watch --metric cache-create --session <id> --mode rate --threshold 50000
```

You get `PEAK-START` when it crosses, then silence, then `PEAK … max N/min over 3m` when it falls
back — that pair is one spike. **Silence between them is the design**, not a stall.

**Every peak names WHO caused it**, because "cache-create hit 2M/min" without a culprit just
starts a second investigation:

```
[watch] PEAK-START tokens-per-min total = 5.61M (>= 1) — who: alpha-service (aaaa1111, 1.3M/min,
47%) · beta-service (bbbb2222, 865k/min, 31%) · gamma-tools (cccc3333, 613k/min, 22%)
```

Each entry is `project (session, rate, share of machine total)`, heaviest first, and the session
you are watching is tagged **`←THIS`** — so "is it my project, a sub-agent, or another workdir?"
is answered in the alert itself, without comparing ids by eye. Attribution is **additive**: if the
feed cannot name anyone, the peak line still fires without it.

- **`rate`, not `total`** — a cumulative total crosses once and can never cross back, so `total`
  can only ever fire a single alert. The watch warns you at arm time if you ask for it anyway.
- **Sizing the threshold:** run once with `--every --for 5` to see the normal range, then set the
  threshold above it. A threshold under the noise floor produces one permanent excursion.
- **Widen `--hysteresis`** (e.g. `0.7`) if a jittery metric opens and closes repeatedly.

**4 — "How much has THIS run cost so far?"**

```bash
agentlenspro watch --metric cost --session <id> --mode since --every --interval 60 --for 90
```

`since` with no `--since` baselines at the moment the watch starts — which is exactly what "this
run" means. Every line is the delta since then, not the session lifetime.

- Want the lifetime instead? `--mode total`.
- Want a number for a run that **already started**? `--since <ISO>` — but only for
  `input`/`output`/`cache-read`/`cache-create`/`tokens`. `cost` is refused for a past instant
  because per-message pricing is not recoverable from the transcript slice, and a token count
  wearing a dollar sign would be a fabricated figure.
- One-shot alternative, no watching: `get_cost_rollup --groupBy session --windowHours 2`.

**5 — "Keep a durable record for a long unattended run."**

```bash
agentlenspro watch --metric tokens-per-min --threshold 2000000 \
  --log ~/logs/burn.log --flush-ms 1000 --for 480
```

The log mirrors stdout exactly, so the file is what you saw. Add `--json` for one object per line
if something downstream parses it.

- **`--flush-ms 1000`** coalesces writes so a multi-day watch does not grind the SSD. At most 1s of
  lines is lost to an unclean kill; a line is never half-written. `--flush-ms 0` writes through if
  you would rather trade the wear.
- **Ctrl-C flushes and exits** normally — the buffered tail still lands.
- **Rotation is not built in.** The file grows without bound; hand it to `logrotate` or point
  `--log` at a fresh path per run.
- Pair it with `--for` so an unattended watch has a definite end.

**6 — "Post-mortem: my window ran out an hour ago."**

```bash
agentlenspro get_rate_limit_report                  # 1. the stall episodes + what filled the window
agentlenspro investigate_burn --windowHours 5 --untilIso <when-it-drained>   # 2. ranked causes THEN
agentlenspro get_account_burners --account previous # 3. only if the account rotated
```

`get_rate_limit_report` gives `episodes` (the stalls, with sessions/workspaces/errors) and
`attributed` — the newest episode's window broken down by exact billed usage. `--untilIso` on
`investigate_burn` is what moves the analysis back to the drain instead of now; without it you are
investigating a window that has already rolled.

`get_account_burners` is for **after a rotation**: it marks `mostLikelyExhausted` with an
`exhaustionReason`, and splits cross-rotation sessions between accounts by time. If you have not
rotated, skip it — the first two commands are the answer.

