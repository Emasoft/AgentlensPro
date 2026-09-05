---
trdd-id: 0Y8BMVK2
title: The dashboard reported skill and agent catalogs as per-turn cache writes and a six-digit hit rate
column: ai_review
created: 2026-09-03T19:13:48+0200
updated: 2026-09-05T18:36:15+0200
current-owner: main-session
task-type: bugfix
severity: HIGH
labels: [dashboard, cache, metrics, attribution, false-positive]
relevant-files: [media/src/tabs/Agents.tsx, media/src/tabs/Traces.tsx, src/shared/tokenBuckets.ts, src/test/cacheHitRate.test.ts]
release-via: publish
implementation-commits: [574eeba5]
related: [V8W9A8FZ, DIZ289UQ]
---

# The dashboard reported catalogs as per-turn cache writes and a six-digit hit rate

## ⏵ STATE — 2026-09-05T18:27:28+0200 — `testing → ai_review`

The 19:13 NEXT ACTION below was done one minute after it was written: `574eeba5` (2026-09-03
19:14:39) commits the four files named in `relevant-files:` plus this card (5 files, +182/−12),
verified by `git show --stat`. The card then sat in `testing` for two days with a stale NEXT ACTION
and no `implementation-commits:`; both fixed here. This card has no acceptance boxes: TRDD-KBK9J59Y
(read in full, its Acceptance section) concluded "no card needs criteria written" for the seven it
audited and records this one as "reports itself finished on its own STATE block, unconfirmed".
**Gates re-run on HEAD `689e4176` at 18:27:28** (the 18:23 move had relied on the 09-03 run, ~200
commits old — a review fork caught it): `pnpm run compile-tests` 0, `cacheHitRate.test.js` 5/0,
`scripts/check-no-mirrors.js` 0 ("141 shared exports, no mirrors under media/src"), `pnpm run
check-types` 0 (`reports_dev/0y8b-*.txt`); `node esbuild.js` 0 at 18:29:53. The guard itself, read
at HEAD: `Traces.tsx:967` `!sourcesInherited && itemizedSum > 0 && totals.cacheWrite >= itemizedSum`
(turn level) and `:334` `blocksAreNewWrites` (breakdown level); the inherited-case label at `:996`.
A `grep -c` of that label in a bundle counts one string on the inherited branch and says nothing
about the guard — it is not evidence and is not cited as such. **What those gates do and do not
prove:** the 5 mocha tests exercise only the shared helper `cacheHitRate` (defect 1). Defects 2–4
live in `Agents.tsx` and `Traces.tsx`, webview code with NO automated test in this repo; on HEAD
they are covered only by the `media/tsconfig.json` type-check leg (its `include` is `src/**/*.tsx`,
so `tabs/` is in scope) and the esbuild build — shape, not behaviour — and behaviourally only by the
09-03 manual inspection of the served bundle. The AI review must read "gates green" with that gap in
view. The served `dashboard.js` (`curl localhost:3000/dashboard.js` at 18:33) is byte-identical to
the 18:29 rebuild on disk (`cmp` → identical, 762,950 bytes both); on its own that only proves the
build is deterministic over unchanged source, since a boot-time snapshot taken before 18:29 would
read the same if nothing had changed. **Confirmed by observation instead, 18:36:** `static_asset()`
(`rust-core/crates/agentlens-core/src/ui.rs:1049,1056`) does `std::fs::canonicalize` +
`std::fs::read(&file)` on `media_dir.join(path)` inline in the request handler — no boot-time cache,
no `include_bytes!`. A marker line appended to `media/dashboard.js` on disk (no restart, no rebuild)
was returned by the very next `curl localhost:3000/dashboard.js` (`grep -c` on the response = 1);
`node esbuild.js` then rebuilt the artefact and the marker was gone (post-restore count 0). So the
per-request-from-disk claim is CONFIRMED by direct observation, not inferred from byte-identity, and
the live dashboard is the HEAD build the instant `node esbuild.js` finishes — no `server restart`
needed for the TS/webview bundle (only the Rust binary itself needs a restart to pick up a rebuild).
The rebuild also rewrote `standalone/cli.js`
(the hook entrypoint): `git diff --stat 52155adf HEAD -- src standalone/*.ts media/src` is empty, so
nothing the hooks execute changed. Of the two fold-out items: "PostToolUse:Agent
advisory size" had no card until TRDD-V8W9A8FZ (backburner, `fb20872b` — the remark carries no spec
beyond its name); "burn-gate wording" is most likely what TRDD-DIZ289UQ (2026-09-05, the thrash
gate blaming forks) addressed — INFERRED from the titles, not from a record linking them.

## Approval log

- 2026-09-05T18:27:28+0200 — ORCHESTRATOR decision: `testing → ai_review` on the gates re-run
  above. KBK9J59Y reads this transition as OFF the mechanical exempt row for a card with no
  `test-requirements:` frontmatter (`manager-approval-defaults.md` table A) and itself moved nothing;
  in this standalone project the USER is the approver, so the move is recorded here as vetoable:
  the USER may return the card to `testing`.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-03 19:13

