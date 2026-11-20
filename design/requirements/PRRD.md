---
prrd-version: 1.0
updated: "2026-11-19T23:25:36+0100"
project: agentlenspro
project-id: agentlenspro
canonical-source: design/requirements/PRRD.md
mirrors: []
---

# Project Requirements & Rules

## §I. How to read this document

Rule citation form: `PRRD G<n>.<v>` or `PRRD S<n>.<v>`. See
`~/.claude/rules/prrd-design-rules.md` for the full spec.

## 🥇 GOLDEN — set by the USER (immutable to MANAGER)

- **G1.1** — The published npm package declares no install-time lifecycle script (preinstall, install, postinstall, prepare) and none is ever added, because such scripts are vehicles for malicious code. Whatever AgentlensPro installs into Claude Code (hook registrations, the status line, skills, agents, mods) is brought up to date by the CLI itself at its first execution after an update, never by a package script. A build check must fail when package.json declares one of these scripts. Owner order 2026-11-18, recorded on TRDD-5FKVMOE3.

## 🥈 SILVER — MANAGER-mutable (agents propose via COS)


