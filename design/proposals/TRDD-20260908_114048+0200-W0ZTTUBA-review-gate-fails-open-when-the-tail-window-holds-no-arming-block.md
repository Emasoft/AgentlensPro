---
trdd-id: W0ZTTUBA
title: The review gate fails open when its 4MB tail window holds no arming block
column: proposal
created: 2026-09-08T11:40:48+0200
updated: 2026-09-08T11:40:48+0200
current-owner: main-session
task-type: bugfix
scope: project
min-approval-requirement: user
parent-trdd: DRH4ZRGB
---

# The review gate fails open when its 4MB tail window holds no arming block

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08

The mechanism is REAL and read from source. The failure was SOUGHT ON REAL DATA AND NOT
REPRODUCED — two samples, including a 545 MB transcript that genuinely truncates. NEXT ACTION:
decide whether a defence is worth adding for an unreproduced fail-open, or whether to close this
as a documented, accepted risk. Do NOT close it as "not a defect" — the fail-open is in the code.

## The mechanism

`decideMainGate` (`src/cli/reviewGate.ts`):

```ts
if (scan.lastWork === -1) return { block: false, nextState: state } // nothing claimed this window
```

That returns **before** `lastFork` is consulted. `scanMainTranscriptLines` feeds it only entries
that are `type === 'assistant'` and not `isSidechain`, over the window `readTranscriptTail`
returns — the last **4 MB** of the transcript, byte-anchored from EOF, first (torn) record
dropped.

So: if the 4 MB window happens to contain no assistant text block, no `EDITORS` tool_use and no
`git commit`, the gate allows the stop **unconditionally** — a silent bypass of a gate under a
standing owner order that it is never stopped or bypassed (2026-09-03). Silence is the dangerous
direction: nothing announces it.

The converse is benign by comparison. If the window drops the last fork while retaining older
arming prose, `lastFork` falls to `-1` and the gate blocks — recoverable, because the next
fork-last turn lands at the highest index and clears it.

## Sought on real data. NOT reproduced.

**Sample 1 — this session** (1,122,983 bytes, so `span === size` and **no truncation at all**):

```
{'assistant': 59, 'user': 36, 'attachment': 110, 'mode': 22, 'atis-latch': 22,
 'queue-operation': 21, 'last-prompt': 21, 'system': 10, 'file-history-*': 3}
arm blocks: 11   fork spawns: 9   sidechain: 0
```

**Sample 2 — the largest transcript on this machine** (545,835,794 bytes; window 4,194,304,
`truncated: True` — the real truncating case):

```
{'assistant': 263, 'user': 222, 'attachment': 262, 'queue-operation': 120, 'system': 100,
 'last-prompt': 49, 'ai-title': 47, 'agent-name': 47, 'mode': 47, 'permission-mode': 47,
 'file-history-*': 11, 'atis-latch': 1}
arm blocks: 51   fork spawns: 0   sidechain: 0
```

51 arming blocks in the truncated window — three orders of magnitude away from `-1`. Assistant
text blocks are dense enough that the window has never been observed without one.

**Population:** 3,126 transcripts on this machine, **150 of them over 4 MB**, so truncation is
common, not exotic.

## The sidechain hypothesis is dead

A reviewer proposed that fork output floods the window with `isSidechain: true` entries the scan
discards, making `lastWork === -1` ordinary. Measured across **all 3,126** transcripts:
`grep -l '"isSidechain":true'` → **0 files**. Control run because a literal-string grep is a
false-negative risk if the JSON is spaced differently: the bare key `isSidechain` appears in
3,123 files, so the pattern is not blind — and the format-independent Python check
(`e.get('isSidechain') is True`) also found 0 in both samples above.

Subagent turns are written to their own files under the session's `tasks/` directory, not into
the main JSONL.

**Honest limit on that claim:** 0 hits over 3,126 files on ONE machine and ONE CC build, whose
spawns were overwhelmingly `subagent_type: "fork"`. It does not prove no configuration produces
`isSidechain: true` — and the filter's existence in the source is weak evidence something does.
Narrowest form: *fork subagent turns do not appear in the main JSONL here.*

## What is actually unfavourable

The ratio, not the absolute count: 197 of 305 entries (sample 1) and ~700 of ~1,200 (sample 2)
are entry types the scan skips. `attachment` alone is 36% and 22%. Those are exactly the entries
that scale with a session's BYTES while contributing zero arming blocks — so the theoretical
path to `lastWork === -1` is a window saturated by attachments and tool results. Not observed;
not excluded.

## Options

1. **Fail CLOSED on an empty window** — treat `lastWork === -1` with `lastFork === -1` as
   "cannot answer" and block, matching this project's own doctrine (`last-compact` exits 2 with
   empty stdout rather than printing `0`; `cache-state` never prints `cold` for a question it
   could not resolve). Risk: wedges a genuinely fresh session.
2. **Widen the window when it yields no assistant entries** — re-read with a larger `maxBytes`
   before deciding.
3. **Accept and document.** Defensible given two samples and 150 truncating files with no
   reproduction — but then say so in the source, so the next reader does not re-derive it.

## Acceptance

- [ ] `lastWork === -1` no longer allows a stop *silently* — it either blocks, widens, or is
      documented as a deliberate accepted risk at the return site.
- [ ] Whichever is chosen, a test covers the empty-window input.
