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

If any agentlenspro command prints "agentlenspro is DISABLED", run the reactivate command it prints; do not retry the original command.
`server`/`daemon` restarts do not self-heal the install: run any other agentlenspro command, or `agentlenspro enable`, to repair.

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

This applies to `--guard` too (routing table above): whichever you arm, do it as a Monitor watch
with `timeout_ms: 1800000` (30 minutes is the hard ceiling — 10 in a `-p` run). **Every such watch
ends at its deadline with a notice, not a renewal** — it is blind until you re-arm it. Re-arming
`budget --minutes N` needs a correction (it counts from its OWN start, so replaying the original N
after 30 minutes have elapsed silently adds the elapsed time back on — pass the minutes still
left); `--guard N` and `watch`'s poll interval take no such correction, just re-issue the same
command. Full re-arm recipe and the abort/blind-gap details: [references/budget.md](references/budget.md),
[references/guard-and-gate.md](references/guard-and-gate.md).

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

Three more things a program needs:

- **`--json` is a global.** It works on every tool and overrides the human rendering, so a tool
  that normally prints a table still gives you JSON. `--out FILE` writes the full payload to disk
  and prints a digest instead; on a refusal the file is **not** written.
- **A refusal never writes `--out`.** A file containing `{"error": …}` is worse than no file,
  because the next reader finds it and trusts it.
- **A refusal may carry a `notices` array.** If the same launch repaired the install or warned (a first-run or
  `agentlenspro: restored …` line), those lines travel INSIDE the refusal — `{"tool": "...", "error": "...",
  "notices": ["agentlenspro: ..."]}` — so stderr is still exactly one JSON object. The key is absent when there
  is nothing to report; on any other exit the same lines print on stderr as plain text.

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

## Where the rest of this document is — reference files, read on demand

This file holds only what every use needs: the routing table above, the exit-code contract, the
failure table, the command forms and the rules for agents. Everything else lives in `references/`
next to this file — open the one your question needs, and only that one. The section names that the
text refers to in **bold** are listed here with the file that holds them.

| If you need | Read |
|---|---|
| what each metric IS (cumulative / rolling / rate / gauge), the scopes, the honesty rules | [references/taxonomy.md](references/taxonomy.md) — **Taxonomy** |
| six end-to-end walkthroughs (self-aborting batch, live burn, spike alerts, run cost, durable log, post-mortem) | [references/worked-examples.md](references/worked-examples.md) — **Worked examples** |
| every CLI option, the hook events, the bodies lifecycle, the output formats | [references/commands-and-options.md](references/commands-and-options.md) — **Options (concise)**, **Output formats** |
| installing, repairing, starting or stopping anything; `config`, `env`; turning AgentlensPro itself off | [references/operations.md](references/operations.md) — **Install / repair**, **Server, daemon & telemetry control**, **Local commands**, **Emergency stop** |
| realtime risk flags and what to DO about each; what the burn-gate blocks automatically | [references/guard-and-gate.md](references/guard-and-gate.md) — **Realtime guard**, **The burn-gate** |
| the full `budget` flag surface and the abort recipe | [references/budget.md](references/budget.md) — **Budgeting a timed run** |
| the full `watch` flag surface, metrics, and durable logging | [references/watch.md](references/watch.md) — **Watching ANY metric for peaks** |
| why a 20-minute gap is NOT a cold cache; `cache-expired`, `cache-state`, `last-compact` | [references/cache-ttl.md](references/cache-ttl.md) — **Cache TTL tracking** |
| the per-call cache ledger, Anthropic's own window usage, every account's headroom | [references/windows-and-ledger.md](references/windows-and-ledger.md) — **The per-call ledger**, **Authoritative window usage**, **Every account** |
| what is running in THIS project and what it cost; per-subagent context fill | [references/statusline-history.md](references/statusline-history.md) — **Per-project and per-subagent history** |
| every tool, by the question it answers | [references/tool-cheat-sheet.md](references/tool-cheat-sheet.md) — **High-value tools (cheat-sheet)**, **Context-composition & session-drill tools** |

The four rules that keep a diagnosis cheap (batch, `--out`, never paste JSON) are **Rules for
agents**, at the end of this file.

## Commands

```bash
agentlenspro list --desc                    # every tool + one-line description
agentlenspro help <tool>                    # a tool's description + typed flags (live schema)
agentlenspro <tool> [--param value ...]     # direct call
agentlenspro call <tool> '<json-args>'      # raw JSON args object
agentlenspro batch '<json-array>'           # N tools in ONE invocation: [{"tool":"…","args":{…}}]
```

## Reconfiguring hooks without a restart

Two layers, two lifecycles. Hook **registrations** (the entries in Claude Code's settings.json) are
read only at session start: after `agentlenspro setup` or `--install-hooks` restart sessions once.
Hook **behavior** is hot: the server re-reads the dashboard toggle file (`~/.agentlens/hook-config.json`, created when a toggle is saved) on every request, so
`agentlenspro --hooks gate=off|warn|enforce capture=on|off advisor=on|off cacheguard=on|off` (or
`POST /api/hook-config` with a JSON patch) takes effect in every running session immediately. The
gate also honors the `AGENTLENS_GATE=off` environment variable, read on each invocation.
`agentlenspro setup` ends with a read-only `memory-check` (the last 60-second composition line in
`server.log`: live + free-in-page should equal committed within 1 MB).

The synchronous hooks (gate, review-gate, review-supervisor) are registered with a 120 s ceiling, so
under a wedged server or extreme load one can hold a turn for up to 120 s; the escape hatch is
`AGENTLENS_GATE=off` (or `agentlenspro --hooks gate=off`).

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

