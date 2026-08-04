---
name: agentlenspro-diagnostics
description: >-
  Query AgentlensPro token/cost forensics from any project via the single global agentlenspro executable — use when
  a session is burning tokens, a rate-limit window drains too fast, the prompt cache keeps
  breaking, you need the cost of a session / heartbeat / sub-agent fleet, or any "why is this so
  expensive" question. GUARD in realtime with check_burn_risk / `--guard` (arm in a background
  monitor BEFORE agent fan-outs: warns on fan-out bursts, cold-resume risk after a rate-limit
  stall, compaction rewrites, huge-request bursts, burn spikes, and CACHE_THRASH — the prefix
  being re-written every turn instead of read). PREVENT with the burn-gate hooks
  (--install-hooks): a PreToolUse gate on agent-launch tools DENIES the four measured disaster
  launches with the reason fed back to the agent. BUDGET a timed run with ONE command —
  `agentlenspro budget --minutes N [--watch] [--with-risks]` answers "will this test round / batch /
  fan-out exhaust the 5h window before it finishes, and how do I abort it if the burn rate says
  yes": exit 0 go / 1 ABORT / 2 cannot project, the remaining time re-derived from t0 as the run
  proceeds, and the burn guard folded into the same stream so ONE monitor covers both. WATCH any
  single metric for PEAKS without ever stopping — `agentlenspro watch --metric <input|output|
  cache-read|cache-create|tokens|cost|turns|pct-5h|pct-7d|cost-5h|cost-7d|cost-per-min|
  tokens-per-min|active-sessions> --mode total|rate|since --threshold N`, reporting each
  excursion's maximum and duration, with SSD-friendly coalesced logging (--log/--flush-ms).
  Covers the full diagnostic-tool suite — run
  `list --desc` for the live set (burn status, session burn profile, per-agent exact tokens, interval cost rollups, rate-limit forensics,
  account/plan + window budget,
  cache-break causes/timeline, expensive writes, heartbeat cost, config comparison, SQL
  analytics). START with investigate_burn — the ONE-command investigation that names the
  window-burn culprits (fork storms, premium-model fan-outs, idle-fleet keep-warm, image
  residency) ranked with evidence; if it reports BLIND it saw no raw bodies, so fall back to
  --risk / get_burn_status, which read the live feed. Also the operations surface: the one-command idempotent
  installer/repairer (`agentlenspro setup [--dry-run] [--yes]` — detect, converge, verify each
  step, self-test), server control (`server start|stop|restart|status [--supervise]`), open the
  dashboard (`dashboard`), (re)install this skill (--install-skill), and wire/unwire Claude Code
  capture — telemetry env vars (--install-otel / --uninstall-otel) and lifecycle hook events
  (--install-hooks / --uninstall-hooks). Two server-independent local commands round it out:
  `agentlenspro config` (persist the data-retention knobs to ~/.agentlens/config.json — survives
  uninstall/upgrade; env var > file > default) and `agentlenspro env` (detect the runtime
  environment — terminal kind by process ancestry, OS, Claude Code / ai-maestro / CI / container /
  worktree context, user, network + VPN, cloud, tooling, MCP servers — one facet or one big JSON report).
---

# AgentlensPro diagnostics via the global CLI

`agentlenspro` is a PATH binary installed with the **agentlenspro** package (npm global,
npx, or Homebrew — whichever install method put it on PATH) and works from **any** project
directory. This skill deliberately relies ONLY on PATH binaries — it ships no scripts and never
references package-internal or repository paths, because the package layout differs per install
method and the CLI resolves its own package resources internally. The AgentlensPro MCP server
is deliberately NOT registered anywhere: resident MCP schemas cost ~8k tokens on every turn and
toolset changes break the prompt-cache prefix. The CLI costs zero resident tokens; its
subcommands, flags, and help come from the server's own live schemas, so it is never stale.

If `agentlenspro` is not on PATH, (re)install the package — `npm install -g agentlenspro`
(or the Homebrew formula; developers working from a checkout use `npm link`). This skill never
installs the server itself; the CLI starts it on demand.

## Version floor — check this FIRST if a command is "unknown"

This document describes **agentlenspro 2.21.0+**. `statusline-history` and its `--project` flag do
not exist before **2.21.0**; the `budget` and `watch` commands and the `get_lifecycle_events` /
`get_cache_risk_costs` / `get_skill_attribution` / `get_loaded_plugin_versions` tools do not exist
before 2.11.0 — on an older install they fail as an unknown command or unknown tool, which reads
like a broken skill rather than an old binary.

```bash
agentlenspro --version          # < 2.21.0 ⇒ npm install -g agentlenspro@latest
```

If a Claude session cannot see this skill's newest content, that session loaded the skill at
startup: run **`/reload-skills`**. This is a standalone skill, so **`/reload-plugins` will NOT
refresh it** — the two reload paths are distinct.

## START HERE — route your question to one command

Read this table first. Most questions are answered by ONE command; the rest of this document is
reference for when that command's output needs interpreting.

| Your question, in the words you would use | Command |
|---|---|
| "Something is burning tokens RIGHT NOW — what?" | `agentlenspro --risk` (~40ms) then `investigate_burn` |
| "My window drained. What used it, and who?" | `agentlenspro investigate_burn --windowHours 5` (if it answers `BLIND`, it read no raw bodies — use `--risk` / `get_burn_status`) |
| "Will this test round / batch / fan-out fit in the window? Should I even start?" | `agentlenspro budget --minutes N` |
| "Run my batch and STOP it if the window won't survive" | `agentlenspro budget --minutes N --watch --with-risks` (exit 1 = abort) |
| "Tell me whenever <metric> spikes, and keep telling me" | `agentlenspro watch --metric <m> --threshold N` |
| "How much has THIS run consumed so far?" | `agentlenspro watch --metric <m> --mode since --every` |
| "Am I about to do something that explodes?" (fan-out, workflow) | arm `agentlenspro --guard 15` in a Monitor first |
| "Did that compaction / command / turn cost me a cache miss?" | `agentlenspro get_cache_event_log` — the per-call ledger: the costliest call with the calls before and after it, buckets spelled out, 🔥×1-5 by write magnitude |
| "How full are my 5h / 7d windows, really?" | `agentlenspro get_subscription_usage` — **Anthropic's own numbers** (what `/usage` shows), not a local projection |
| "What is running in THIS project — which sessions, on what model, how full, how much spent?" | `agentlenspro statusline-history project` (self-scoping to the cwd; add `--json` for every field) |
| "How full is a LIVE subagent's context?" | `agentlenspro statusline-history subagents --project` — the only surface that publishes per-agent `tokenCount` vs its own window |
| "Why is this ONE session so expensive?" | `get_session_burn_profile --sessionId <id>` |
| "What exactly did agent X consume?" | `get_agent_tokens --agentId <id>` |
| "What keeps breaking my prompt cache?" | `get_cache_break_causes`, then `get_cache_break_timeline --sessionId <id>` |
| "Which skill or plugin is spending the money?" | `get_skill_attribution` |
| "How long until my account's window runs out?" | `get_window_eta` |
| "What is even IN my context, and what did it cost?" | `get_context_composition --sessionId <id>` |
| "Which model/plan am I on; how full are the windows?" | `get_account_status` |
| "Where does EVERY account stand — should I rotate, and onto which one?" | `agentlenspro get_account_status --all` — reads only files, so it **answers with the server down** |
| "Is this session running stale plugin code?" | `get_loaded_plugin_versions --staleOnly` |
| "I don't know which tool I need" | `agentlenspro list --desc`, then `agentlenspro help <tool>` |

**Two long-lived commands, and they are NOT interchangeable — pick by whether you want it to stop:**

| | `budget` | `watch` |
|---|---|---|
| answers | "will the rate-limit window outlast a run of N minutes?" | "when does this metric spike?" |
| ends? | **yes — exits on the verdict** (`1` = ABORT the run) | **no — reports every peak and keeps going** |
| use when | you are about to start, or are running, something with a known duration | you want ongoing alerting with no duration in mind |

## Taxonomy — what these numbers ARE (read before choosing `--mode`)

Every metric belongs to exactly one **measurement kind**, and the kind decides which questions are
answerable. This is why the commands refuse some combinations instead of returning a number: the
refusal is the design, not a limitation.

| Kind | Behaves like | Metrics | `total` | `rate` | `since` |
|---|---|---|---|---|---|
| **Cumulative** | an odometer — only ever rises | `input` `output` `cache-read` `cache-create` `tokens` `cost` `turns` | ✅ | ✅ | ✅ exact |
| **Rolling gauge** | a fuel gauge on a window that empties behind you | `pct-5h` `pct-7d` `cost-5h` `cost-7d` | ✅ | ✅ | ⚠️ allowed, but can go **negative** as old usage leaves the window (the watch says so at arm time) |
| **Live rate** | a speedometer — already per-minute | `cost-per-min` `tokens-per-min` | ✅ | ✅ read straight, never differenced | ❌ *"already a rate"* |
| **Instant gauge** | a headcount — true only right now | `active-sessions` | ✅ | ✅ | ❌ *"no per-run total"* |

Kind and scope are independent: `cost-per-min` is a live rate on the **account**, `tokens-per-min`
a live rate on the **machine**.

⚠️ **A threshold on a cumulative `total` fires exactly once and then never again** — an odometer
that passes 100k never drops back under it, so the excursion cannot close. That is arithmetically
right and useless as an alert, so the watch warns you at arm time and points at `--mode rate`
(recurring spikes) or `--mode since` (this run only). Prefer those two for alerting.

