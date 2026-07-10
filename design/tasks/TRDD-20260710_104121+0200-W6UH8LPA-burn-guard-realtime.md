---
trdd-id: W6UH8LPA
title: check_burn_risk + CLI --guard — realtime early-warning against token explosions
column: complete
created: 2026-07-10T10:41:21+0200
updated: 2026-07-10T10:52:00+0200
last-test-result: pass
last-test-at: 2026-07-10T10:50:00+0200
current-owner: agentlens-session
task-type: feature
release-via: none
priority: 1
effort: M
labels: [diagnostics, realtime, guard, hooks]
parent-trdd: TRDD-TW14MO7A
test-requirements: [unit, typecheck, lint]
---

# Realtime burn guard

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-07-10

**COMPLETE — shipped + verified live 2026-07-10.** All 5 phases done: burnGuard.ts,
check_burn_risk MCP tool, CLI --guard transition-line loop, skill "Realtime guard" section
(arm via a background monitor BEFORE fan-outs, per-risk action table), 8 real-fs tests
(suite 530 passing). Live verify: the 8s guard loop immediately caught a REAL BURN_SPIKE
(1374k tokens/min — this fat session's own turns) with one transition line + advice, then
silence. Executed plan was:
1. `src/burnGuard.ts` (NEW): `checkBurnRisk()` fusing the three realtime sources the server
   already has — hook events (SubagentStart bursts ≥5/2min = fan-out storm; StopFailure ≤10min
   = cold-resume risk; PreCompact ≤5min = rewrite), raw-bodies dir stat scan (≥3 requests >1MB
   in 90s = fat-context fan-out IN FLIGHT), and the live burnMonitor (tokens/min spike).
   Honest `sources` block when a feed is absent (hooks not installed etc.).
2. MCP tool `check_burn_risk` in mcpServer.ts (burnStatus injected from the live monitor).
3. CLI `--guard [seconds]`: poll loop printing one `[burn-guard] CODE: detail` line per risk
   TRANSITION (silent while quiet) — designed to be armed via the harness Monitor tool so the
   agent is interrupted the moment a risk fires.
4. Skill: "Realtime guard" section — arm before fan-outs, what each risk means, what to DO.
5. Tests (real fs), gates, live verify, commit.

## Context

EHT of the 2026-07-10 incident + TW14MO7A: investigate_burn explains a drain AFTER the fact;
the user wants the CLI to WARN as the explosion starts. All needed signals already land in
realtime: OTLP metrics (4s burn tick), raw bodies (files at call time), lifecycle hook events
(SubagentStart/StopFailure/PreCompact via spy-agentlens.sh, shipped today in Q6ZOUVK5).
