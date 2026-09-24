---
trdd-id: M3TWPLZO
title: Delete the remaining dead TS modules the TS server retirement left behind
column: backburner
created: 2026-09-24T11:04:10+0200
updated: 2026-09-24T11:04:33+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: refactor
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T11:04:10+0200
---

# Delete the remaining dead TS modules the TS server retirement left behind

Follow-up to TRDD-4BZPAQWM commit A (a81972f9), which deleted only the 9-file src/database/* + sessionRepository.ts cluster. This card covers the remaining 24 files dead-module-set.md Section 4 identified but commit A did not touch, plus their test fallout and prose fallout. Evidence: reports/4BZPAQWM/20260924_104703+0200-dead-module-set.md (cited section numbers below are in that report).

## Approval log

- 2026-09-24T11:04:10+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Remaining 24 DEAD files (Section 4, minus the 9 a81972f9 deleted)

src/admissionController.ts, src/basePath.ts, src/capacityCalibration.ts, src/cli/reviewLoop.ts, src/collectorState.ts, src/derivedCache.ts, src/embedAuth.ts, src/exportData.ts, src/genAiContent.ts, src/hookRuntimeConfig.ts, src/instructionEffectiveness.ts, src/loopWatchdog.ts, src/otlpCollector.ts, src/otlpLogEvents.ts, src/otlpParser.ts, src/resourceMonitor.ts, src/sessionStore.ts, src/shared/cacheClassification.ts, src/shellTemplate.ts, src/spoolBackpressure.ts, src/store/archiveVerify.ts, src/store/migrateArchive.ts, src/types.ts, src/vscodeCompat.ts

## DELETE-WITH test files (Section 5, 15 remaining, reingest.test.ts already deleted)

src/test/admissionControl.test.ts, src/test/basePath.test.ts, src/test/bodiesFlushLaw.test.ts, src/test/cacheClassification.test.ts, src/test/cacheClassificationEdges.test.ts, src/test/cacheElementKey.test.ts, src/test/derivedCache.test.ts, src/test/embedAuth.test.ts, src/test/hookRuntimeConfig.test.ts, src/test/loopWatchdog.test.ts, src/test/otlpCollector.test.ts, src/test/reviewLoop.test.ts, src/test/shellTemplate.test.ts, src/test/spoolBackpressure.test.ts, src/test/spoolEvacuation.test.ts

## EDIT test files — strip dead imports, keep the rest (Section 5, 9 remaining, 8 database/sessionRepository rows already gone)

src/test/archiveVerify.test.ts (drop store/archiveVerify.ts), src/test/capacityCalibration.test.ts (drop capacityCalibration.ts), src/test/cliContract.aimaestro.test.ts (drop embedAuth.ts), src/test/collectorState.test.ts (drop collectorState.ts), src/test/fallbackCounters.test.ts (drop collectorState.ts), src/test/migrateArchive.test.ts (drop store/migrateArchive.ts), src/test/otlpParser.test.ts (drop otlpParser.ts), src/test/rustIngest.test.ts (drop otlpCollector.ts), src/test/sessionStore.test.ts (drop sessionStore.ts). Section 5's own caveat: only archiveVerify.test.ts, migrateArchive.test.ts and cliContract.aimaestro.test.ts genuinely test live behaviour alongside the dead import — the other 6 are EDIT only by the mechanical letter of the rule and are much closer to DELETE-WITH; look at each before deciding.

## Prose fallout (Section 7, minus what a81972f9 already fixed at CLAUDE.md:131/145 and the ARCHITECTURE.md database cluster)

ARCHITECTURE.md: admissionController.ts:385, types.ts:1155/1163/1183/1236 (media/src/types.ts is a DIFFERENT live file with the same basename — verify per-hit before editing), exportData.ts:1152, genAiContent.ts:347, otlpCollector.ts:1131, otlpParser.ts:1132, resourceMonitor.ts:385, sessionStore.ts:1133, archiveVerify.ts:457, migrateArchive.ts:442/455, vscodeCompat.ts:93. .claude/project/memory/**: admissionController.ts and resourceMonitor.ts globs in always-on-ingestion-model.md; collectorState.ts in agentlens-burn-token-model.md:79; embedAuth.ts in standalone-server-security-model.md:50; genAiContent.ts in otlp-ingest-topology.md:27; otlpCollector.ts/otlpParser.ts/otlpLogEvents.ts already documented as dead-in-prod in otlp-ingest-topology.md and agentlens-burn-token-model.md, just tidy the globs. design/tasks/*.md (top-level, count only, historical — leave alone unless actually editing the referenced code): reviewLoop.ts x2, cacheClassification.ts x3, spoolBackpressure.ts x4.

## CLAUDE.md stale mock-dir line

"Unit tests mock the vscode module via src/test/setup.js -> src/test/__mocks__/vscode.js" is stale: TRDD-6E6416B8 commit 1ca6bce deleted src/test/__mocks__/; dead-module-set.md Section 5 confirms no __mocks__/ directory exists in this repo. Fix or delete that sentence.

## Warning — do not delete by bundle reachability alone

46 TS modules that are absent from the esbuild bundles are LIVE: they are the parity oracles rust-core/**/*.mjs gen-*.mjs generators run to pin the Rust port's behaviour byte-for-byte (dead-module-set.md Section 2/3). A naive esbuild-metafile-only reachability pass (the report's own discarded first attempt) found 89 'dead' files; adding the 46 fixture-generator roots and their transitive closure shrank it to the true 33. Before deleting anything on this card, re-run that closure check against the current tree — do not trust a bundle-reachability grep alone.