And exactly one **scope**, which decides what the number covers and what you must pass:

| Scope | Covers | Requires | Served by |
|---|---|---|---|
| **session** | one conversation | `--session <id>` (get one from `get_recent_sessions`) | `get_agent_tokens` |
| **account** | one OAuth account's rate-limit windows | nothing | `get_window_eta` |
| **machine** | every session on this box | nothing | `get_burn_status` |

**Three honesty rules the output obeys — trust them when reading it:**

1. **`null` is not `0`.** A feed with no number says so and the watch reports it; it never prints a
   `0` you might act on. If a value stops arriving, the watch says that too, once.
2. **A refusal beats a plausible number.** `--metric cost --mode since --since <past>` is rejected
   at parse time because a past cost cannot be reconstructed without per-message pricing — it does
   not silently substitute a token count.
3. **Provenance is labeled.** `capacity.source: same-plan-proxy` means the window cap was borrowed
   from another account on your plan — good to an order of magnitude, not a hard boundary.
4. **Every alert names the culprit.** A peak or an abort carries `who:` — the top workdirs by
   burn, with each one's share and the watched session marked `←THIS`. The machine is shared by
   many sessions and workdirs, so *"is this mine?"* is part of the alert, never a follow-up.

**Exit codes are a contract** (both long-lived commands): `0` fine · `1` **ABORT** (budget only) ·
`2` could not answer honestly · `64` your command line was wrong. A harness can branch on these;
`64` deliberately never collides with `1`, so a typo can't masquerade as a real abort.

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
        description: "budget+guard — scenario suite", persistent: true)
