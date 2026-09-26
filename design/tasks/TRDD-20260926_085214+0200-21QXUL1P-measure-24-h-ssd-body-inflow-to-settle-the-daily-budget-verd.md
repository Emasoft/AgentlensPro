---
trdd-id: 21QXUL1P
title: Measure 24 h SSD body inflow to settle the daily-budget verdict the 240s window cannot
column: todo
status: tasked
created: 2026-09-26T08:52:14+0200
updated: 2026-09-26T08:52:14+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-26T08:52:14+0200
---

# Measure 24 h SSD body inflow to settle the daily-budget verdict the 240s window cannot

REQUIRED FOLLOW-UP of the 2026-09-26 adversarial review chain on the ssd-write-economics memory lesson (TRDD-Z53IJFE9 post-removal re-measure). What exists: ONE 240 s sampled window during active work measured gross body inflow ~13.5 MB/min (drain emptied ~48.8 MB) and net accumulation ~1.35 MB/min (dir held ~41 MB); extrapolated 24/7 that is ~19.4 GB/day (48-162x over the superseded 120-400 MB/day figure), but a real day includes idle hours and the 24 h AVERAGE IS UNMEASURED. The memory lesson correctly labels the figure PEAK-not-daily and says 'DO schedule a 24 h inflow measurement' — this card is that owner; nothing else schedules it. WHY IT MATTERS: the net floor (~2 GB/day) is comfortably under the owner's 15 GB/day target, the 24/7 gross extrapolation (~19.4 GB/day) is over it — which side of the target a real day falls on decides whether compression work is owed. METHOD (paste from the 2026-09-26 monitor): sample ~/.agentlens/otel-bodies with a 2 s seen-set over >=24 h, compute gross inflow = drain-throughput + dir delta; record BOTH the gross daily figure and the daily idle-vs-active split (the active-work inflation is the known confound — this session's own API traffic generates bodies). CAVEAT from the same review chain: the server was crash-looping on the 2 GB RSS cap during the 240 s window (TRDD-563B8WYH) — settle or bound that first if the loop still fires, since restart churn perturbs both the drain and the measurement. OUTCOME: one measured daily figure recorded into the ssd-write-economics lesson via memgrep verbs, superseding the PEAK-only framing; if the 24 h average lands under the 15 GB/day target, the compression-lever guidance gets demoted to conditional.

## Approval log

- 2026-09-26T08:52:14+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
