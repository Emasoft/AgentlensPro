---
name: agentlenspro-identity
description: "what is this repo / where did it come from / is this the fork or the original agentlens / where is the old tree / what shipped in v1.0.0 / no-squash merge policy"
ocd: 2026-07-10
lmd: 2026-07-10
metadata:
  node_type: memory
  type: project
  tier: hub
---

**AgentlensPro** is an independent project born 2026-07-10 as a fork of
[AgentLens](https://github.com/RogerReed/agentlens) (acknowledged in the README; MIT, dual
copyright). Canonical repo: `Emasoft/AgentlensPro` (public). The pre-fork checkout at
`~/Code/agentlens` is a frozen ARCHIVE — local commits only, NEVER push (its origin is the
original author's repo). Full 586-commit history was preserved; **merge policy is `--no-ff`,
never squash**.

**v1.0.0 (2026-07-10, tag on 9294469)** shipped the whole independence roadmap in one day:
- P2 `src/shared/` single-source modules + anti-mirror CI guard (killed the webview
  hand-mirroring; first run caught a real triplicated `TokenSource`)
- P3 `disjointBuckets()` — the four-disjoint-buckets token invariant is compile-shaped;
  timeline entries raw on both feeds (ingest v6)
- P4 segmented append-only span store (daily NDJSON + retention; NO 50k eviction — it was
  measured losing 1,700 spans per restart)
- P5 window-capacity auto-calibration from rate-limit StopFailures (`capacitySource: observed`)
- P6 keepWarm cache-gap diagnostic + burn-gate SendMessage coverage + `degradations` counters
- P7 `tokensSource`/`coverageNote` provenance stamped at `feedMergePolicy`
- P8 async sub-agent token resolution from `subagents/*.jsonl` (ingest v7); upstream gap filed
  as anthropics/claude-code#76484
- P9 headless puppeteer dashboard smoke suite (env-gated `AGENTLENSPRO_BROWSER_TESTS=1`)
- P10 PATH-bin hooks (`agentlenspro-hook`/`agentlenspro-gate` — Homebrew-safe registrations),
  SLSA provenance on release workflows, docs truth-pass

**Deployment contract**: everything user-facing goes through PATH bins (`agentlenspro`,
`agentlenspro-cli`, `agentlenspro-heartbeat-cost`, `agentlenspro-hook`, `agentlenspro-gate`) —
the installed skill and any plugin must never reference package-internal or repo paths.
Compat surfaces KEPT on purpose: `~/.agentlens` data dir, `AGENTLENS_*` env vars.

Known follow-ups: npm publish needs the first-time `agentlenspro` package registration on
npmjs (owner action); native-Windows installer support remains future work.

## Notes and lessons learned
