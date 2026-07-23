---
trdd-id: T0CT9U4X
title: The hook strip path can clobber another tool's hooks in the user's settings.json
column: todo
created: 2026-07-23T17:06:56+0200
updated: 2026-07-23T17:06:56+0200
current-owner: session-7877ae1f
task-type: bugfix
approval-tier: 0
severity: high
impacts: [cli, user-config]
release-via: publish
test-requirements: [unit]
parent-trdd: K7PQ2M4V
---

# The hook strip path can clobber another tool's hooks in the user's settings.json

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-23

**State:** confirmed against the source, NOT fixed. Deliberately split out of TRDD-K7PQ2M4V because
the fix touches `scripts/safe_config_edit.py` — the verified transaction that guards every user
config file — and that is the highest-risk file in the repo to change casually.

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
