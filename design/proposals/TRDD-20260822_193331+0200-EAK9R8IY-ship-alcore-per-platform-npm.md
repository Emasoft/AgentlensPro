---
trdd-id: EAK9R8IY
title: Ship the Rust binaries per-platform on npm — the missing prerequisite for box 3
column: proposal
created: 2026-08-22T19:33:31+0200
updated: 2026-08-22T19:35:10+0200
current-owner: main
task-type: infra
scope: project
parent-trdd: DMWOBWFH
npt: []
eht: []
approval-tier: 2
---

# Ship the Rust binaries per-platform on npm — the missing prerequisite for box 3

**NPT of TRDD-DMWOBWFH acceptance box 3** ("TypeScript remaining in the repo serves only the
UI"). Box 3 cannot close while `standalone/server.ts` serves every published install, and it
serves them because `alcore` is not shipped. This card is that gap, and nothing more.

## The facts that make this decidable — measured 2026-08-22, not estimated

| fact | value | how |
|---|---|---|
| `alcore` size | **53 MB, stripped** | `strip -S` changed nothing |
| why it is 53 MB | **17,246 statically-linked DuckDB symbols** | `nm -gU \| grep -ci duckdb` |
| what a user ALREADY downloads | **108 MB** for one platform | `du -shL` on the installed `@duckdb/node-bindings-darwin-arm64` |
| the per-platform pattern | **already in this dependency tree** | `@duckdb/node-bindings` declares **8** per-platform `optionalDependencies` |
| CI that builds the Rust binaries | **none** | no workflow references `rust-core`, `cargo build`, or `alcore` |
| what `package.json` ships today | no binaries, no `optionalDependencies`, no `postinstall` | read from the manifest |

**The size objection is dead.** The project already pulls a 108 MB native DuckDB payload per
user; `alcore` at 53 MB is HALF that, and would replace work that native binding is doing rather
than adding a new category of cost. Shipping it is not a new burden on the install — it is the
same burden the package already imposes, using the same mechanism.

**So the real blocker is narrow and conventional:** there is no cross-compile release pipeline.
That is bounded infra work, not a scope question.

## Approach

Copy the pattern already in the tree (`@duckdb/node-bindings`, and the same one esbuild and swc
use): one `agentlenspro-<platform>` package per target carrying the binary, declared as
`optionalDependencies` of the main package so npm installs exactly one. **Preferred over a
`postinstall` download**, which trades a large tarball for a new install-time network failure
mode and a script that runs on every user's machine — and this repo's release doctrine is
tokenless, CI-only, and provenance-attested, which a runtime download undercuts.

Targets, matching what the DuckDB binding already covers: `darwin-arm64`, `darwin-x64`,
`linux-x64`, `linux-arm64`, `win32-x64` (+ musl variants only if the binding's presence proves
they are needed).

## Load-bearing constraints, from this repo's own doctrine

- **Publishing is tag-driven, tokenless OIDC, CI-only** (`CLAUDE.md`). Per-platform packages must
  publish through the same trusted-publisher path. **npm authorizes the workflow FILENAME** — a
  new workflow needs its own trusted-publisher registration, or the token exchange 404s.
- **`package.json` `files` is the ONE allowlist**; never add a `.npmignore` (it silently
  overrides `.gitignore` and once shipped private reports).
- **Build outputs must exist before `npm pack`** or they are silently skipped — a binary missing
  from a platform package would publish as an empty shell that installs and then fails at spawn.
- `alcore` is already reachable when present (`b8addc7`: `ensureServer` spawns
  `~/.agentlens/bin/alcore`), so the consumer side needs a resolver for the npm-installed path in
  addition to the data-dir path — not a new mechanism.

## What this card does NOT decide

Whether the TS server is then **deleted** or kept as a fallback. That is box 3's actual scope
question and belongs to the USER. This card only removes the reason the question cannot be
answered today. If the answer is "keep the TS server as a fallback", box 3's wording needs
amending instead, and this card should be cancelled rather than completed.

## Acceptance

- [ ] A CI matrix builds `alcore` (and `alscan`/`allogscan` if the cutover needs them) for the
      agreed targets, on tag, through the existing tokenless OIDC path.
- [ ] Per-platform packages publish with the binary present — verified by installing the
      published package in a clean environment and spawning the binary, NOT by inspecting the
      tarball listing.
- [ ] The main package declares them as `optionalDependencies` and resolves the npm-installed
      binary in addition to `~/.agentlens/bin/alcore`.
- [ ] A machine with no `~/.agentlens/bin/alcore` runs the Rust server after a plain
      `npm i -g agentlenspro` — measured on a clean environment, not asserted from the manifest.

## Approval log

- 2026-08-22T19:35:10+0200 — Filed as a **proposal** (tier 2), awaiting USER approval. Self-
  corrected: it was first written into `design/tasks/` at `column: backburner` while declaring
  `approval-tier: 2`. That combination is incoherent — the approval-tiers rule authorises direct
  authoring in `design/tasks/` only for Tier 0, and this card's content hits an objective Tier-2
  floor twice over (`.github/workflows`, and publishing to npm). `backburner` does not soften
  that: the tier decides the FOLDER, not the urgency. Moved rather than left for the
  classification watchdog to catch, because a card that misreports its own authority is the exact
  thing that watchdog exists to find.

## Provenance

Facts gathered 2026-08-22 after the USER's standing directive to decide on verified facts rather
than ask. The investigation was prompted by box 3 having sat un-actioned as "a USER decision"
while nobody had established what closing it would cost — the decision was blocked on missing
facts, not on the USER.
