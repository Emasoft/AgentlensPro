---
trdd-id: RVKQDLRD
title: alcore background work runs at macOS background QoS so it never starves the user's apps
column: backburner
status: tasked
created: 2026-10-03T07:38:59+0200
updated: 2026-10-03T07:39:19+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-03T07:38:59+0200
parent-trdd: 9VX3WTGU
---

# alcore background work runs at macOS background QoS so it never starves the user's apps

## Approval log

- 2026-10-03T07:38:59+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

alcore background work (chores, rayon scan, log sweeper) shares normal-priority threads with the user's foreground apps and starves them on a loaded machine.

## Changes

1 set_background_qos() (macOS pthread QoS BACKGROUND). 2 second tokio runtime alcore-bg for chores. 3 inline boot chore passes move off the pre-bind path onto the bg runtime, same order. 4 rayon global pool 4 threads at background QoS. 5 log-sweeper lowers QoS only after boot restore+sweep (state lock priority inversion).

## Verification

Tests assert QOS_CLASS_BACKGROUND via pthread_get_qos_class_np on a thread and on a bg-runtime task; mutation check with a no-op set_background_qos; cargo build/test/clippy.
