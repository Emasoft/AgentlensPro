---
trdd-id: T0CT9U4X
title: The hook strip path can clobber another tool's hooks in the user's settings.json
column: complete
created: 2026-07-23T17:06:56+0200
updated: 2026-08-14T02:30:00+0200
current-owner: session
implementation-commits: [4da41dc]
task-type: bugfix
approval-tier: 0
severity: high
impacts: [cli, user-config]
release-via: publish
test-requirements: [unit]
parent-trdd: K7PQ2M4V
---

# The hook strip path can clobber another tool's hooks in the user's settings.json

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-05

**FIXED and committed (`4da41dc`).** Every path now sends a PREDICATE the transaction evaluates on
the fresh array inside its lock — `append_unique` to add, `remove_by_substring` (+ `prune_empty`) to
strip. No whole-array `set` and no `delete` survive on the strip path.

Three things worth knowing that the plan below did not anticipate:

1. **`remove_by_substring` already existed** in `scripts/safe_config_edit.py`, fully implemented and
   verified (apply + a verify-diff assertion), and was simply unused from TypeScript. The Python
   change needed was therefore tiny: a `prune_empty` flag, because `{op:'delete'}` for the
   now-empty case is the SAME defect wearing a different op — "this array is empty" is a conclusion
   drawn from the pre-lock read.
2. **The needles must be DATA** (the op list crosses into Python), and `isOurHookCommand` is a
   REGEX — so `agentlenspro<TAB>hook` is ours while containing no generation literal, and its own
   text cannot be a needle either (the engine matches `json.dumps(element)`, where a tab is
   escaped). `buildEventOps` falls back to the whole-array replace for THAT event alone rather than
   emitting a filter that strips nothing while reporting a removal.
3. **The property belongs to the OP LIST, not to a file**, so the tests apply the ops to a tree
   carrying a foreign entry those ops never saw — the interleave made deterministic instead of
   raced. Verified to discriminate: the same fixture under the old `set` leaves 0 of 1 foreign hooks.

**NEXT ACTION:** human review. Not yet released (`release-via: publish`).

**Superseded — do NOT carry forward:** the body's claim that a strip "can only be expressed as a
whole-array replace", and the NEXT ACTION proposing a new op — the op was already there.

**The defect.** `installHooks` (`src/cli/hookInstall.ts`) reads `settings.json`, computes a rebuilt
matcher array, then commits inside `safeConfigEdit`'s lock. On the PURE-ADD path it uses
`append_unique`, which is evaluated against the FRESH array inside the lock — correct. On the STRIP
path (migrating a previous-generation entry, or removing dead spyglass hooks) it pushes
`{ op: 'set', path: ['hooks', ev], value: r.rebuilt }` — a whole-array replace computed from the
STALE pre-lock read. A hook another tool appends to the same event between the read and the commit
is silently deleted.

**The code already knows.** The comment above the pure-add branch explains this exact TOCTOU and
why `append_unique` solves it; the strip branch is annotated "can only be expressed as a
whole-array replace — the rare, deliberate path". So it is an accepted tradeoff, not an oversight —
but the consequence is deleting a third party's hook from a user's config, and this project has
already destroyed one user's `settings.json` (57.8 KB, 2026-07-07), which is why the verified
transaction exists at all.

**NEXT ACTION** — add a filter-based removal op so a strip is computed inside the lock:

```bash
grep -n "append_unique" scripts/safe_config_edit.py | head
```

**Shape of the fix.** A `remove_by_filter` op (name TBD) that takes a predicate — for this caller,
"drop hook entries whose `command` matches substring X" — and applies it to the array as it exists
INSIDE the lock, exactly as `append_unique` does. `installHooks` then expresses a migration as
`remove_by_filter` + `append_unique` instead of `set`, and the whole-array `set` disappears from
this path. Requires: the predicate must be expressible as data (the op list crosses a process
boundary into Python), so a substring/JSON-path match, never a callback.

**Do NOT** "fix" this by re-reading `settings.json` just before calling `safeConfigEdit` — that
narrows the window without closing it and would read as fixed. The only correct place to evaluate
the predicate is inside the lock.

**Verification.** A test that holds the transaction open (or simulates the interleave) and proves a
foreign matcher appended mid-flight survives a strip. The existing suite covers the pure-add path's
TOCTOU already — mirror it.

## Related

- Parent: TRDD-K7PQ2M4V (the CLI revision that surfaced this).
- `src/safeConfigEdit.ts` → `scripts/safe_config_edit.py` — the transaction to extend.
- `[[agentlenspro-ops-lessons]]` — the config-wipe incident that motivated the transaction.

## Approval log

- 2026-08-14T02:30:00+0200 — COMPLETED (human_review → complete). Reviewed under the owner's
  standing delegation ("review them yourself... based on verified facts"): every load-bearing claim
  verified first-hand against current code with file:line evidence — see
  reports/trdd-review/20260814_015415+0200-batch2-review.md (this card's section). No contradiction
  found; open residuals, where any, are recorded in that report and are non-blocking.
