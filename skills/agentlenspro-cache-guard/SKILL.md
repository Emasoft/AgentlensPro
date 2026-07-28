---
name: agentlenspro-cache-guard
description: >-
  Keep images and bulk tool output from quietly dominating a session's token cost. Load this
  BEFORE reading screenshots, renders, diagrams, or PDFs for visual QA in a conversation that
  already has real history; before a long agentic loop that will look at pictures each round; and
  whenever someone asks why a session got expensive without doing much, why the 5h/7d window
  drained fast, or why cost keeps climbing after a screenshot. Teaches the resident-cost model
  (cost = turns x per-turn-context), batching image reads into one turn, delegating vision to an
  isolated-context subagent, writing findings down instead of re-reading, and keeping large tool
  output out of the transcript. Verification uses agentlenspro's own measurements, not estimates.
---

# Cache guard — why one screenshot keeps charging you

## The mechanism, stated exactly

A conversation's cost is `cost ≈ turns × per-turn-context`. The whole transcript is re-sent on
every request, so **anything you put in the context is paid for again on every turn that follows**,
until a compaction evicts it. Warm re-reads are cheap per token (cache read ≈ 0.1× base input) —
but 0.1× of a large block, times a few hundred turns, is not cheap.

An image is the worst offender because it is **dense and resident**: it contributes far more
tokens than the sentence you wrote about it, and it keeps contributing them long after you have
finished looking. The expensive thing is never the one read. It is the read multiplied by every
turn that comes after it.

> **A correction worth knowing.** A widely-shared write-up claims that an image *anywhere* in a
> request invalidates the entire message cache, so the next call rewrites the whole conversation at
> the write rate (~700× overhead). AgentlensPro measures 14 distinct causes of a prefix break —
> tools added/reordered, model/effort/fast-mode switches, MCP toggles, plugin and skill reloads,
> account switch, tool deny, injected-block mutation, compaction — and **an image read is not one
> of them**. Do not repeat the invalidation claim. You do not need it: resident cost alone is
> large, it is measured here, and every remedy below is the same either way.

Prices that *are* verified here, per token relative to 1× input: **cache read ≈ 0.1×**,
**output ≈ 5×**, **cache write 1.25× (5-minute tier) or 2× (1-hour tier)**. Claude Code puts
main-conversation turns on a subscription into the **1-hour** tier automatically; subagents are
always 5-minute. So the spread between reading cached context and rewriting it is up to **20×**,
not the 12.5× you will see quoted elsewhere.

## Rules

### R1 — Batch image reads into ONE message
Looking at 1 image and looking at 10 costs the same number of turns: one. Reading them one per
turn pays the growing context over and over for no extra information. Collect the paths, read them
all in a single message with parallel Read calls, and reach every conclusion in that same turn.

### R2 — Look once, write it down, never re-read
The moment you have looked, append the verdict to a notes file — filename → pass/fail → the fix
required. From then on cite the notes. Re-opening the image "just to check" buys nothing and adds
a second resident copy.

### R3 — Delegate the looking to a subagent (the best option in a large session)
A subagent has its own small context. The image lands in *its* few thousand tokens instead of your
few hundred thousand, its intermediate reasoning never enters your transcript, and you get back a
short text verdict. Give it the criteria explicitly — its eyes are as good as yours, its context is
not:

```
View these images and reply in TEXT ONLY — never return image data:
- <path> — check: <what "correct" means, concretely: no clipped or overlapping elements,
  expected labels present, values match the data below>
Reference (text): <the expected values / style rules / requirements>
For each image: PASS or FAIL, one line of reasoning, and the exact fix if FAIL.
```

### R4 — If you must look inline, look EARLY
The bill is (block size × turns remaining). The same screenshot read at turn 5 and at turn 300 of
the same session costs wildly different amounts. Front-load visual checks. In a session that is
already large, prefer R3 or a fresh session.

### R5 — Keep bulk output out of the transcript
- Verify builds and renders by **exit code, file size, or a grepped summary** — never by pasting
  the output in. Capture to a file first (`cmd > out.txt 2>&1`), then inspect the file.
- Read only the lines you need (`offset`/`limit`). Never paste base64.
- Write large intermediate results to disk and pass **paths**, not contents.

### R6 — Session hygiene for long or looping work
- A periodic monitor should run each round as a fresh short session with its state on disk, not as
  a wake-up inside one enormous conversation — the giant transcript is re-read every round.
- `/compact` immediately after an image-heavy stretch: that is what actually evicts the resident
  blocks. This is the single highest-value action after a batch of screenshots.
- Avoid needless mid-session `/reload-plugins`, `/reload-skills`, model switches, and MCP
  connect/disconnect. **Those** are the real prefix-break causes, and each one re-bills the entire
  prefix at the write rate.

## Decision table

| Situation | Do |
|---|---|
| Small session (<~50k), a few images, one-off check | Read inline, all in ONE message (R1), note the results (R2) |
| Large session (>~150k), or repeated visual checks | Delegate to a subagent (R3) |
| Loop that screenshots every round | Fresh short session per round, state on disk (R6) |
| Already looked at this image | Cite the notes; do NOT re-read (R2) |
| Need build/render verification | Exit code, file size, or grep — no dumps (R5) |
| Just finished an image-heavy stretch | `/compact` now (R6) |

## Verify it, don't estimate it

This project measures the thing directly — prefer these over any rule of thumb:

```bash
agentlenspro get_cache_event_log --out /tmp/cache.json   # one row per call, with the API's OWN
                                                         # cache_miss_reason — the ground truth
agentlenspro investigate_burn --windowHours 5            # culprits ranked by cache-WEIGHTED cost,
                                                         # not by raw tokens or request bytes
agentlenspro get_subscription_usage                      # Anthropic's own 5h/7d percentages
```

Healthy sessions show cache-read tokens far exceeding cache-creation tokens. Rank suspects by
**weighted cost**, never by raw token counts (windows are metered by cost) and never by request
size — a large request is *cheap* when it is a warm cache read, and only expensive when it is a
cold write.

## The pre-flight guard

AgentlensPro warns at the moment it can still change your mind: a PreToolUse hook on `Read` that
fires when the target is an image and the session is already large. It **warns and never denies** —
Read is a hot path, and the taxonomy above does not support treating an image read as a disaster.
A non-image read is answered locally with no network call, so ordinary file reading is untouched.

```bash
agentlenspro --hooks                       # show the switches
agentlenspro --hooks cacheguard=off        # silence just this guard, instantly, all sessions
AGENTLENS_CACHE_GUARD=off                  # per-process env equivalent
```

Turning the guard off leaves the agent-launch burn gate armed; the two switches are deliberately
separate.
