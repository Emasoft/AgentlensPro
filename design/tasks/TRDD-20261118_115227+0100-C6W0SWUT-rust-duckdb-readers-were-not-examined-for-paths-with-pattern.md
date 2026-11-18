---
trdd-id: C6W0SWUT
title: Rust DuckDB readers were not examined for paths with pattern characters
column: todo
status: tasked
created: 2026-11-18T11:52:27+0100
updated: 2026-11-18T11:52:27+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T11:52:27+0100
---

# Rust DuckDB readers were not examined for paths with pattern characters

Opened 2026-11-18 by the main agent from TRDD-CXNUWXX7. Measured there (DuckDB v1.5.4, node package, macOS): read_json_auto, read_json, read_ndjson, read_ndjson_objects and read_parquet read a path holding star, question mark or open bracket as a file pattern when the path is only quote-doubled. The Rust crates under rust-core also build DuckDB read calls from paths under the data dir (for example read_json_auto in rust-core/crates/agentlens-core/src/statusline_store.rs). NOT known: which helper quotes the path at each Rust site, and whether the bundled DuckDB of the Rust crates expands such a path the same way.

## Acceptance
- [ ] Every DuckDB file read site of the Rust crates is listed with the code that quotes its path.
- [ ] It is measured with the Rust binary whether a data dir holding star, question mark or open bracket is read as a pattern.
- [ ] Either the sites use one escaping helper with a committed test, or it is written here why they cannot receive such a path.

## Approval log

- 2026-11-18T11:52:27+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
