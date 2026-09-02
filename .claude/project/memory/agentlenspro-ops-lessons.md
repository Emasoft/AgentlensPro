---
name: agentlenspro-ops-lessons
description: "how to deploy agentlenspro on a machine / setup vs manual install / hooks stopped firing after an upgrade / config file wiped or corrupted after an edit / server hangs or times out / a test is flaky or CI is red but local is green / an identity or address leaked to a github post / the diagnostics skill or CLI drifted / a server crashed with no error / DuckDB or the span store misbehaved / where do I find the AgentlensPro operational field lessons"
ocd: 2026-07-11
lmd: 2026-09-02
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

- [[agentlenspro-ops-lessons-deploy-and-install]] — setup/install/upgrade, npm link vs
  registry, platform support, port/data-dir isolation, and "is my fix actually live" pitfalls.
- [[agentlenspro-ops-lessons-store-durability-and-memory]] — the span/OTLP store: large-file
  reads, OOM, fsync/durability, the RAM-disk spool drain, and DuckDB read gotchas.
- [[agentlenspro-ops-lessons-concurrency-and-event-loop]] — server hangs, event-loop starvation,
  connect timeouts, config-write races, single-instance locking, and log-tail scoping.
- [[agentlenspro-ops-lessons-testing-and-process-hygiene]] — background-agent liveness, flaky
  tests, CI-vs-local drift, GitHub identity/mention leaks, and hook-messaging policy.

Governed by [[cache-ttl-model]] (TTL regimes) and [[agentlens-burn-token-model]]
(accounting); see also [[agentlenspro-publish-pipeline]], [[agentlenspro-identity]] (the
project-identity hub this operational doctrine serves).

## Notes and lessons learned

