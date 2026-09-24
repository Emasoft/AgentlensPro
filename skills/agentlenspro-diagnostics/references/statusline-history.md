# agentlenspro-diagnostics — Per-project and per-subagent history

> Reference file, read on demand from [../SKILL.md](../SKILL.md). Section names in **bold** that
> are not in this file are listed, with the file that holds them, in that index.

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

