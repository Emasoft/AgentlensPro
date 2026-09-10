---
name: agentlenspro-identity
description: "what is this repo / where did it come from / is this the fork or the original agentlens / where is the old tree / what shipped in v1.0.0 / no-squash merge policy"
ocd: 2026-07-10
lmd: 2026-09-09
metadata:
  node_type: memory
  type: project
  tier: hub
publish-globally: false
---

^VYGV50GT [desc:"AgentlensPro forked from AgentLens on 2026-07-10; canonical repo Emasoft/AgentlensPro; the pre-fork checkout is a frozen, never-pushed archive; merge policy is --no-ff, never squash", keywords:"what_is_this_repo where_did_agentlenspro_come_from is_this_the_fork_or_the_original_agentlens where_is_the_old_agentlens_tree is_agentlenspro_a_fork no_squash_merge_policy canonical_repo_name pre-fork_archive_frozen never_push_the_old_tree merge_policy_no-ff", ocd:2026-07-10, lmd:2026-09-09]
**AgentlensPro** is an independent project born 2026-07-10 as a fork of
[AgentLens](https://github.com/RogerReed/agentlens) (acknowledged in the README; MIT, dual
copyright). Canonical repo: `Emasoft/AgentlensPro` (public). The pre-fork checkout at
`~/Code/agentlens` is a frozen ARCHIVE — local commits only, NEVER push (its origin is the
original author's repo). Full 586-commit history was preserved; **merge policy is `--no-ff`,
never squash**.

^IDJFMU4E [desc:"v1.0.0 (2026-07-10, tag 9294469) shipped the whole independence roadmap in one day: P2 shared modules, P3 token buckets, P4 span store, P5 capacity calibration, P6 keepWarm, P7 provenance, P8 subagent tokens, P9 browser tests, P10 PATH-bin hooks", keywords:"what_shipped_in_v1.0.0 v1.0.0_release_contents independence_roadmap_items tag_9294469 span_store_no_50k_eviction window_capacity_auto_calibration_from_StopFailures subagent_token_resolution_ingest_v7 anthropics_claude-code#76484 headless_puppeteer_dashboard_smoke_suite PATH-bin_hooks_homebrew-safe", ocd:2026-07-10, lmd:2026-09-09]
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

^DI4QITMM [desc:"Deployment contract: v2.0.0 replaced five PATH bins with exactly ONE executable, agentlenspro, exposing setup/server/hook/gate/heartbeat-cost/dashboard; compat surfaces (~/.agentlens data dir, AGENTLENS_* env vars) kept on purpose", keywords:"how_many_executables_does_agentlenspro_ship one_executable_deployment_contract agentlenspro_subcommands setup_server_hook_gate_dashboard compat_env_vars_AGENTLENS agentlens_data_dir_kept_on_purpose installed_skill_must_not_reference_repo_paths five-bin_form_superseded", ocd:2026-07-11, lmd:2026-09-09]
**Deployment contract (v2.0.0 superseded the five-bin form[^1])**: exactly ONE user-facing
executable, `agentlenspro` — subcommands `setup` / `server …` / `hook` / `gate` /
`heartbeat-cost` / `dashboard` / the full diagnostics surface. The installed skill and any
plugin must never reference package-internal or repo paths. Compat surfaces KEPT on
purpose: `~/.agentlens` data dir, `AGENTLENS_*` env vars.

^EB7D8GSZ [desc:"State 2026-07-11 (v2.1.0 live): published on npm via OIDC trusted publishing through 1.0.0/1.0.1/2.0.0/2.1.0; release = push a tag; TRDD-VY1IUVUM in flight (TTL-regime diagnostics); native-Windows installer remains future work", keywords:"current_release_state_of_agentlenspro npm_publish_history_oidc_trusted_publishing how_do_i_release_agentlenspro release_is_push_a_tag which_versions_shipped_what in-flight_trdd_vy1iuvum windows_installer_not_supported_yet where_is_the_publish_pipeline_doc", ocd:2026-07-11, lmd:2026-09-09]
**State as of 2026-07-11 (v2.1.0 live)**: published on npm as `agentlenspro` under OIDC
trusted publishing — 1.0.0 (local bootstrap), 1.0.1 (gate/diagnostics field fixes; first
CI/OIDC publish), 2.0.0 (single executable + the idempotent `setup` install/repair verb),
2.1.0 (`get_agent_tokens` per-agent exact query, CC-footer reconcilable). Release = push a
tag; see [[agentlenspro-publish-pipeline]]. Operations doctrine: [[agentlenspro-ops-lessons]].
Cache accounting truths: [[cache-ttl-model]] + [[agentlens-burn-token-model]]. In flight:
TRDD-VY1IUVUM (TTL-regime-aware diagnostics, v2.2.0). Native-Windows installer support
remains future work.

## Notes and lessons learned

[^1]: [id:ATOM-FIVE-BIN-DEPLOYMENT-SUPERSEDED, status:valid, keywords:"five_path_bins_removed one_executable_agentlenspro v2.0.0_single_bin doc_or_config_naming_old_bins_is_stale", ocd:2026-07-11, lmd:2026-07-11] v1.x shipped five PATH bins
  (`agentlenspro-cli/-hook/-gate/-heartbeat-cost` + `agentlenspro`); the USER ordered ONE
  executable and v2.0.0 removed the other four (hook registrations became the command
  strings `agentlenspro hook`/`agentlenspro gate`, auto-migrated by `setup`). Any doc or
  config still naming a five-bin form is stale.
