---
trdd-id: 52I57XLS
title: The json and parquet DuckDB extensions are autoloaded at runtime instead of statically linked
column: backburner
status: tasked
created: 2026-10-22T18:17:07+0200
updated: 2026-10-22T18:17:17+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T18:17:07+0200
---

# The json and parquet DuckDB extensions are autoloaded at runtime instead of statically linked

## Approval log

- 2026-10-22T18:17:07+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

rust-core builds the duckdb crate with features [bundled] only (agentlens-store/Cargo.toml:9, agentlens-digest/Cargo.toml:16); libduckdb-sys statically compiles only core_functions unless the json and parquet features are on, so both extensions are autoloaded from ~/.duckdb/extensions/v1.5.6 at runtime.
A machine without those cached extensions (fresh install, offline) cannot read or write the store. design/specs/duckplan/SPEC-schema.md:56-58 already plans enabling the features, turning autoload off, and a startup self-test.
Unverified: the release binary is stripped, so static linking was inferred from the build script gate, not observed.
