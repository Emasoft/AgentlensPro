---
name: agentlenspro-ops-lessons
description: "how to deploy agentlenspro on a machine / setup vs manual install / hooks stopped firing after an upgrade / config file wiped or corrupted after an edit / server hangs or times out / a test is flaky or CI is red but local is green / an identity or address leaked to a github post / the diagnostics skill or CLI drifted / a server crashed with no error / DuckDB or the span store misbehaved / where do I find the AgentlensPro operational field lessons"
ocd: 2026-07-11
lmd: 2026-09-26
metadata:
  node_type: memory
  type: project
  tier: aspect
publish-globally: false
split-lineage: 266022327e5e4d3796245d2d1a921c06
---

AgentlensPro's operational field lessons — how to deploy, install, and run it, and the
recurring failure classes hit while doing so. This page is a map; the detail lives in the
sub-pages below, split out because the combined history outgrew a single page.

^OPSLESN1 [desc: "Deployment and install lessons live in the deploy-and-install sub-page: setup/install/upgrade paths, npm link vs registry, platform support, port/data-dir isolation, and the is-my-fix-actually-live pitfalls.", keywords: deploy install upgrade setup npm link registry platform support port data-dir isolation is my fix actually live stale bundle]
- [[agentlenspro-ops-lessons-deploy-and-install]] — setup/install/upgrade, npm link vs
  registry, platform support, port/data-dir isolation, and "is my fix actually live" pitfalls.
^OPSLESN2 [desc: "Span/OTLP store lessons live in the store-durability-and-memory sub-page: large-file reads, OOM, fsync/durability, the RAM-disk spool drain (removed 2026-09-25, capture writes raw bodies to SSD), and DuckDB read gotchas.", keywords: span store OTLP durability large file read OOM fsync RAM disk spool drain DuckDB capture SSD write gotcha]
- [[agentlenspro-ops-lessons-store-durability-and-memory]] — the span/OTLP store: large-file
  reads, OOM, fsync/durability, the RAM-disk spool drain (spool removed 2026-09-25 — capture now writes raw bodies straight to SSD), and DuckDB read gotchas.
^OPSLESN3 [desc: "Concurrency and event-loop lessons live in the concurrency-and-event-loop sub-page: server hangs, event-loop starvation, connect timeouts, config-write races, single-instance locking, and log-tail scoping.", keywords: server hang event loop starvation connect timeout config write race single instance lock log tail scoping]
- [[agentlenspro-ops-lessons-concurrency-and-event-loop]] — server hangs, event-loop starvation,
  connect timeouts, config-write races, single-instance locking, and log-tail scoping.
^OPSLESN4 [desc: "Testing and process-hygiene lessons live in the testing-and-process-hygiene sub-page: background-agent liveness, flaky tests, CI-vs-local drift, GitHub identity/mention leaks, and hook-messaging policy.", keywords: background agent liveness flaky test CI local drift github identity mention leak hook messaging policy]
- [[agentlenspro-ops-lessons-testing-and-process-hygiene]] — background-agent liveness, flaky
  tests, CI-vs-local drift, GitHub identity/mention leaks, and hook-messaging policy.

^OPSLESN5 [desc: "This ops-lessons aspect is governed by cache-ttl-model (TTL regimes) and agentlens-burn-token-model (accounting), with lateral see-also to the publish pipeline and the project-identity hub.", keywords: governed by cache ttl model burn token accounting publish pipeline identity hub see also]
Governed by [[cache-ttl-model]] (TTL regimes) and [[agentlens-burn-token-model]]
(accounting); see also [[agentlenspro-publish-pipeline]], [[agentlenspro-identity]] (the
project-identity hub this operational doctrine serves).

## Notes and lessons learned