```

**3. React to what arrives on that stream — each line means something different:**

| Line | What it means | Do |
|---|---|---|
| `[budget] ABORT — … — who: proj (sess, rate, share)` | the window will run out before the batch finishes, **and the line names the workdirs draining it** | **stop launching, kill the batch.** The command has already exited 1. If the top culprit is NOT your project, the drain is someone else's — killing your batch may not be the fix |
| `[budget] TIGHT — … — who: …` | it fits, but under the safety margin | stop *adding* work; let what is running finish. Check whether the named culprit is yours |
| `[burn-guard] FANOUT_BURST` / `RUNAWAY_FANOUT` | too many sub-agents launched too fast | pause launching; let the wave settle |
| `[burn-guard] CACHE_THRASH` | the prefix is being re-billed every turn | stop launching NOW and run `investigate_burn --windowHours 1` |
| `[burn-guard] COLD_RESUME_RISK` | a rate-limit stall just ended | warm with ONE agent before resuming the fan-out |
| nothing for a long time | normal — it is silent until something changes | no action |

**4. TaskStop the monitor when the batch ends**, or a guard armed for 90 minutes keeps emitting
for the rest of the session.

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
> `dirsMissing` tell you where it looked. Turn capture on with
> `agentlenspro config set captureRawBodies on`, and meanwhile use **`agentlenspro --risk`** and
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

## The exit-code contract — read this BEFORE you shell out to this CLI

If you are calling `agentlenspro` from a script or an agent loop rather than reading its output
yourself, this is the part that decides whether your code is correct:

| Exit | What it means | What stdout is |
|---|---|---|
| **0** | The command answered. | **A result — parse it.** |
| **2** | The tool REFUSED (not found, no calibration, no value in the feed). Not a crash. | **Empty.** The reason is JSON on **stderr**: `{"tool": "...", "error": "..."}` |
| **1** | A runtime failure, or a watcher's deliberate ABORT verdict (`budget --watch`). | A message, not a payload |
| **64** | Your command line was wrong; nothing ran. | A message naming the valid values |

`if rc != 0: don't parse` is therefore **correct** — that is the habit this contract is built
around. It was not always true: before 2.22.0 a refusal printed `{"error": …}` on **stdout** and
exited **0**, so a consumer read a refusal as an answer (issue #9 §1). If you must support an
older binary, check for a top-level `error` key as well as the exit code.

Two more things a program needs:

- **`--json` is a global.** It works on every tool and overrides the human rendering, so a tool
  that normally prints a table still gives you JSON. `--out FILE` writes the full payload to disk
  and prints a digest instead; on a refusal the file is **not** written.
- **A refusal never writes `--out`.** A file containing `{"error": …}` is worse than no file,
  because the next reader finds it and trusts it.

## When a command fails — read the failure, don't retry blindly

| What you see | What it means | Do |
|---|---|---|
| `unknown command`/`unknown tool` for something documented here | Your install predates **2.11.0**; the skill is newer than the binary. | `agentlenspro --version`, then `npm install -g agentlenspro@latest` |
| `FAIL: server busy — backpressure — start it: …` | The server **is running** and is shedding load under admission control. **The "start it" hint is wrong in this case** — starting a second one is not the fix. | `agentlenspro --status` to confirm it is up and see `memory:`. Wait and retry; if `rss` is multi-GB the span store is large — consider `agentlenspro config` retention or `--purge-db` |
| `FAIL: … server unreachable …` | Nothing is listening. | `agentlenspro server start` (or `setup`) |
| exit **64** with `[watch]/[budget] FAIL:` | Your command line was wrong; nothing was armed. | Read the message — it names the valid values |
| exit **2** | The question could not be answered honestly (no calibrated capacity, or the metric had no value). | Not a crash. Calibrate, or pick a metric with a live feed |
| `[watch] … has stopped returning a value` | The feed went quiet mid-watch; the watch is still polling. | Check the session still exists / the server is healthy |
| `capacity.source: same-plan-proxy` | The window cap is borrowed from another account on your plan. | Treat thresholds as soft; it is an estimate, not a boundary |
| A watch that printed `armed` and nothing since | Usually correct — it is silent until something crosses. | Confirm with `--every` briefly, or `--for 1` to see it stop cleanly |

## Where the rest of this document is

| If you need | Go to |
|---|---|
| the four rules that keep a diagnosis cheap (batch, `--out`, never paste JSON) | **Rules for agents** |
| every tool, by the question it answers | **High-value tools (cheat-sheet)** and **Context-composition & session-drill tools** |
| realtime risk flags and what to DO about each | **Realtime guard** |
| what the burn-gate blocks automatically | **The burn-gate** |
| the full `budget` flag surface and the abort recipe | **Budgeting a timed run** |
| the full `watch` flag surface, metrics, and durable logging | **Watching ANY metric for peaks** |
| why a 20-minute gap is NOT a cold cache | **Cache TTL tracking** |
| installing, repairing, starting, or stopping anything | **Install / repair**, **Server, daemon & telemetry control** |
| turning AgentlensPro itself off | **Emergency stop** |

## Commands

```bash
agentlenspro list --desc                    # every tool + one-line description
agentlenspro help <tool>                    # a tool's description + typed flags (live schema)
agentlenspro <tool> [--param value ...]     # direct call
agentlenspro call <tool> '<json-args>'      # raw JSON args object
agentlenspro batch '<json-array>'           # N tools in ONE invocation: [{"tool":"…","args":{…}}]
```

## Options (concise)

| Option | Effect |
|---|---|
| `--out PATH` | write the full JSON result to PATH; print only a one-line digest to stdout |
| `--full` | bypass the server's lean shaping (complete payload — pair it with `--out`) |
| `--status` | server health: pid, uptime, ports, memory, span store, EXACT disk bytes written since boot, bodies archive — or "not running" |
| `--start-server` | start the standalone server if not running (alone, or before any tool call); boot output goes to `~/.agentlens/server.log` |
| `--stop-server` | graceful SIGTERM (the server flushes every store first) |
| `--dashboard` | ensure the server is up, then open the dashboard (http://localhost:3000) |
| `--purge-db` | clear the span store + session cards; the server re-ingests from the agent logs |
| `--export-bodies DIR` | re-inflate archived OTEL bodies into DIR as plain files; `--since <hours\|ISO>` / `--until <ISO>` filter by time |
| `--purge-bodies` | delete archived body volumes proven durable in the store (each verified lump-by-lump); unproven volumes are kept and named, `.idx` sidecars always retained (the live 72h window is untouched) |
| `--risk` | one-shot realtime culprit check (~40ms REST fast path): prints only the ACTIVE burn risks, each naming the culprit session/workspace/model + magnitude |
| `--install-skill` | (re)install EVERY shipped skill into `~/.claude/skills/` (this one + `agentlenspro-cache-guard`) — idempotent, reports installed/updated/current per skill |
| `--install-hooks` | register the `agentlenspro hook` command string on the 10 LIFECYCLE hook events (SessionStart/End, Stop, StopFailure, Pre/PostCompact, Permission, Notification, SubagentStart/Stop) AND the burn-gate (`agentlenspro gate` on PreToolUse/PostToolUse matched to `^(Task\|Agent\|Workflow\|SendMessage\|Read)$` — `Read` only for the image cache-guard, see "The burn-gate" below) via the same verified transaction. Bare bin + subcommand, never absolute paths — registrations survive Homebrew version bumps; the install refuses if `agentlenspro` is not on PATH. Also migrates every previous-generation registration (`agentlenspro-hook`/`agentlenspro-gate` PATH bins, absolute-path `spy-agentlens*` scripts) and removes dead claude-spyglass entries. Never touches other tools' hooks. Idempotent; needs a session restart |
| `--uninstall-hooks` | remove exactly those agentlens hook entries — every generation: v2 command strings, v1 PATH-bin names, legacy absolute-path `spy-agentlens*` registrations (nothing else) |
| `--install-otel` | add the 19 Claude Code telemetry env vars to `~/.claude/settings.json` via a verified transaction: atomic backup+rename, cross-process lock, post-verify, refuses an unparseable file, all other content untouched, idempotent (`changed=false` when already installed) |
| `--uninstall-otel` | remove exactly those 19 vars, same guarantees |

Hook events: `--install-hooks` feeds lifecycle signals the transcripts/OTEL lack — exact
rate-limit turn deaths (StopFailure), compaction boundaries + trigger (PreCompact), true
session lifecycle — into `~/.agentlens/hook-events/` (NDJSON daily buckets, 31d retention).
Query: `GET /api/hook-events?session=&ev=&since=&until=&limit=` on the UI port.

Bodies lifecycle: raw capture is opt-in and off by default (`agentlenspro config set
captureRawBodies on|off`); when on, bodies land in a RAM-disk spool (macOS) instead of the SSD.
Live plain files (72h, `bodiesMaxAgeHours`) are ingested into a content-addressed store
(`~/.agentlens/store/` — fileless DuckDB → immutable zstd Parquet, deduped across turns,
~190× measured on this project's own history) — a source is deleted only after the store is proven
to hold its exact bytes AND its `(src_name, capture-time)` row, one gate shared by `.wad` volumes
and the hook-event spool; a payload that cannot ingest is quarantined, never deleted. The legacy monthly `.wad` archive
(`~/.agentlens/otel-bodies-archive/bodies-YYYY-MM.wad`) is a read-only fallback for history not
yet migrated, never written to again; `--export-bodies` reads from both. One server at a time:
the canonical instance owns `~/.agentlens/server.pid` and a second boot refuses cleanly.
`batch --out` files are position-prefixed (`out-1-<tool>.json`).

## Install / repair — `agentlenspro setup`

ONE idempotent verb installs, verifies, or repairs the whole stack:

```bash
agentlenspro setup --dry-run   # read-only: shows what would change, exits 0
agentlenspro setup --yes       # converge: every step CHECK → ACT → VERIFY, then self-test
```

Pipeline (fail-fast — a FAIL stops the run, remaining steps SKIP, exit non-zero):
**environment** (read-only heuristics: platform/arch + WSL label, Node vs the engines floor,
native-dep resolvability, foreign-process-on-OTLP-port, `~/.claude` presence, free disk —
hard-fails on native Windows with WSL2 guidance, on old Node, or on a broken install) →
data-store (sqlite quick_check; corrupt DB backed ASIDE, never wiped) → hooks → skill →
otel-env → old-package migration → server → final end-to-end self-test (synthetic span
round-trip + registered hook/gate execution). A second run over a converged install reports
**0 actions** — that is the idempotency proof. Data is NEVER deleted by setup.

**Platforms: macOS and Linux; Windows ONLY via WSL2** (native win32 is refused by the
environment probe — install Node ≥ 20.9 inside the WSL distro and `npm install -g agentlenspro`
there). Hook registrations changed by setup need a Claude Code session restart to take effect.

## Server, daemon & telemetry control

The tools call a resident server; these verbs manage it. `setup` wires everything, but each is
also a standalone command:

```bash
agentlenspro server start|stop|restart|status      # the UI/API + OTLP server (background)
agentlenspro server start --supervise              # foreground crash-restart supervisor (exit 78 = terminal, no respawn)
agentlenspro dashboard                             # ensure the server is up, then open http://localhost:3000
agentlenspro daemon start|stop|restart|status      # the always-on ingestion daemon (same process as the server);
                                                   # `status` also prints the hook-spool depth. Hooks auto-revive it,
                                                   # so no log is lost while it is down
agentlenspro daemon install|uninstall              # launchd agent (macOS) keeping the daemon up 24/7 across
                                                   # logout+reboot — opt-in; the CLI still starts it on demand without this
agentlenspro telemetry install|uninstall|status    # the Claude Code full-telemetry env in ~/.claude/settings.json
                                                   # (verified transaction; the verb form of --install-otel/--uninstall-otel,
                                                   # plus `status` to check whether it is wired)
agentlenspro heartbeat-cost [--oneline]            # exact token + $ cost of the last settled janitor heartbeat fire
```

`server` vs `daemon`: they are the SAME process — `server` is the operator-facing name (it serves
the dashboard), `daemon` is the ingestion-facing name (it drains the hook spool). Use `daemon
install` only when you want ingestion to survive a full logout/reboot without any Claude session
running; for interactive use the on-demand `--start-server` (or any tool call) is enough.

## Local commands — no server needed (`config`, `env`)

These two subcommands run entirely client-side (they never touch the MCP server), so they work
whether or not the server is up.

### `agentlenspro config` — persistent data retention

Retention is tunable by five `AGENTLENS_*` env vars, but env vars are ephemeral and never reach the
launchd daemon. `config` persists them to `~/.agentlens/config.json` (in the data dir, so a value set
once survives an uninstall / upgrade / CLI-path change, and the always-on daemon re-reads it every
boot). Each knob resolves at boot as **env var > config.json > built-in default**, min-floored.

```bash
agentlenspro config                              # list every knob: effective value + source (env|file|default)
agentlenspro config get spansRetentionDays       # one knob's value + where it came from
agentlenspro config set spansRetentionDays 90    # persist a change (prints "restart to apply")
agentlenspro server restart                       # apply it
```

Knobs: `spansRetentionDays` (30) · `summaryWindowHours` (24) · `bodiesMaxAgeHours` (72) ·
`bodiesMaxGb` (8) · `bodiesRetentionDays` (31) · `captureRawBodies` (off) — the one boolean knob,
`config set captureRawBodies on|off`; turning it on mounts a RAM-disk spool (macOS,
`agentlenspro spool ensure` re-creates it after a reboot) so raw bodies never touch the SSD. A
`set` on a corrupt config file REFUSES to write rather than clobbering it. Recipe — keep a year of
traces on a big disk: `agentlenspro config set spansRetentionDays 365 && agentlenspro server
restart`.

### Emergency stop: `agentlenspro disable [reason]` / `enable`

The global brake **on AgentlensPro itself** — one flag file that disarms every hook, the burn-gate,
server auto-revive, and background ingestion in **every** Claude Code session already running, on
that session's next hook fire. No restart needed (a `settings.json` edit alone cannot reach a
session that already loaded its config). `disable` also stops a running server and turns raw-body
capture off; `enable` clears the flag.

⚠ **This is NOT how you stop a burning workload.** It stops the *measurement*, not the burn — it
removes the gate that was denying disaster launches and blinds you exactly when the numbers matter
most. Reach for it only to take AgentlensPro out of the picture (debugging its own overhead,
handing the machine to someone else). To abort a run that is draining the window, see
**Budgeting a timed run** below.

### `agentlenspro env` — environment / system detection

Reports the full nature of the environment the CLI is running in — terminal kind resolved by
**process ancestry** (not `$TERM_PROGRAM`, which lies across subshells/ssh/multiplexers). Query one
facet, or omit it for the whole report; `--out FILE` writes the full JSON to disk and prints only a
one-line digest (keep a big report out of context).

```bash
agentlenspro env                       # whole environment, human digest
agentlenspro env list                  # the 10 facets + aliases
agentlenspro env terminal              # one facet (iterm/ghostty/tmux/vscode/…, ai-maestro, ssh)
agentlenspro env --json --out env.json # full report to a file (digest to stdout) — the agent default
agentlenspro env filesystem            # git worktree (main vs linked) + branch, fs type, free disk
```

| Facet (aliases) | Reports |
|---|---|
| `terminal` (term) | host terminal by process ancestry, multiplexer, ai-maestro agent, ssh, tmux |
| `os` (system) | OS product/version, kernel, arch, CPU, memory, uptime |
| `runtime` (ci, container, context) | CI runner, container/dev-container/WSL/sandbox, Claude Code context |
| `claude` (claude-code, permissions) | config dir, settings permission summary, plugin cache, CLAUDE.md, CLI version |
| `filesystem` (fs, disk) | cwd/home/project, fs type, git repo + worktree + branch, free disk |
| `user` (account, whoami) | user, uid/gid, groups, shell, sudo-capable |
| `network` (net) | interfaces, VPN (Tailscale/utun/WireGuard), proxy, DNS, listening ports, gateway |
| `cloud` (aws, azure, gcp) | AWS/Azure/GCP via env + local config + installed CLI (never contacts a metadata server) |
| `tooling` (tools, dev) | runtimes, package managers, compilers, linters, version managers — with versions |
| `mcp` (mcp-servers) | configured MCP servers from `~/.claude.json` + project `.mcp.json` |

Use cases: attach `agentlenspro env --json --out env.json` to a bug report; in CI, `agentlenspro env
runtime` confirms you're on GitHub Actions / in a container before running; `agentlenspro env terminal`
disambiguates a tmux pane from its GUI host; `agentlenspro env tooling` inventories a fresh machine.
Every detector is fail-soft and time-boxes its probes — an off-cloud `aws` or a stalled `tailscale`
can never wedge the report.

## Output formats

- **Default (no `--out`)**: pretty-printed JSON of the server's lean-shaped result — verdict and
  scalars first, arrays capped at the top rows, truncation always disclosed in `_truncated`.
- **`--out PATH`**: one-line digest (the `verdict` field when present) to stdout + complete JSON
  on disk. This is the token-economical default for agents.
- **`--full`**: unshaped payload (every row, derivations, remediation strings).
- `run_diagnostics_sql` additionally takes `--format table|markdown|json` for rendered output.
- Errors: `FAIL: <reason>` on stderr, non-zero exit (server unreachable, unknown tool/flag) —
  never a silent fallback.

## Rules for agents

1. **Batch** — N answers = ONE `batch` invocation, never N separate calls (each call costs a
   full transcript re-read).
2. **`--out` to the reports folder** — full payloads belong on disk, never in context. Save to
   the MAIN repo's `./reports/agentlens-diagnostics/` with a local-time+offset timestamp:

   ```bash
   # --porcelain is mandatory: plain `git worktree list` prints "<path> <sha> [branch]", so
   # awk/cut on the first space TRUNCATES any path containing a space (routine on macOS) and
   # the report is written to a directory nobody will ever look in.
   MAIN_ROOT="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
   REPORT_DIR="$MAIN_ROOT/reports/agentlens-diagnostics"; mkdir -p "$REPORT_DIR"
   agentlenspro get_cache_break_causes --out "$REPORT_DIR/$(date +%Y%m%d_%H%M%S%z)-break-causes.json"
   ```

   (`./reports/` must be gitignored; add it if missing.) Read back only the fields you need.
3. **Discover, don't guess** — `list --desc` then `help <tool>`.
4. Never paste a full JSON result into the conversation.

## Realtime guard — arm it BEFORE anything that can explode

Token explosions have warning signs MINUTES before the window drains, and the server sees
them in realtime (OTLP metrics tick every 4s; raw request bodies land as files at call time;
lifecycle hook events — SubagentStart/StopFailure/PreCompact — arrive within ~1s when
`--install-hooks` is active). `check_burn_risk` fuses them into 5 flags; `--guard` watches:

```bash
agentlenspro --risk                   # FASTEST culprit check (~40ms, REST): only the ACTIVE
                                       # risks, each naming WHO (session/workspace/model) + size
agentlenspro --guard 15               # watch loop: one [burn-guard] line per risk TRANSITION
agentlenspro check_burn_risk          # same report via MCP (full flags incl. inactive ones)
```

Every risk detail NAMES THE CULPRIT: launch/stall attribution is exact (SubagentStart /
StopFailure hook payloads carry session, workspace, agent types); thrash/fat-request
attribution reads each fat request's sender in a bounded 6KB scan and is labeled "likely" —
when nothing was attributable the message says so and points at `investigate_burn`.

**Arm the guard in a background monitor BEFORE spawning agent fan-outs, workflows, or long
batches** — each stdout line then interrupts you the moment a risk fires:

```
Monitor(command: "agentlenspro --guard 15", description: "burn guard", persistent: true)
```

For a batch with a known duration (a test round, a sweep), the guard is only half the job — it
watches the *rate*. Run the preflight in **Budgeting a timed run** below first to learn whether the
window survives the run at all, and to get the abort condition.

**Monitor is not always available, and the failure is silent** — per the Claude Code tools
reference it does not exist on Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry,
nor when `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set (a plausible
combination on a machine running a telemetry product). It also inherits **Bash** permission rules,
so a restrictive allowlist can deny `agentlenspro` here exactly as it would in a shell. When
Monitor is unavailable, do not skip the guard — poll it instead: `agentlenspro --risk` is a ~40ms
REST call printing only the ACTIVE risks, so a checkpoint in your own loop (step 3 below) covers
the same ground without the tool.

| Risk | Meaning | What to DO when it fires |
|---|---|---|
| `FANOUT_BURST` | ≥5 subagents launched in 2min (hook events) | If the parent session is fat or the cache cold, STOP launching; warm with ONE agent first |
| `COLD_RESUME_RISK` | a StopFailure (rate-limit turn death) ≤10min ago | Do NOT resume a fan-out: the stall likely outlived the fan-out's cache TTL — subagents ALWAYS ride the 5-min tier (even when the main session is on the 1-hour subscription tier), so their prefixes go cold fast. Check `get_account_status` headroom, warm with one agent, then ramp |
| `COMPACTION_REWRITE` | PreCompact ≤5min ago | The next turn rewrites the full prefix; avoid fan-outs/model switches until warm |
| `HUGE_REQUEST_BURST` | ≥3 requests >1MB in 90s | A fat-context fan-out is IN FLIGHT — stop adding agents, let the wave settle |
| `BURN_SPIKE` | live burn > 250k tokens/min (5-min window) | Run `investigate_burn --windowHours 1` NOW to name the source before it drains the window. The flag reports rate, **not** time-left (it says `Window time-left unavailable` without calibrated capacity) — pair it with `get_window_eta` to learn whether the window actually survives the run |
| `CACHE_THRASH` | ≥3 responses in 5min with big `cache_creation` and ~zero `cache_read` (exact Anthropic usage) | The prefix is being INVALIDATED every turn — a subagent/fork or a prefix-mutating tool is re-billing the whole context per call. STOP launching agents; `investigate_burn --windowHours 1` then `get_cache_break_causes` to name the mutator |

Hook-event risks need `--install-hooks` (the `sources` block says which feeds are absent).
Known burn multipliers to avoid up front: fan-outs forked from a fat session (compact first),
resuming a fan-out right after a rate-limit stall, a `/model` switch to a premium default
before spawning fresh agents, and images left resident in context.

## The burn-gate — PREVENTION, not just warning (installed by `--install-hooks`)

Warnings only work if someone is watching. The gate acts by itself: a PreToolUse hook on
`^(Task|Agent|Workflow|SendMessage|Read)$` asks the
resident server before every launch (one curl, measured 14ms end-to-end, decision p50 0.9ms)
and **DENIES the four measured disaster signatures**, feeding the reason back to the agent so
it can adapt instead of just failing:

1. **THRASH_ACTIVE** — cache-thrash in progress: launching more agents multiplies the re-billing.
2. **RUNAWAY_FANOUT** — ≥8 launches in 60s: let the wave settle.
3. **COLD_RESUME_FANOUT** — a rate-limit stall just ended and one agent already launched: that
   first launch IS the cache warm-up; the gate holds the rest until it lands (every fork
   resumed into a cold cache re-pays its full prefix at the write rate).
4. **FORK_STORM_FORMING** — forks of a ≥200k-token parent into a TTL-expired cache while a
   fan-out is starting: each fork re-pays the full prefix at the write rate.

Everything ambiguous is a `systemMessage` warning (cold/fat forks with the real token numbers,
fan-out heads-up with a "pin a cheaper model" hint when recent traffic is premium) or a silent
allow. A PostToolUse advisory on the same matcher injects ONE deduped in-band warning to the
model when a wave just triggered CACHE_THRASH / a fan-out burst (one per session+risk per
10min — per-call injections are themselves a cache-break cause).

**`Read` is in the matcher for ONE thing: the image cache-guard**, which WARNS (never denies)
when the file being read is an image and the session context is already ≥`imgWarnTokens` (50k).
An image block is RESIDENT — it rides forward in the prefix and is re-billed on every later turn
until a compaction evicts it — so the reason names the cheaper paths: delegate the look to a
subagent, batch every image into ONE turn, write the verdict down instead of re-reading. It is
warn-only on purpose: the 14 measured `CacheBreakCause` values do NOT include an image read, so
the popular "an image invalidates the whole message cache" claim is not corroborated here and must
not become a deny on a hot-path tool. `Read` is also the only non-rare tool in the matcher, and its
cost is bounded on the CLI side — a NON-image read is answered locally with one JSON parse and no
network call. Switch it off alone with `--hooks cacheguard=off` or `AGENTLENS_CACHE_GUARD=off`;
the agent-launch gate stays armed. Deeper discipline: the `agentlenspro-cache-guard` skill.

Operational facts: fail-open by construction (server down = 13ms silent no-op — the gate can
never stall or fail a turn). **Switches are REALTIME and machine-wide** — `agentlenspro
--hooks` shows them, `--hooks gate=off|warn|enforce capture=on|off advisor=on|off
cacheguard=on|off` flips them
instantly for every running session (the server is the decision point; registrations never
change, so no restarts). Per-session escape hatch: `AGENTLENS_GATE=off` env (checked in the
hook script before any network). Thresholds tune via `AGENTLENS_GATE_FORK_FAT_TOKENS` /
`_RUNAWAY_60S` / `_FANOUT_WARN_2MIN` / `_COLD_IDLE_MS` / `_COLD_RESUME_WINDOW_MS` /
`_IMG_WARN_TOKENS` / `_IMG_DENY_TOKENS`. Deny/warn
counts appear in `--status` and `/api/server-stats` under `gate`; every gate intervention
also lands on the dashboard's notification panel (SSE alerts). If a deny is wrong for a
legitimate mass fan-out, `agentlenspro --hooks gate=warn` for that run and restore after.

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
Monitor(command: "agentlenspro budget --hours 2 --watch 120 --with-risks", description: "budget+guard — <batch name>", persistent: true)
```

One Monitor, both signals: `[budget]` verdict transitions **and** `[burn-guard]` risk transitions
on the same stream, silent while nothing changes. (Arming only the guard —
`agentlenspro --guard 15` — is still correct when there is no fixed run length to budget against.)

`persistent: true` is right for a batch (no deadline guessing — `timeout_ms` is then ignored and
may be omitted), but it means the watch lives until the SESSION ends. **`TaskStop` it when the
batch finishes**, or a guard for a 90-minute run keeps emitting for the rest of the day. If Monitor
is unavailable in this environment (see the guard section above), fold `agentlenspro --risk` into
the step-3 checkpoint loop instead.

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
| `agentlenspro disable` | stops AgentlensPro, **not your burn** (see Emergency stop above) |

So a batch that must be able to abort itself needs the stop condition in **its own loop** — the
snippet in step 3 is that loop; wire its non-zero exit to however your harness terminates.

**5 — After the run, attribute what it cost:** `get_cost_rollup --groupBy subagent --windowHours
<run length>` for the per-agent bill, and if the window did drain, `get_rate_limit_report` (what
exactly filled it) or `investigate_burn --windowHours 5` (ranked causes with evidence).

## Watching ANY metric for peaks — `agentlenspro watch`

`budget` answers one question and **exits** on the answer. `watch` observes one metric
**indefinitely and never stops on an alert** — it reports each peak as it happens and keeps going.
Use it when the question is "tell me whenever X spikes", not "may I start this run".

```bash
agentlenspro watch --metric cache-create --session <id> --mode rate --threshold 50000
agentlenspro watch --metric pct-5h --threshold 80
agentlenspro watch --metric tokens-per-min --threshold 1000000 --interval 15
agentlenspro watch --metric cost --session <id> --mode since --threshold 5
```

| scope | metrics | source |
|---|---|---|
| **session** (needs `--session <id>`) | `input` `output` `cache-read` `cache-create` `tokens` `cost` `turns` | `get_agent_tokens` — truly cumulative, so every mode is exact |
| **account** | `pct-5h` `pct-7d` `cost-5h` `cost-7d` `cost-per-min` | `get_window_eta` — **rolling gauges**, not accumulators |
| **machine** | `tokens-per-min` `active-sessions` | `get_burn_status` — live rate |

**Modes.** `total` = the current value · `rate` = change per minute (a source that is already a
rate is read straight, not differenced) · `since` = consumed since `--since` (**default: the moment
the watch started**). A **past** `--since` is reconstructed from the transcript — session-scoped
token metrics only, and **deduped by message id**, because Claude Code repeats one message's full
usage on every content-block row (measured over-count: **1.7× on cache-read, 2.1× on output**).

**Peaks, not samples.** An excursion opens when the value reaches `--threshold` (one `PEAK-START`
line) and closes when it falls below `threshold × --hysteresis` (default `0.9`), emitting one
`PEAK` line with the **maximum reached and how long it lasted**. Nothing is printed in between —
a line per sample would flood the stream, and a monitor that floods is stopped automatically, so
a chatty alert destroys itself. Hysteresis exists so a value oscillating on the threshold does not
open and close an excursion every poll. `--every` opts into per-sample echo; `--json` emits one
object per line.

**Exit codes are a contract**, and a caller mistake never borrows a runtime code: `0` stopped
cleanly (`--for` elapsed) · `2` the metric had no value to watch · **`64` (sysexits EX_USAGE) the
command line was wrong**. `budget` gains the same `64`, so a mistyped flag can no longer be
mistaken by a harness for its `1` = ABORT. `--for MINUTES` bounds a watch's lifetime (default `0`
= until killed). If the feed stops returning a value the watch says so ONCE and keeps polling —
an hour of silence must never be readable as "nothing crossed the threshold" when it means "there
has been nothing to measure".

**It refuses what it cannot answer honestly** rather than returning a plausible number: a
session metric with no `--session`, a "since" on something that is already a rate, a per-run total
for machine-wide burn, a past `--since` on a rolling gauge. A feed that has no value yields a
stated failure, never a fabricated `0` — `0` is a measurement and absence is not.

### Durable, SSD-friendly logging (`--log` / `--flush-ms`) — on both `watch` and `budget`

```bash
agentlenspro watch --metric tokens-per-min --threshold 2000000 --log ~/logs/burn.log --flush-ms 1000
```

Writes are **coalesced**: lines buffer for `--flush-ms` (default `1000`, max `60000`, `0` = write
through) and land as ONE append. A monitor that wrote every event immediately would turn a
200-byte line into a full flash page-program cycle, all day, for a file nothing reads in between.

The trade is explicit and bounded — **up to `flush-ms` of lines are lost if the process is killed
uncleanly** — but integrity never is:

- only **complete lines** are buffered, so a flush can never emit a fragment;
- a flush is a single `appendFileSync` with `O_APPEND`, so two watchers on one file interleave at
  line boundaries instead of clobbering each other;
- the buffer is **capped** — a failing disk cannot grow it without limit; the oldest lines are
  dropped and **counted**, and the count is reported on recovery, because a log that silently
  loses events lies by omission;
- `exit`, `SIGINT` and `SIGTERM` all flush, so an orderly stop loses nothing;
- the flush timer is `unref`'d and never holds a finished process open.

Verified by SIGKILL mid-run: every line on disk was complete and newline-terminated, zero
malformed records. Apart from this opt-in log, `watch` and `budget` **write nothing** — every tool
they call is a read.

## Cache TTL tracking — a warm gap is NOT a cold rewrite (TRDD-VY1IUVUM)

The prompt-cache TTL is **not a universal 5 minutes** — a subscription MAIN session rides a **1-hour**
tier, so a 20-min gap on it is still WARM. Hardcoding 5 min made the gate/keepWarm cry "cold rewrite"
on sessions that never went cold. Every TTL number now carries a `ttlSource` so you can trust or
question it. The doc-verified matrix (`src/shared/cacheTtl.ts` — the ONE place these numbers live):

| Session kind | Auth | TTL |
|---|---|---|
| Main conversation | subscription (within plan) | **1 hour** (automatic) |
| Main conversation | subscription drawing USAGE CREDITS (over plan) | **5 min** (auto-dropped) |
| Main conversation | API key / Bedrock / GCP / Foundry | **5 min** (`ENABLE_PROMPT_CACHING_1H=1` → 1h) |
| Subagent (named/general) | any | **5 min ALWAYS** (own conversation, own cache) |
| Fork | inherits parent | reads the PARENT's entry; every hit RESETS its timer |

`FORCE_PROMPT_CACHING_5M=1` forces 5 min regardless of auth. Every cache hit resets the timer; cron
fires are main-conversation turns (they renew it).

**The TTL also sets the WRITE PRICE — the tier is not cosmetic.** A 5-minute cache write bills at
**1.25×** base input; a **1-hour write at 2×**. Since a subscription MAIN session takes the 1h tier
automatically, most writes on such a machine cost 2×, and pricing them at the 5m rate under-reports
by 60%. Verified against Claude Code's OWN `cost_usd` (2026-07-26): solving the implied rate over
~700 opus calls gives a median of exactly $10.00/MTok with a p10 of exactly $6.25 — both tiers occur,
so neither flat rate is right — and joined to their raw bodies the implied rate matches the body's
`usage.cache_creation.ephemeral_{5m,1h}` tier 26/26. **Prefer a harness-reported `cost_usd` over any
local recomputation**: Claude Code's own price table is tier-aware. `get_cache_event_log` labels each
row's `costSource` (`harness` vs `computed`) so you can see which you are reading.

**Which tier am I on right now?** `agentlenspro get_subscription_usage` reports
`usageCreditsEnabled` — credits OFF means the automatic 1-hour TTL is active (2× writes); credits ON
means it dropped to 5 minutes (1.25×). That is a live reading, not an inference from auth signals.

**Reading the TTL-aware output.** `get_account_status.cacheTtl` = `{minutes, regime, ttlSource, basis}`
for your MAIN session; keepWarm/gap classifications carry `ttlAssumedMin` + `ttlSource`:
- `doc-matrix` — a matrix row applied to positively-resolved signals (trust it).
- `config` — an env override (`FORCE_PROMPT_CACHING_5M`/`ENABLE_PROMPT_CACHING_1H`) decided it.
- `measured` — observed cache behaviour CONTRADICTED the assumption (a cache hit after the assumed
  expiry) and the measured floor was preferred. keepWarm's falsifier flips the source to this.
- `assumed` — a signal was absent, so the conservative 5-min floor was reported AS an assumption
  (never a silent guess).

**True cold rewrite vs normal suffix write.** A small per-turn `cache_creation` is NORMAL incremental
suffix writing. Only a **full-prefix-sized** creation spike is a real cold rewrite. Invalidation causes
≠ TTL expiry: model/effort/fast-mode switch, MCP connect/disconnect, bare-tool deny, compaction, CC
upgrade. Use `get_cache_break_gap_report` to separate TTL-expiry from a real prefix change, and
`trace_expensive_writes` for the biggest single writes + their contents.

**One-liner recipes.**
```bash
agentlenspro get_account_status                      # your session's cacheTtl regime + windowSource
agentlenspro get_cache_break_gap_report              # TTL-expiry vs real prefix change, per gap
agentlenspro get_cache_break_causes                  # what breaks the cache machine-wide
agentlenspro cache-expired                           # → the WORD 'true' or 'false' (this project)
agentlenspro cache-expired -q                        # → nothing; exit 0 = EXPIRED, 1 = fresh
agentlenspro last-compact                            # → how long ago this project compacted ("2h 14m")
agentlenspro last-compact --seconds                  # → a bare integer for arithmetic
agentlenspro check_cache_expiry                      # the full verdict object (this project's main)
agentlenspro check_cache_expiry --all                # every session's fresh/expired verdict
agentlenspro check_cache_expiry --thresholdMinutes 60 --out /tmp/exp.json   # probe "> 1h idle"
```

**Want a plain true/false? Use `cache-expired`, not the tool.** The tool returns a verdict OBJECT and
exits 0 either way, so a script has to parse JSON and cannot branch on `$?`. The verb is the same
verdict in a shape a shell consumes:

```bash
if agentlenspro cache-expired -q; then echo "cold — the next turn re-writes the whole prefix"; fi
[ "$(agentlenspro cache-expired)" = true ] && do_something     # the value form
```

- **stdout is exactly one word** (`true` = expired, `false` = fresh); which session was measured goes
  to **stderr**, so a pipe stays parse-safe and a wrong-repo answer can never look like a right one.
- **exit**: default `0` = answered · `2` = cannot answer (stdout **empty**) · `64` = bad flags.
  With `-q`: `0` = EXPIRED · `1` = fresh · `2` = cannot answer.
- **It never prints `false` for a question it could not resolve.** No LLM call recorded, no session in
  scope, or the server unreachable → exit 2 with the reason on stderr, because "warm" and "I cannot
  tell" lead to opposite decisions. A transport failure exits **2, never 1** — under `-q`, 1 means fresh.
- Flags: `--project DIR` (default: the current directory) · `--session ID` · `--threshold-minutes N`
  · `--json` (the full object plus a top-level `expired` boolean).

**How long ago did this project compact? `last-compact`.** A compaction rewrites the whole prefix at
the write rate, so "when did it last happen" is a cost question, and the answer is a **delta** — the
form the decision actually needs:

```bash
agentlenspro last-compact                  # stdout: "2h 14m"   stderr: which compaction (trigger, session)
age=$(agentlenspro last-compact --seconds) && [ "$age" -lt 300 ] && echo "compacted just now"
```

- **Manual `/compact` AND auto-compact both count** — they cost the identical rewrite. The newest of
  either wins and the stderr line names which (`manual compact at …` / `auto compact at …`);
  `--trigger manual|auto` narrows it.
- Sourced from the **PreCompact lifecycle hook** (the compaction itself, with its trigger), read
  straight off the hook-event store — so it **answers with the server down**. It needs
  `agentlenspro --install-hooks`; with capture never installed the store is empty and the command
  says exactly that.
- **exit**: `0` = answered · `2` = no compaction on record (stdout **EMPTY**) · `64` = bad flags.
  A never-compacted project prints **nothing**, never `0` — "no compaction" and "compacted 0s ago"
  are opposite claims, and `age=$(… --seconds)` must not hand a script a number it would read as
  "just now".
- Flags: `--project DIR` (default: current directory; `''` = any project) · `--session ID` ·
  `--trigger manual|auto` · `--window-days N` (default 31, the store's retention) · `--json` (adds
  the ISO stamps, the matching PostCompact completion and how long the compaction took).
- Scope is path-boundary aware and symlink-tolerant: a worktree under the root counts, a sibling
  `<root>-old` does not, and a `cwd` recorded through a symlink (macOS `/var` → `/private/var`) still
  matches its resolved root.

**Scoping (changed 2026-08-04, and it was a real defect):** both this verb and `check_cache_expiry`
now default to **the calling project's** newest main session. The old default picked the newest main
session machine-wide — measured, a probe run inside one repo answered about a session in an unrelated
one with nothing in the payload disclosing it. Pass `--project ''` to `check_cache_expiry` for the old
machine-wide pick; `--all` still spans every project unless you scope it.

**Is a specific claude's cache expired yet?** `check_cache_expiry` answers exactly "has more than
the TTL passed since this session's last LLM request?" — idle since the last `api_request`, compared
to that session's TTL (1h subscription-main, 5min subagent/usage-credits), so `expired` means the
prefix was likely evicted and the next request pays a full cache-creation write. Per session it
returns `verdict` (fresh|expired|unknown), `idleHuman` ("1h 12m"), `ttlMin`+`ttlSource`+`ttlBasis`
(same honesty contract — unknown auth → an `assumed` 5-min floor, never a silent guess), and
`lastRequestAt`. Default = the newest MAIN session; `--all` = every session; `--sessionId <id>` = one;
`--thresholdMinutes N` overrides the TTL with an explicit cutoff (e.g. `60` to probe "more than 1h").
A `verdict:"unknown"` means no LLM request was recorded for that session.

## The per-call ledger — `get_cache_event_log`

Answers "**did that compaction / command / turn burn tokens on a cache miss?**" in ONE call. One row
per API call with every bucket spelled out (input, cache write, cache read, output), the write's TTL
tier, its cost-weighted size in **input-equivalent tokens**, and the exact USD.

```bash
agentlenspro get_cache_event_log                        # peak + the 3 calls before/after (default)
agentlenspro get_cache_event_log --mode recent --limit 20
agentlenspro get_cache_event_log --window 4 --context 5 --format markdown
agentlenspro get_cache_event_log --project <path-or-slug>   # another project (default: the cwd's)
```

- **`mode=peak`** centres the **costliest** call and shows the calls around it — a cold write is only
  interpretable next to the warm turns beside it (137k reads as a disaster alone, and as a cheap
  one-off next to the 613k prefix it replaced). **`mode=recent`** lists the last N regardless of cost.
- **🔥×1-5 by ORDER OF MAGNITUDE** (1+ / 10k+ / 50k+ / 150k+ / 400k+), because on a linear scale a
  400k full-prefix rewrite and a 12k suffix write both just look "big".
- **Scoped to ONE project as a hard boundary**, not a filter: this machine interleaves many concurrent
  sessions from unrelated repos into one bodies directory, so rows appear only for sessions the
  project provably owns. Exclusions are reported split into `otherProject` (the boundary working) and
  `unattributable` (a real coverage gap) — one merged number would hide the gap behind the guarantee.
- **Reads the OTEL span store first.** Those `api_request` events carry `session.id` directly, so
  attribution is exact and even a compaction's own summarization call appears (`query_source:
  compact`) — the raw-body fallback's `previous_message_id` chain cannot attribute it, nor a
  session's newest call. The `cache miss reason` column is the **API's own verdict**
  (`system_changed` / `tools_changed` / `messages_changed` / …) from the cache-diagnosis beta, not a
  statistical inference.

## Authoritative window usage — `get_subscription_usage`

The **real** 5h/7d utilization — Anthropic's own numbers, the same ones `/usage` renders. Every other
window tool here INFERS the cap from observed rate-limit hits (`capacitySource: observed |
same-plan-proxy | none`, and no ETA when uncalibrated); this reads the actual percentage.

```bash
agentlenspro get_subscription_usage             # cached ≤10 min
agentlenspro get_subscription_usage --force     # deliberate refresh (still respects a 429 back-off)
```

Returns the generic **`limits[]`** array — `{kind, group, percent, severity, resetsAt, isActive,
scopeLabel}`, kinds `session` / `weekly_all` / `weekly_scoped` (per-model) — rather than only the two
named windows, because the payload carries buckets that named-field parsing silently drops. Also
`usageCreditsEnabled`, the **live cache-TTL oracle** (see the TTL section above).

**Operational notes.** The endpoint is undocumented, community-reverse-engineered (technique credit:
`pizzimenti/ccgauge`), and **429s hard — knocking again RE-ARMS the lockout** rather than queueing.
Hence a 10-minute cache, `Retry-After` honored, exponential back-off on *consecutive* 429s, and a
cross-process lock. **Never poll it in a loop; use `--force` only for a deliberate one-off.** Failures
degrade to the last reading with an explicit `reason` (`cooldown` / `no_token` / `opt_in_required` /
`lock_contended` / `http_error`), and a stale reading **suppresses its countdowns** rather than
rendering an already-rolled window as live. On macOS the token is in the login keychain, so the read
is **opt-in**: export `AGENTLENS_READ_KEYCHAIN_USAGE=1` (an un-ACL'd keychain read pops a password
prompt, which is unacceptable from a status line or hook).

## Every account, not just the live one — `get_account_status --all`

`get_account_status` answers for the account you are on **right now**. That is the wrong shape for a
rotator: deciding whether to switch needs the headroom of the accounts you are **not** on, and the only
way to learn an account's status used to be to already be on it. **You had to rotate to find out
whether you should rotate.**

```bash
agentlenspro get_account_status --all          # a table; '*' marks the live account
agentlenspro get_account_status --all --json   # every field, including the reason behind every null
```

```
   account   email               plan     5h window   7d window   observed  left
*  bbbbbbbb  owner@example.com   Max 20x  unreadable  unreadable  never     (on it)
   aaaaaaaa  second@example.com  Max 20x  0% rolled   77% aged    352m ago  07-31 15:28
   cccccccc  third@example.com   Max 20x  unreadable  unreadable  never     07-30 17:19
```

**No credential is read** — the OAuth token contract is unchanged. Every row is what was already
observed while that account was live, stamped. It is assembled entirely from files, so it **answers
with the server down**, which is exactly when a wedged machine is asking.

**The verdict is per WINDOW, not per account**, because the 5h and 7d roll at wildly different rates:

| freshness | meaning | number |
|---|---|---|
| `fresh` | measured inside the cache TTL | the percentage |
| `aged` | past the TTL, but the window has **not** reset — utilization only grows | a **LOWER bound** |
| `rolled` | the window reset **and** this machine was already off the account when the new one began | **INFERRED ~0%** |
| `stale` | reset, but activity since cannot be excluded | `null` + a reason |
| `unreadable` | never observed | `null` + a reason |

`rolled` is the one that pays for the feature: an account at 91% whose 5h window has since reset, that
nothing local can have filled, is **available** — not unknown. It is an **inference**, it says so, and
its precondition ("no activity observed **by this machine**") travels in the payload — audit it with
the `left` column before acting. It is deliberately suppressed when the reading's own account
contradicts `~/.claude.json`, because the premise then rests on a claim known to be wrong.

**`unreadable` is never an absent row.** "Cannot read this account" and "this account has no headroom"
are opposite signals; a missing row renders as the second. An empty roster is **BLIND** (exit 2 —
the house "cannot answer honestly" code; it was 1 before v2.22.0), never "no accounts". Per-model weekly buckets are reported separately and **never** folded into the
verdict — a spent per-model bucket does not block other models.

## Per-project and per-subagent history — `agentlenspro statusline-history`

**The only surface that answers "what is running in THIS project, right now, and what has it cost".**
Claude Code renders the status-line payload every few seconds and persists none of it; this reads the
captured history off disk, so it also **works with the server down** — which is exactly when someone
is investigating a burn.

```bash
agentlenspro statusline-history project              # ← scopes ITSELF to the cwd's project
agentlenspro statusline-history project --json       # every field, incl. resets_at + repo identity
agentlenspro statusline-history subagents --project  # live agents launched from here: fill%, worktree
```

`project` is the one to reach for from inside a repo. It prints one row per session **in that
project** — model, effort, fast mode, context tokens + fill %, lifetime cost, and the **account's**
5h / 7d window fill — and it announces the directory it resolved on **stderr**, so a piped stdout
stays machine-readable and a wrong-repo answer can never masquerade as a right one:

```
scope: /Users/me/Code/Proj (implied by the 'project' view — pass --project DIR to override)
session   model       effort  fast  ctx     ctx%  cost $  5h%  7d%  ver      samples  last
bbbbbbbb  opus-5[1m]  xhigh   -     232.6k  23    537.97  80   91   2.1.220  7745     00:09:43
```

**`--project` works on EVERY view**, not just `project`. Bare `--project` means the current
directory; `--project DIR` names one. It matches `workspace_project_dir`, `workspace_current_dir`
**and** `cwd`, at the root or anywhere under it — so a worktree-isolated agent running in
`<root>/.claude/worktrees/<x>` is included, while a sibling `<root>-old` is not. The subagent stream
carries **only** `cwd` at the top level (its `workspace.*` are null), which is why all three are
matched rather than trusting the project dir.

| view | answers |
|---|---|
| `project` | everything about the sessions in ONE project (self-scoping; see above) |
| `sessions` | one row per session machine-wide: peak fill, cost, span |
| `subagents` | per-agent `tokenCount` vs its OWN `contextWindowSize` — a 150k Sonnet agent in a 200k window (75%) is in far more trouble than a 90k Fable agent in 1M (9%). Nothing else on the machine publishes this |
| `windows` | 5h/7d history at **full float precision** — the only un-quantized window reading |
| `peaks` | the largest context/cost jumps between consecutive samples. **Read the `span` column**: a delta across an idle gap is an INTERVAL total, not one turn |
| `cache` | per-turn cache WRITE vs READ — the falsifier for a claimed cache miss. Cost is bracketed 5m/1h because the write rate is TTL-tiered and the tier is not in the payload |

**Times are LOCAL, and every time header carries the machine's `±HHMM` offset** (v2.22.0+). Before
that they rendered UTC under a bare `time` header while `get_cache_event_log` rendered local — two
views of one store, two hours apart, nothing marking it. On a UTC+2 box the newest row always looked
~2h old, which reads as "capture died".

**Read the coverage line before concluding anything is stale.** Most views are RANKED (by cost /
write / peak), not chronological, and every view is capped by `--limit` (default 40) — so the newest
row you SEE is unrelated to the newest row STORED. Each run prints, to stderr:

```
coverage: 40 row(s), sorted by cache WRITE, largest first · 2976 sample(s) in window · newest sample 14:55:00 +0200 (11s ago)
note: capped at --limit 40 and ranked by cache WRITE, largest first, so RECENT low-ranking turns can
      be missing. That is truncation, NOT stale capture — compare 'newest sample' above against your
      clock, and raise --limit to see more.
```

`newest sample` is the store's real high-water mark, computed independently of the view's ranking and
cap — it is the number that answers "is capture alive?". `--json` carries the same as `sortedBy`,
`newestSampleTs`, `samplesInWindow`.

Every point-in-time field is **latest-wins**, peaks are **max**, and nothing is ever summed: the
status line misses fast turns, so summing double-counts nothing and under-counts everything.

**Exit codes are part of the answer.** `2` = **BLIND** — the store holds nothing for this window,
which means *"cannot see"*, **never** *"no burn"* (capture may not be installed: run `agentlenspro
--install-statusline`); `64` = bad command line, `1` = runtime failure. (BLIND was exit 1 before
v2.22.0.) `0` with `(no rows matched)` is the opposite: we looked, and the filter
genuinely excluded everything. Flags: `--since H|ISO` (default 24h) · `--until` · `--limit` ·
`--session ID` · `--json` · `--out FILE` (full report to disk, one-line digest to stdout).

## High-value tools (cheat-sheet)

| Question | Tool |
|---|---|
| **"Did that compaction/command cost me a cache miss?"** | **`get_cache_event_log`** — the per-call ledger (above): peak-with-context or recent, 🔥 write magnitude, TTL tier, cache-miss reason, harness-reported cost |
| **"How full are my windows, really?"** | **`get_subscription_usage`** — Anthropic's own 5h/7d numbers + `usageCreditsEnabled` (the TTL-regime oracle) |
| **"My window drained — what burned it and WHO?"** | **`investigate_burn`** — START HERE. ONE command does the whole investigation: exact billed usage (by hour/model, est $), workspace attribution, and ranked cause findings with evidence (`FORK_STORM`, `SUBAGENT_BOOT_TAX`, `PREMIUM_MODEL_FANOUT`, `FAT_SESSION_REWRITES`, `IDLE_FLEET_KEEPWARM`, `IMAGE_BLOB_RESIDENT`, `RATE_LIMIT_COLD_RESUME`) + a plain verdict naming the culprits. Flags: `--windowHours 5` (default), `--untilIso <ISO>` for a past drain, `--maxFiles`. **Forensic — reads raw bodies off disk: if `coverage.blind` is set the verdict starts with `BLIND` and it saw nothing (capture off / dir missing / window predates capture). That is no DATA, not no BURN — cross-check with `--risk` or `get_burn_status`, which read the live feed.** Drill deeper only if needed with the tools below |
| Is something burning RIGHT NOW? | `get_burn_status` |
| Which account am I on — email, plan (Pro/Max 5x/Max 20x), billing MODE, cache-TTL regime, 5h/7d fill? | `get_account_status` — one-line `summary` + `plan`/`mode`/`cacheTtl {minutes,regime,ttlSource}`/`usageWindows {fiveHourPct,sevenDayPct,windowSource}` (windowSource `cc-rate-limits` when Claude Code's own rate_limits are ingested, else `calibrated`, else `none` — a null is never shown as 0) |
| What account/mode/plan/cache-TTL was I on at a PAST instant T? | `get_account_state_at --ts <ms-epoch>` (or `--iso <ISO-8601>`) — binary-searches the change-detected account-state timeline (`~/.agentlens/account-state.ndjson`, written ONLY on a discrete state change, ~a few writes/hour), so you can attribute a past span/burn to the mode+plan+TTL in force then. Null (never fabricated) when the timeline doesn't reach that far back |
| How much 5h/7d window is left, per account, and when does it run out? | `get_window_budget` (time-to-exhaustion needs `AGENTLENS_WINDOW_5H_TOKENS`/`_7D_TOKENS` capacity configured — calibrate from a premature window end) |
| What did project X / ALL projects / my subagents cost in interval Y? (5-value breakdown + $/h) | `get_cost_rollup --groupBy project\|all\|subagent\|session\|model --windowHours N` (or `--sinceIso/--untilIso`); `--subagentsOnly --liveOnly` = the live-fleet view; `--sortBy` any bucket |
| What rate limits did I hit, what EXACTLY filled the window, and why? | `get_rate_limit_report` — stall episodes (sessions/workspaces/errors) + the newest episode's 5h window attributed with exact billed usage, verdict, and top findings |
| What will this code review / workflow COST before I launch it? | `predict_session_cost --task "<describe it>"` (+ `--subagentType`, `--fileBytes`) — p25/p50/p75 over matched real precedents; p75 = budget-safe |
| Which Claude Code instances are running and what memory does EACH one's whole tree use? | `get_runtime_inventory` — instances ranked by total tree RSS (subshells/agents/crons/servers included), project dir, CC version |
| Why is THIS session expensive? | `get_session_burn_profile --sessionId <id>` |
| Exactly what did agent X consume? (reconcile with CC's per-agent ↓ footer) | `get_agent_tokens --agentId <id>` (bare / `agent-<id>` / full sessionId, case-insensitive; `--parentSessionId` to disambiguate — ambiguity errors listing candidates, never guesses). Exact four buckets + cost_usd. **CC's ↓ display shows live context-read volume (cumulative input+cacheRead+cacheCreation, launch turn included), not billing — reconcile via `ccDisplayEquivalent`** |
| What keeps breaking the cache, machine-wide? | `get_cache_break_causes` |
| Per-turn break diagnosis of one session | `get_cache_break_timeline --sessionId <id>` |
| TTL expiry vs real prefix change? | `get_cache_break_gap_report` |
| **Has a session's cache EXPIRED (idle > its TTL)?** | **`agentlenspro cache-expired`** for a plain `true`/`false` a shell can branch on (`-q` → exit 0 = expired, 1 = fresh, 2 = cannot answer; it never prints `false` for a question it could not resolve). `check_cache_expiry` for the full object — idle since the last LLM request vs the per-session TTL (1h subscription-main, 5min subagent/usage-credits). Per session: `verdict` fresh\|expired\|unknown, `idleHuman`, `ttlMin`/`ttlSource`/`ttlBasis`, `lastRequestAt`. Default = **this project's** newest main session; `--all` = every session; `--sessionId <id>` = one; `--project ''` = machine-wide; `--thresholdMinutes N` overrides the TTL (e.g. `60` = "> 1h idle"). `unknown` = no LLM request recorded |
| Biggest single cache writes + contents | `trace_expensive_writes` |
| What did the last janitor heartbeat cost? | `get_heartbeat_cost` |
| Which config (model/spawn/effort) costs most? | `compare_configs --groupBy <dim>` |
| Ad-hoc analytics over the fact DB | `run_diagnostics_sql --preset <name>` / `--sql '<SELECT…>'` |
| **Ad-hoc SQL over the raw session TRANSCRIPTS** | `run_transcript_sql` — DuckDB over the `.jsonl` records as ONE `transcripts` relation (quote camelCase columns: `"sessionId"`, `"timestamp"`). No-arg lists the presets (`record_type_histogram`, `usage_by_model`, `cache_heavy_turns`, `sessions_by_output`); `--sql '<SELECT…>'` for anything else (read-only, single statement). Bounded: `--sessionId <id>` = that one file, else `--window N` hours of mtime (default 24); coverage block names exactly what was queried. Content/shape questions no drill covers — the drills stay the fast path |
| Recent sessions / workspace patterns | `get_recent_sessions` (ranked by LAST ACTIVITY, not start date; rows carry `lastActive` + `active:true` for sessions live in the last 5min — plus the AI session `title`/`entrypoint` when the transcript carries them), `get_workspace_patterns` |
| **"Show me what was actually SAID and DONE in a session"** | `get_conversation` — the narrative reader: verbatim ordered turns (user prompt → thinking → reply → each tool call with its paired output), sidechain turns labeled, compaction dividers with pre/post/dropped tokens, per-turn duration + usage incl. cache-TTL tier 5m/1h. Progressive: no-arg = per-turn summaries; `--turn N` = that turn verbatim; `--turnFrom/--turnTo` = bounded range. Content lens; `get_context_history` stays the cost/composition lens |
| **Which sessions still write raw OTEL bodies (restart targets)?** | `get_body_writers` — ranked by recent rate then total; `active` rows wrote within `--active_min` (default 10m) and keep writing until their process restarts. Request-body attribution (responses aggregated); totals = exact store+live union. `--window_min 30 --limit 20` |
| **Who exhausted the PREVIOUS account's windows (post-rotation autopsy)?** | `get_account_burners` — BOTH the 5h and 7d tables in one call, grouped by project/agent (sessions pooled by workspace) with cache-created + cache-read columns; the window nearer its calibrated capacity at rotation is marked MOST LIKELY EXHAUSTED. Default `--account previous` (also `current`, uuid prefix, email); `--interval last`(default)`/current/<ISO-date>` picks the window end. Time-based attribution: cross-rotation sessions split correctly between accounts |
| **How long until the CURRENT account's window runs out?** | `get_window_eta` — COST-based ETA (Anthropic meters windows by cost, not tokens): consumed $ vs calibrated $ cap, current $/min, ETA + which window exhausts first. Models the rolling window — says "won't exhaust at this rate" when steady-state fill plateaus below the cap instead of a fictional countdown. Per window: `willExhaustAtCurrentRate`, `etaMinutes`/`etaHuman`, `capacity.source` (`observed` \| `same-plan-proxy`); `bindingWindow` is the string `"5h"`\|`"7d"`. `--rate_window_min 30`, `--account current`. **The preflight for any timed batch — see Budgeting a timed run** |
| **WHICH SKILL or PLUGIN is spending the money?** | `get_skill_attribution` (alias `skill-cost`) — tokens + USD per skill and per plugin from the `attributionSkill`/`attributionPlugin` stamps, exact and retroactive over all history (no hook, no OTEL). Counts usage ONCE per message id — a naive sum over-counts 2–5× (`duplicateRowsSkipped` reports the collapse). Sorted most-expensive-first. `--window N`, `--topN` |
| **What did each cache-breaking COMMAND cost?** | `get_cache_risk_costs` (alias `reload-cost`) — every prefix-breaking slash command priced exactly: `/reload-plugins`, `/reload-skills`, mutating `/plugin`, `/login`\|`/logout`, `/mcp`, `/model`. Causes are read off the transcript retroactively, not inferred; a command at T is billed on the FIRST turn at or after T. `byKind` for totals, `unexplainedReloadTurns` for co-churn inference (listed separately, never summed in). `--window`, `--kinds`, `--topN` |
| **Which plugin version is each session ACTUALLY running?** (stale-hook ghosts) | `get_loaded_plugin_versions` (alias `plugin-versions`) — a plugin update lands machine-wide but hooks/skills are SESSION-loaded, so a running session keeps executing old cached code until its own `/reload-plugins`. `loadedVersion` = MAX version observed (not latest-by-timestamp: compaction replays old skill loads as fresh records). `stale` is TRI-STATE — true \| false \| `'unknown'`. `--plugin`, `--activeMinutes`, `--staleOnly` |
| **When did this session /clear, /compact, fork, resume, or die?** | `get_lifecycle_events` — the harness events that bound and RESET a session, from the lifecycle hook store (needs `--install-hooks`). Includes StopFailure (turn death) and Pre/PostCompact; `/clear` is the cost REMEDY that resets the transcript floor. Per-turn Stop excluded by default. `--session`, `--kinds`, `--window`, `--limit`. Says `dirExists:false` honestly when the store is absent |

## Context-composition & session-drill tools

The cheat-sheet above is the burn/cost/cache core. This cluster answers "WHAT is in the context
and WHERE did it come from" — the raw-body forensics behind the dashboard's drill views. (Still:
`list --desc` is the full, never-stale index.)

| Question | Tool |
|---|---|
| WHAT occupies the context window per turn? (injected blocks: hook injections, skill/tool/agent/mcp catalogs, files) | `get_context_composition --sessionId <id>` |
| Full per-step context history from the raw `.jsonl`, every block drillable to its ACTUAL text (the cost/composition lens) | `get_context_history --sessionId <id>` |
| Cumulative context-size trajectory per turn (prompt size, cache-READ vs cache-CREATED split, new uncached) | `get_context_growth --sessionId <id>` |
| Biggest cumulative context contributors (turns × per-turn weight); flags RUNAWAY sources | `get_context_inflation_report` |
| Top context-consuming sources (files, tool outputs, rules, memories, catalogs) by cumulative token cost | `find_context_hogs` |
| Eviction-candidate finder: blocks (images, tool_results, pasted files, bash output) RESIDENT across many turns | `find_resident_blobs` |
| Generic composition query engine over the raw-body context blocks ("all possible queries") | `query_context_blocks` |
| Drill into ONE context block and return its ACTUAL text | `get_block_content` |
| The FULL literal context of ONE llm call — `{system, messages[], tools[]}` from the raw OTEL body | `get_call_context` |
| How many IMAGES a session sent + what re-reading them cost | `get_image_report` |
| Ranks WHO/WHAT burns the most of a cost BUCKET (cache_creation default; also output/input/total/billable_weighted) | `get_cache_creation_report` |
| Full timeline (LLM calls, tool calls, file edits) for one session | `get_session_detail --sessionId <id>` |
| One-call self-diagnostic for YOUR session (pass your workspace path; resolves the newest live session) | `get_session_status --workspace <path>` |
| Sub-agent spawn tree with each child's spawn-KIND (fork = cache-warm / fresh / worktree) | `get_subagent_tree --sessionId <id>` |
| Tokens-by-CAUSE attribution rollup — WHO spent the tokens | `get_cost_by_cause` |
| Diagnose prompt-cache breaks (the base report; `causes`/`timeline`/`gap` are the deeper cuts) | `get_cache_break_report` |
| Efficiency trends — are sessions getting more/less expensive; best agent/model combos; recurring problems | `get_efficiency_report` |
| Given a task, keyword-match past prompts → files accessed in similar sessions + est cost/turns | `find_relevant_context --task "<describe it>"` |
| Pending suggestions to improve a workspace's agent-instruction file (CLAUDE.md / AGENTS.md) | `get_instruction_suggestions --workspace <path>` |

Sibling PATH binary for the janitor heartbeat: `agentlenspro-heartbeat-cost --oneline` prints
the exact settled cost of the previous heartbeat fire. It ships as a bin of the agentlenspro
package, so any consumer (the janitor plugin included) invokes it by bare name — no package
paths, no repo checkout required.
