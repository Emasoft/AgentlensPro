---
trdd-id: EAK9R8IY
title: Ship the Rust binaries per-platform on npm — the missing prerequisite for box 3
column: testing
created: 2026-08-22T19:33:31+0200
updated: 2026-08-26T05:35:00+0200
current-owner: main
task-type: infra
scope: project
parent-trdd: DMWOBWFH
npt: []
eht: []
min-approval-requirement: manager
---

# Ship the Rust binaries per-platform on npm — the missing prerequisite for box 3

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-26

**Built this session, all inert (no tag pushed, no publish run):**
- `src/rustBinResolve.ts` — the third fallback channel (`npmPlatformBin`), wired into the four
  existing resolvers (`alcoreBin`, `alstoreBin`, `alscanBin`, `allogscanBin`); order is
  env override → `<dataDir>/bin/<name>` (dev install) → npm platform package.
- `scripts/gen-platform-packages.js` — generates `npm-platform-packages/agentlenspro-<suffix>/`
  (package.json + `bin/*` + LICENSE + README) from that runner's own `cargo build --release`
  output. Directory is gitignored — pure CI-time build output, never hand-authored.
- `scripts/check-platform-package-pins.js` — fails the build if the main package's
  `optionalDependencies` versions on `agentlenspro-<platform>` drift from `package.json` `version`.
  Wired into `check-types`/`package`.
- `package.json` — added `optionalDependencies` (4 platform packages, pinned `2.29.0`).
- `.github/workflows/publish.yml` — new `build-platform-packages` matrix job (4 native runners,
  no cross-compile), `publish-npm` now `needs: [package, build-platform-packages]` so the main
  package publishes only after every platform leg succeeds.
- `src/test/rustBinResolve.test.ts` — 4 tests, all passing.

**NEXT ACTION (owner, not this session):** before the first tag meant to actually ship binaries,
bootstrap each `agentlenspro-<platform>` package once, locally, with 2FA — the exact 3 steps are
written as a comment block right above the `build-platform-packages` job in `publish.yml`. Until
that happens, the job's publish step 404s (expected — same as the `agentlenspro` 1.0.0 bootstrap).

**Not done, and cannot be done from this session:** acceptance boxes 2 and 4 require an actual
publish (forbidden here) followed by installing on a clean machine. Everything else is verified
(see Acceptance below).

**Superseded — do NOT carry forward:** the card's own `approval-tier: 2` field name (retired;
now `min-approval-requirement: manager`).

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

- [x] A CI matrix builds `alcore` (and `alstore`/`alscan`/`allogscan`, all four the resolver
      needs) for the agreed targets, on tag, through the existing tokenless OIDC path. Added
      job `build-platform-packages` in `.github/workflows/publish.yml` (matrix: `darwin-arm64`
      → `macos-14`, `darwin-x64` → `macos-15-intel`, `linux-x64` → `ubuntu-latest`,
      `linux-arm64` → `ubuntu-24.04-arm`, all native — no cross-compile). `win32-x64` deliberately
      OMITTED: `rust-core/crates/agentlens-core/src/pid_lock.rs:105-106` calls
      `libc::kill`/`libc::EPERM` with no `#[cfg(unix)]` guard, so the crate does not build for
      windows-msvc as written. No musl legs added (not needed — matches the card's instruction).
- [ ] Per-platform packages publish with the binary present — verified by installing the
      published package in a clean environment and spawning the binary, NOT by inspecting the
      tarball listing. **Cannot be checked from this session** (no publish was performed — see
      the workflow job's own comment block for the required one-time OIDC bootstrap per
      platform package, same shape as the v1.0.0 bootstrap this repo already did). Verify after
      the first real tag.
- [x] The main package declares them as `optionalDependencies` (pinned to the exact `version`,
      checked in CI by `scripts/check-platform-package-pins.js`, wired into `check-types`/
      `package`) and resolves the npm-installed binary in addition to `~/.agentlens/bin/alcore`:
      `src/rustBinResolve.ts` (`npmPlatformBin`) is the new third channel, wired into
      `alcoreBin()` (`src/cli/serverControl.ts`), `alstoreBin()` (`src/rustStorePass.ts`),
      `alscanBin()` (`src/rustScan.ts`), `allogscanBin()` (`src/rustLogScan.ts`) — env override
      wins, then the dev-install `<dataDir>/bin/<name>`, then the npm platform package. Test:
      `src/test/rustBinResolve.test.ts` (4/4 passing), plus the existing `rustScan.test.ts` /
      `rustStorePass.test.ts` two-channel tests still pass unchanged (8/8) — the third channel
      only widens the fallback, never changes the first two.
- [ ] A machine with no `~/.agentlens/bin/alcore` runs the Rust server after a plain
      `npm i -g agentlenspro` — measured on a clean environment, not asserted from the manifest.
      **Cannot be checked until the platform packages are actually published** (same blocker as
      the box above).

**Verified this session**: `pnpm run check-types` (0 errors), `pnpm run lint` (0 errors, only
pre-existing warnings), `pnpm run check-mirrors` (OK), `pnpm run check-platform-package-pins`
(OK — 4/4 match version 2.29.0), `pnpm run package` (full production build green), and the full
existing unit suite (2469 passing, 15 pending, 0 failing) plus the 4 new resolver tests. The
workflow YAML parses and `zizmor` reports no new findings (1 pre-existing informational, none
introduced by the new job).

**Research finding that shapes the remaining work (WebSearch, 2026-08-26):** npm's trusted-
publishing OIDC exchange cannot publish the FIRST version of a brand-new package name — the
registry has to already know the name exists before a trusted-publisher entry can be attached to
it. So each `agentlenspro-<platform>` package needs the same one-time, owner-2FA local bootstrap
publish this repo already did for `agentlenspro` 1.0.0, followed by `npm trust github` to
register the trusted publisher — documented as an explicit numbered step in the new workflow
job's own comment block (`.github/workflows/publish.yml`, job `build-platform-packages`) rather
than only here, so whoever edits that file next sees it in place. Until that bootstrap runs, the
job's publish step will 404 exactly like the main package did before its own bootstrap — expected,
not a defect.

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
- 2026-08-26T05:35:00+0200 — Implemented the resolver + CI scaffolding (see the STATE block).
  `column: todo` → `testing`: check-types/lint/check-mirrors/check-platform-package-pins/package
  all green, and the new + existing resolver tests pass (2469 passing, 0 failing). Migrated
  `approval-tier: 2` → `min-approval-requirement: manager` per the field-rename ruling. No publish
  was performed and none is possible from this session — boxes 2 and 4 stay open pending the
  owner's one-time OIDC bootstrap and a real tag.

## Provenance

Facts gathered 2026-08-22 after the USER's standing directive to decide on verified facts rather
than ask. The investigation was prompted by box 3 having sat un-actioned as "a USER decision"
while nobody had established what closing it would cost — the decision was blocked on missing
facts, not on the USER.
