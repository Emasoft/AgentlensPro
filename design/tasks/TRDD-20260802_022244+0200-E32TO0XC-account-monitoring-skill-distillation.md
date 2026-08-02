---
trdd-id: E32TO0XC
title: Distill a definitive set of account-monitoring skills from the 81-project corpus
column: backburner
created: 2026-08-02T02:22:44+0200
updated: 2026-08-02T02:22:44+0200
current-owner: unassigned
task-type: artifact
npt: []
eht: []
---

# Distill a definitive set of account-monitoring skills from the 81-project corpus

## Status — DEFERRED ON PURPOSE

The owner supplied the corpus and asked for this **later**, not now. It sits in `backburner` until
they pull it forward. Do not start it because the board looks idle.

## Why

Account monitoring — usage windows, plan limits, multi-account rotation, status-line rendering, cost
accounting — is the one area where a large body of independent community work already exists, and
AgentlensPro has been re-deriving parts of it in isolation. The measured cost of that isolation is
concrete: the `/api/oauth/usage` reverse-engineering, the 5h/7d window inference, the TTL-tier
pricing table and the status-line payload schema were each worked out here from scratch, and at
least one of them (the undocumented usage endpoint, credited to `pizzimenti/ccgauge`) already came
from exactly this kind of source.

The corpus is **81 zipped projects, ~397 MB**, in `downloads_dev/claude account switchers projects/`
(gitignored — a stranger cloning this repo will not have it; it is an input the owner supplies).
Names visible in the listing span at least five distinct problem families: account switchers
(`cc-switch`, `ccswitch`, `claude-code-multi-account-*`, `Claude_Code_Multiple_Login`), usage
monitors (`ccusage`, `Claude-Code-Usage-Monitor`, `cc-metrics`, `AIBattery`), status lines
(`cc-statusline`, `claude-code-statusline`, `claude-code-multi-account-statusline`), brokers/gateways
(`ccbroker`, `aigate`, `ai-ops`), and managers/control planes (`claude-command-center`,
`claude-control`, `Claude-Code-Manager`).

## Scope

The deliverable is a **set of skills** (this repo's `skills/`), not a rewrite of the product. Skills
are where distilled knowledge belongs: they cost nothing until loaded, and they are the surface the
owner already uses for `agentlenspro-diagnostics`.

## Method — follow the standing rule, do not re-invent one

`~/.claude/rules/corpus-to-plugin-distillation.md` governs this task end to end (JOB A: build from
existing components; JOB B: three strict phases — CAPTURE ALL → ATOMIZE + CATEGORIZE → COMPARE →
DECIDE → MERGE → INTEGRATE; default is 3 = MERGE = UNION). Read it in full before starting. The
notes below are only what is specific to THIS corpus.

## Acceptance

- [ ] Every one of the 81 archives is opened and accounted for — including the ones that turn out to
      be worthless. A corpus sweep that silently skips N inputs reads as "covered everything".
- [ ] JOB B phase 1 completes across the WHOLE corpus before any skill is written. Integrating a
      technique from batch 1 and then finding a better one in batch 6 means rewriting the skill.
- [ ] Every technique is checked against the CURRENT Claude Code surface before it is kept. This
      corpus is dated: several projects predate the status-line payload this repo now captures
      directly, and a technique that polls an endpoint we already receive for free is not an
      improvement to merge — it is a regression to reject with the reason written down.
- [ ] Anything that contradicts a measured fact in `CLAUDE.md` or `.claude/project/memory/` is
      escalated, not silently adopted. The TTL-tier model, the "windows are metered by COST" rule and
      the cache-break cause list were each measured here; a community project asserting otherwise is
      a claim to verify, not a correction to apply.
- [ ] Malware / prompt-injection pre-scan on every archive before any agent reads its contents, and
      every worker prompt states that corpus text is UNTRUSTED DATA. 81 archives from 81 strangers is
      the exact shape the injection guard exists for.
- [ ] Attribution: any technique taken recognizably from one project credits it, as the usage
      endpoint already credits `ccgauge`.

## Deliberately NOT in scope

Adopting another project's account-**rotation** machinery. This repo has a measured position on that
(rotating accounts does not reduce burn — it changes who pays for the same cold writes), and the
owner's standing direction is that AgentlensPro measures rather than manages. Mine those projects for
what they KNOW about limits and windows, not for their switchers.

## Note for whoever picks this up

Read the corpus with a subagent fleet, not in the main context — 397 MB of third-party source is the
canonical way to destroy a session's cache prefix. Per-archive extraction and triage is mechanical
work for `sonnet[1m]`; only the COMPARE → DECIDE phase needs the expensive model, and only on the
atomized list, not the source.
