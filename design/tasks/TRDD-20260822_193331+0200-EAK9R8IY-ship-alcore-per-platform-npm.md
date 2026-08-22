---
trdd-id: EAK9R8IY
title: Ship the Rust binaries per-platform on npm — the missing prerequisite for box 3
column: todo
created: 2026-08-22T19:33:31+0200
updated: 2026-08-23T00:05:00+0200
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
| **the OTHER binaries** | `alstore` **40 MB**, `allogscan` 2.7 MB, `alsummarize` 2.4 MB, `alscan` 823 KB | `ls -lh target/release/*` |
| **payload for ALL FOUR the TS resolves** | **~96 MB per platform** | `alcore`+`alstore`+`allogscan`+`alscan` |
| **already deployed by hand today** | **44 MB** — `alstore`, `allogscan`, `alscan` | `ls -lh ~/.agentlens/bin/` |
| **why the TS server still serves** | **`alcore` is the ONE not installed** | same listing — `alcoreBin()` returns null |
| what a user ALREADY downloads | **108 MB** for one platform | `du -shL` on the installed `@duckdb/node-bindings-darwin-arm64` |
| the per-platform pattern | **already in this dependency tree** | `@duckdb/node-bindings` declares **8** per-platform `optionalDependencies` |
| CI that builds the Rust binaries | **none** | no workflow references `rust-core`, `cargo build`, or `alcore` |
| what `package.json` ships today | no binaries, no `optionalDependencies`, no `postinstall` | read from the manifest |

**CORRECTION to this card's first draft, which said "53 MB".** That measured only `alcore`. The
TS side resolves FOUR binaries (`alcore`, `alstore`, `alscan`, `allogscan`), and `alstore` is
another **40 MB** — so the real per-platform payload is **~96 MB**, not 53. The comparison still
holds (96 MB against the 108 MB of DuckDB bindings already shipped) but it is now a near-tie
rather than "half", and the card said "half" on a number that had not been fully measured.

**Two facts that make this much less speculative than it looked:**
1. **44 MB of these binaries are ALREADY deployed** on this machine and in production use —
   `alstore` (40 MB, DuckDB-linked) has been running since 2026-08-19. Shipping a large
   DuckDB-linked binary is not a new risk being taken; it is an existing practice being moved
   from a manual copy into the release pipeline.
2. **`alcore` is the only missing one**, and its absence is the entire mechanical reason box 3
   cannot close.

**An optimisation deliberately NOT taken now:** `alcore` and `alstore` each bundle their own copy
of DuckDB (~40 MB of the same C++ twice). Merging them into one multi-call binary would cut the
payload roughly 40%. That is a refactor of two crates' binary boundaries, it is not required to
close box 3, and doing it inside this card would couple a shipping change to an architectural
one. File it separately if the payload proves to matter.

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

## Where this stopped, and the one measurement still missing

Returned `dev` → `todo` on 2026-08-22T19:50 when the USER redirected to the review-hook install.
Queued, not dropped. Nothing is half-applied — no workflow was written.

**What was established:** the existing `publish.yml` is the ONLY place per-platform packages may
publish from, because **npm authorizes the workflow FILENAME** and the trusted-publisher entry
names `publish.yml`; a new workflow file would 404 on the OIDC exchange. So this is extra JOBS in
that file (a build matrix + per-platform publish jobs), not a new workflow.

**MEASURED — a bundled DuckDB build is 287 s (4 m 46 s) on 14 cores.** So the matrix is
affordable: GitHub runners carry fewer cores, so budget ~10–20 min per platform, and the five run
in PARALLEL, making wall-clock roughly one platform's time rather than five.

**How the first attempt got this wrong, recorded because the failure is reusable.** `cargo clean
-p libduckdb-sys` reported removing 33.4 GiB / 35,156 files, after which the rebuild finished in
**12.6 s compiling only `agentlens-store`** — and 12 s was briefly taken as the answer. It was
not: `find target/release/build -name 'libduckdb-sys-*'` showed **4 build directories still
present** afterwards. The clean had removed a great deal, but not the artifacts that mattered, so
cargo had nothing to rebuild. The valid number came from deleting exactly those four directories
and timing the rebuild. **A clean's own byte count is not evidence that the specific thing you
wanted rebuilt was removed — check for the artifact, not the tonnage.**

## 2026-08-22 — the hardest risk is GONE: no cross-compilation is required

