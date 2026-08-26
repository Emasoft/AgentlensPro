---
trdd-id: 6SPXOV0P
title: Bodies strand permanently when the spool volume fills and nothing drains them once it recovers
column: backburner
created: 2026-08-26T20:13:05+0200
updated: 2026-08-26T20:13:05+0200
current-owner: main
task-type: bugfix
severity: MEDIUM
priority: 3
labels: [bodies, ingest, silent-failure, capacity]
relevant-rules: []
---

## Symptom

After the TRDD-8TM7I49X repair swapped in a clean store on 2026-08-26, the pass state carried
**307 stranded names** within ~2 minutes of the server restarting. Measured over 90 s they were
FLAT (307 / 307 / 307), so this is residue from a past window, not an active leak:

```
20:08:39 stranded=307 skip=2337
20:09:24 stranded=307 skip=4532
20:10:09 stranded=307 skip=4532
```

The window is identified: the spool volume `/Volumes/AgentLensSpool` (2.0 GB) hit ENOSPC — the
server logged `bodies sink precondition FAILED at boot … ENOSPC`. It has since drained to 20%
used on its own.

## The defect this points at

Stranding on a full sink is arguably correct — better than losing bytes. What is NOT correct is
that it appears to be **terminal**: the volume recovered, and the 307 did not drain. That is the
same shape TRDD-8TM7I49X just spent four days on, at 1/3 the scale — a set that only ever grows,
whose only exit was an operator running a repair verb by hand.

Two questions this card must answer before proposing a fix, in order:

1. **Do stranded-on-ENOSPC names have a drain path at all?** If `relocate_stranded_to` is `None`
   for this case too (`pass.rs:420-436` is the equivalent site from the sibling card), then the
   answer is no and it is the same bug in a second dress.
2. **Is there backpressure?** A sink that cannot accept writes should slow or stop the producer,
   not accumulate names in a set. If ingest keeps accepting while the sink is dead, the stranded
   set is a queue with no consumer.

## Why the volume's size is not the fix

It is tempting to call this a capacity problem and enlarge the volume. That would move the
threshold, not remove the failure: any finite sink fills eventually, and the defect is what
happens *after* it does. Sizing is the USER's call and no agent should be reclaiming space to
paper over it (`~/.claude/rules/never_free_space.md`).

## Acceptance

- [ ] Determined and recorded IN THE CODE whether stranded-on-sink-failure names can drain, with
      a `file:line` for the decision point.
- [ ] Once the sink recovers, previously stranded names drain without an operator running a repair
      verb — or the reason they cannot is recorded at that `file:line`.
- [ ] The 307 currently stranded either drain or are explained.
- [ ] A test that fills (or fakes a full) sink, recovers it, and asserts the set returns to 0.

## Related

- [[TRDD-8TM7I49X]] — the 1045-name instance of "a stranded set with no exit", now drained.
- [[TRDD-Z8WJZV8E]] — why the operator surface kept reporting the sink as dead after it recovered.