**Implemented, gated, deployed.** Three reporting defects fixed; the underlying cache behaviour was
never broken. Gates: `check-types` 0, `check-mirrors` OK (122 shared exports), `compile-tests` 0,
5/5 new unit tests passing, `node esbuild.js` 0, server restarted and the served bundle verified to
carry the change. NEXT ACTION: commit the four files by name, then fold the remaining two items
(burn-gate wording, PostToolUse:Agent advisory size) into their own cards.

## The report

The owner observed the dashboard trace showing, under one turn, `Cache-created (newly written to
cache) 19.4K` with children `Hook injections 70.9K`, `Agent catalog 21.3K`, `Skill catalog 10.5K`
— 102.7K of children under a 19.4K parent — and concluded skills and agents were being re-injected
and re-billed on every turn. A separate observation: cache hit rates rendered as six-digit
percentages such as 200000%.

## What was actually true (measured first-hand, 2026-09-03)

Cache behaviour is healthy and the catalogs are NOT re-sent per turn:

- Response usage over 3h from the captured bodies: opus-5 216 calls, cache_read 70.31M vs
  cache_write 1.18M (98.4% hit); sonnet-5 122 calls, 94.4%.
- Structural check over the DuckDB/parquet body store, grouping requests by TRUE stream identity
  (`session_id` + sha of `messages[0]`): the four busiest Fable conversations show 39/39 consecutive
  pairs APPEND-ONLY, zero prefix breaks. System blocks, all 33 tool schemas and every earlier
  message are byte-identical between turns; only appended messages differ.
- Catalog injections in this session appear on 8 turns out of 86 (turns 2, 4, 10, 78, 349, 862,
  907, 908) — session start, compact and resume boundaries.

## The three defects

1. **`media/src/tabs/Agents.tsx:32` — hit rate compared unrelated quantities.**
   `cacheHitRate: totalCache / totalInput` divided cache traffic by FRESH input. Under the
   disjoint-buckets convention `inputTokens` is only the uncached share, so the ratio is unbounded
   above. Live totals across 20,475 cards: fresh 211,420,856 vs cache 348,130,168,141 → **164662%**
   where the true rate is **98.0%**.
2. **`media/src/tabs/Agents.tsx:28` — "Fresh Input" always rendered 0.** `totalFresh = max(0,
   totalInput - totalCache)` subtracted cache from a bucket that never contained it, so the display
   floored at 0 on every agent group. Fresh IS `totalInput`.
3. **`media/src/tabs/Traces.tsx:955` — injected blocks nested under Cache-created unconditionally.**
   The composition blocks were attached as CHILDREN of the cache-created node whose weight is the
   real `cacheWrite`, two unrelated quantities in a parent/child relation. `LlmContextBreakdown`
   (same file, line 326) already had the correct guard — drill the blocks there only when the write
   is large enough to contain them — and the turn-level builder never received it.
4. **`media/src/tabs/Traces.tsx:1466` — the inherited union was presented as each turn's own.**
   For a fork or sub-agent with no transcript of its own, `resolveHostSources` falls back to the
   UNION of every turn's blocks. That union contains the catalogs and was rendered under EVERY turn,
   which is what made the catalogs look re-injected turn after turn.

## The fix

- `src/shared/tokenBuckets.ts`: new `cacheHitRate(read, write)` — the ONE derivation, denominator
  `read + write` and nothing else, so the value is structurally a fraction. Both runtimes import it
  (the project's single-source rule; `check-mirrors` enforces no duplicate).
- `Agents.tsx`: uses the shared helper; `totalFresh` is `totalInput`.
- `Traces.tsx`: cache-created drills the blocks only when `cacheWrite >= itemizedSum` and the
  sources are not inherited; the inherited case is labelled "Inherited context blocks (from the
  parent transcript — not injected this turn)".
- `src/test/cacheHitRate.test.ts`: 5 tests pinning the shape, including the exact live totals that
  produced 164662%.

## Notes and lessons learned

- **A ratio whose two terms sit on different axes is a bug waiting for scale.** Both percentage
  defects came from dividing cache tokens by fresh input. The guard is structural, not numeric:
  keep both terms on the same axis and a value over 100% becomes impossible rather than unlikely.
- **Attribution keyed on `session_id` alone is wrong on this machine.** One session id carries
  interleaved parent and sub-agent streams. Diffing consecutive requests under that key produced a
  confident false verdict ("the model flipped and the whole 840KB prefix was lost") that dissolved
  once the stream key included the first-message sha. Any future attribution work must key on the
  conversation, not the session.
- **A parent/child bar chart asserts that children compose the parent.** Hanging identity-of-content
  rows under a billing-partition row makes the UI state something false even when every number in
  it is individually correct.