The approach section says "there is no cross-compile release pipeline" and calls that the real
blocker. **Checked, and the premise is out of date — every one of the five targets has a NATIVE
GitHub-hosted runner**, so this is a plain matrix build, not a cross-compile problem:

| target | native runner | availability |
|---|---|---|
| `darwin-arm64` | `macos-14` / `macos-latest` | GA (Apple Silicon) |
| `darwin-x64` | **`macos-15-intel`** (or `macos-26-intel`) | GA — **NOT `macos-13`, see below** |
| `linux-x64` | `ubuntu-latest` | GA |
| `linux-arm64` | **`ubuntu-24.04-arm`** | **GA for public repos since 2025-08-07**; extended to private repos 2026-01-29 |
| `win32-x64` | `windows-latest` | GA |

`Emasoft/AgentlensPro` is **PUBLIC** (`gh repo view --json visibility`), which is the condition
for the free-tier arm64 runners — so the arm64 Linux leg costs nothing extra.

This matters more than it looks. Cross-compiling a **statically-linked DuckDB** (17,246 symbols,
the reason `alcore` is 53 MB) to linux-arm64 and win32-x64 from a macOS or x64 host is exactly
the kind of toolchain work that eats days and fails late. Building each target on its own native
runner replaces all of it with `cargo build --release` per leg. Combined with the already-measured
**287 s bundled DuckDB build on 14 cores**, and the five legs running in parallel, the matrix is
ordinary CI work.

**CORRECTED within the hour — the first version of this table said `darwin-x64 → macos-13`, and
that image was RETIRED 2025-12-04** (deprecation began 2025-09-22), eight months before this card
was written. Verified against the live GitHub-hosted-runners reference, which no longer lists
`macos-13` at all; Intel macOS is now **`macos-15-intel`** / `macos-26-intel` (4 CPU, 14 GB). The
other four labels check out.

This one would have been expensive precisely because of the property this card already records:
**publishing is tag-driven**, so a job pinned to a removed runner label does not fail in review —
it fails **at release time**, on the tag, with the package half-published. Caught by adversarial
review of the commit that introduced it, not by anything in the pipeline; the lesson is that
"which runner labels exist" is live external state and ages like a dependency version, so it is
re-checked when the workflow is written, never trusted from a card.

Sources: [arm64 hosted runners for public repositories are now generally
available](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/) ·
[arm64 standard runners are now available in private
repositories](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/) ·
[GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) ·
[macOS 13 runner image is closing
down](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/)

**Still not started, deliberately.** `publish.yml` today is two jobs, both `ubuntu-latest`
(`package` :22, `publish-npm` :142), and it is the single most consequential file in the repo: npm
authorizes it BY FILENAME, so a mistake there is discovered at release time, not at edit time. It
is additive work — a build matrix plus per-platform publish jobs in that same file — and it should
be done in one sitting with a dry run, not left half-applied. What this entry removes is the
uncertainty about whether it is feasible at all.

## Approval log

- 2026-08-22T19:35:10+0200 — Filed as a **proposal** (tier 2), awaiting USER approval. Self-
  corrected: it was first written into `design/tasks/` at `column: backburner` while declaring
  `approval-tier: 2`. That combination is incoherent — the approval-tiers rule authorises direct
  authoring in `design/tasks/` only for Tier 0, and this card's content hits an objective Tier-2
  floor twice over (`.github/workflows`, and publishing to npm). `backburner` does not soften
  that: the tier decides the FOLDER, not the urgency. Moved rather than left for the
  classification watchdog to catch, because a card that misreports its own authority is the exact
  thing that watchdog exists to find.
- 2026-08-22T19:39:15+0200 — **APPROVED** by main, self-orchestrating (tier 2). The USER stated
  this project runs outside the ai-maestro harness, so there is no MANAGER above this session and
  the tier-2 approver is this session itself; they then directed that these cards be moved to the
  right columns and completed. Rationale: the measured facts remove the only substantive
  objection — 53 MB stripped against the 108 MB of native DuckDB the package already ships per
  user, via a per-platform `optionalDependencies` pattern already present in the dependency tree.
  What remains is conventional cross-compile CI. → `planned`, moved to `design/tasks/`.

## Provenance

Facts gathered 2026-08-22 after the USER's standing directive to decide on verified facts rather
than ask. The investigation was prompted by box 3 having sat un-actioned as "a USER decision"
while nobody had established what closing it would cost — the decision was blocked on missing
facts, not on the USER.
