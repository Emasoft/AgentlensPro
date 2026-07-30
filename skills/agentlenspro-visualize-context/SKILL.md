---
name: agentlenspro-visualize-context
description: >-
  Measure what a Claude Code agent actually puts in its context window, and what its SECOND turn
  costs — by spawning it for real and reading the raw API captures, not by guessing from its
  definition. Load this when someone asks how a new or custom agent compares to the built-in
  Explore / Plan / general-purpose agents, whether an agent is "lean", why a subagent is expensive,
  what CLAUDE.md or the MCP schemas or the skill listing cost inside an agent, or whether an
  agent's prompt cache survives from one turn to the next. Produces a measured element-by-element
  breakdown of turn 1 and turn 2, the exact diff between them, and a cache verdict that is
  predicted from the request bytes and then checked against what the API actually billed. Every
  number comes from count_tokens; nothing is estimated. Invoked as
  /agentlenspro-visualize-context <agent-name> [<agent-name> ...].
---

# Visualize an agent's context — and what its second turn costs

Turn 1 tells you what an agent costs to **start**. Turn 2 tells you what it costs to **keep
running**, and that depends entirely on whether the turn-1 prefix survived byte-exact. A lean agent
whose prefix breaks every turn is more expensive than a fat agent whose prefix holds.

You cannot answer either question from an agent's definition file. The harness resolves the declared
tool list down to what it actually sends (a probe declaring `Bash, Read, Grep, Glob` arrived as
`Bash, Read`), and the session JSONL records neither the system prompt, nor the tool schemas, nor
the injected context block. The captured raw request body is the only ground truth. So this skill
**spawns the agent for real** and reads what went to the API.

## When the answer is "you have to spawn it"

The subject agent is normally new — it has never run, so there is nothing on disk to read. Not
spawning it is not measuring it. That is why there is no "just analyse what's already there" mode
for the subject. The three baselines are different: they are the same on every invocation, so they
are measured once and cached.

## Procedure

### 1. Resolve the agents

Take the agent name(s) from the invocation, verbatim — including any plugin namespace
(`ai-maestro-janitor:janitor-repair-agent`). The subject is the first one named.

Baselines are `Explore`, `Plan`, `general-purpose`. Never rename or substitute them: the whole point
is a comparison against what Claude Code ships.

### 2. Show the cost BEFORE spawning anything

```bash
agentlenspro ctxvis --estimate --subject <agent>
```

It prints what would be spawned and roughly what it costs. First run measures the subject plus any
missing baseline (order of magnitude $2.50); later runs measure the subject alone. **Show this to the
user and let them see it before you spawn.** If they only wanted a cheap look, `--reuse-last`
re-renders the previous run without spawning anything.

### 3. Mint one nonce PER agent

Format: `AGENTLENS-CTXVIS-XXXXXXXX`, eight uppercase hex digits, a fresh one for each agent.

**One nonce for the whole run does not work.** With several agents under a single marker every
agent's turn 1 has the same message count, so there is no turn ordering at all and the tool can only
report the ambiguity. `ctxvis` hard-refuses anything that is not a minted nonce — a short marker like
`test` is a substring of half the captures on disk and would produce a confident, entirely fictional
report.

### 4. Spawn each agent with a prompt that forces exactly one tool call

Use the `Agent` tool with `subagent_type` set to the agent's name. The prompt must (a) contain the
nonce and (b) guarantee a second API call, which means exactly one tool call and then a reply:

```
AGENTLENS-CTXVIS-A1B2C3D4

This is a context-measurement probe, not a research task. Do exactly this and nothing more:

1. Make exactly ONE tool call — any tool you have. A trivial one is fine.
2. Then reply with exactly: DONE-AGENTLENS-CTXVIS-A1B2C3D4

Do not explore the codebase. Do not make additional tool calls. Do not write a report.
```

Keep the wording tool-agnostic — the agent may have no `Bash`, or no `Glob`. Spawn the agents close
together in time: the injected `gitStatus` block tracks the working tree and was measured drifting
3,404 → 18,618 tokens over 40 minutes, so a baseline captured under a different tree is not a
comparison of agents.

**An agent with zero tools can only ever produce one turn.** Say that plainly; do not present a
single bar as though it were a turn comparison.

### 5. Analyse

```bash
agentlenspro ctxvis \
  --subject <agent> \
  --measured '<agent>=<nonce>' \
  --measured 'Explore=<nonce2>' \
  --html reports/ctxvis/$(date +%Y%m%d_%H%M%S%z)-<agent>-context.html
```

Pass `--measured` once per agent you spawned. Baselines you did not spawn are loaded from the cache
and validated against the environment the subject was just measured in; if CLAUDE.md, the rules, the
MCP schemas or the skill listing have moved, the cached baseline is reported stale rather than
silently compared across two different worlds.

### 6. Report

Surface the verdict and the report path. Lead with the thing that decides cost:

- **prefix intact** — turn 1 is re-read at 0.1×; only the new tail is written. Cheap to keep running.
- **prefix broken at `<tier>[<i>]`** — everything from there is re-written at the write rate.

Then the cross-check. `ctxvis` predicts the surviving prefix from the request bytes and compares it
to the billed `cache_read`. When they agree, say so. When they do not, **report the disagreement
rather than the flattering number** — a confident wrong number is worse than an admitted
uncertainty, and this cross-check has already caught one wrong prediction of its own.

## What the numbers mean

- A cached segment ends at a `cache_control` breakpoint, so what survives a change is the last
  breakpoint **before** it — not the change's own position. A prefix that is byte-identical but sits
  before the first breakpoint is still re-written in full.
- Billed `cache_read` slightly **below** the predicted prefix is expected: a hit rounds down to the
  last breakpoint. A large shortfall is not, and is flagged.
- Cost weights, relative to 1× input: cache read ≈ 0.1×, output ≈ 5×, cache write 1.25× at the 5m
  tier and **2× at the 1h tier**. A freshly spawned subagent is always 5m. `ctxvis` bills from the
  response's own `usage`, including the 5m/1h split — never a flat write rate.

## Honesty requirements

- Never present an estimated number as measured. `ctxvis` refuses to run without a credential rather
  than fall back to the local estimator, which reads ~29% low on this content.
- Quote the tools the capture shows, never the agent definition's declared list.
- If the tool reports ambiguous turn ordering, re-run with a fresh nonce. Do not pick one.

## Verify

```bash
agentlenspro ctxvis --help          # the full flag surface
agentlenspro ctxmap <request.json>  # decompose any single captured request
```
