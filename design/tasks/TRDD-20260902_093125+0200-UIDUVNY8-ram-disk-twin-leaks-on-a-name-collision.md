---
trdd-id: UIDUVNY8
title: ensureRamDisk leaks a twin volume when the spool name is already taken
column: human_review
created: 2026-09-02T09:31:25+0200
updated: 2026-09-24T13:36:31+0200
current-owner: main-session
task-type: bugfix
priority: normal
min-approval-requirement: none
related: [ZW4APOPI, 5PUD8RKE]
---

# ensureRamDisk leaks a twin volume when the spool name is already taken

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

- **Decision (USER 2026-09-02, measured):** the RAM-disk bodies spool STAYS. Under the sessions already
  running, 21 samples over 10 min showed spool files oscillating 1–86 as each 60 s bodies pass drains them,
  staged bytes ≤ 24 MB of 2 GB, backpressure inactive, parked 0; all 72 files present at window start were
  gone by the end (deletion accounting, not net count). alcore logs `bodies pass: ingested N, deleted N,
  failed 0 across 2 dir(s)`. The USER's rule was "if it works it stays, else remove it and ingest directly".
- **The defect:** `/Volumes/AgentLensSpool 1` (`/dev/disk29`, 2 GB, empty but for `.fseventsd`) sat mounted
  beside the live spool since 2026-08-30. `src/ramdisk.ts:ensureRamDisk` checks only the mount POINT
  (`ramDiskInfo`); when two callers race (the login LaunchAgent `agentlenspro spool ensure` and a
  `setup`/`config set` run) both see "not mounted", both `hdiutil attach`, and the second `erasevolume`
  mounts at `<name> 1`. The post-check at `ramdisk.ts:156-159` then THROWS without detaching `dev` — that is
  the leak. A 2 GB RAM volume held by `diskimages-helper` (1.4 GB RSS measured) for nothing.
- Detached by hand 2026-09-02 09:27 (`hdiutil detach /dev/disk29`, verified empty first).
- **NEXT ACTION:** in `ensureRamDisk`, on a failed post-check detach `dev`, re-read `ramDiskInfo(mountPoint)`,
  and return the first caller's mount if it is now present (idempotent race), else throw. Unit test with an
  injected `execFileSync` that mounts at `<name> 1`.
- **DONE 2026-09-02 (commit 5bb076c8; in the CLI bundle since the 12:5x `node esbuild.js`).** Boxes 1–2
  hold at the unit level; box 3 (a real `spool ensure` + `setup` race on this machine) was deliberately
  NOT run — it mutates the live RAM disk. Review decides whether that is acceptable evidence.
  `mount | grep -c AgentLensSpool` is 1 since the hand detach at 09:27.
2026-09-24 — superseded by TRDD-Z53IJFE9 per the owner's 2026-09-24 directive to remove the spool completely; column left as-is, the owner decides.

## Acceptance

- [x] A failed post-mount check detaches the device it created; a test proves `hdiutil detach <dev>` is
      called when `erasevolume` mounted elsewhere.
      Evidence: `src/ramdisk.ts` `ensureRamDisk` post-check branch; `src/test/ramdiskTwin.test.ts`
      case "post-check mounted elsewhere…" asserts the `hdiutil detach` call and its device arg.
- [x] Two racing `ensureRamDisk` calls end with ONE volume; the loser returns the winner's mount.
      Evidence: same test, asserts `ensureRamDisk` returns the winner's `mountPoint` when the retry
      `ramDiskInfo` reports it mounted — verified at the unit level with a stubbed `execFileSync`
      (`opts.exec`/`opts.mkdirSpoolDir` injection seams added); no real two-process race was run.
- [ ] `mount | grep -c AgentLensSpool` stays 1 across a `spool ensure` + `setup` run on this machine.
      Not run — would mutate real RAM-disk state on this machine; out of scope for this fix.

## Approval log

- 2026-09-05T15:30:26+0200 — orchestrator accepts the 15:27 AI-review APPROVE and leaves box 3 OPEN
  on purpose: the author deferred it as a live-state mutation and asked the reviewer to decide, and
  that decision (accept the unit-level race proof, or demand a real two-process run) is the human
  reviewer's, not this session's. Re-ran the read-only check myself: `mount | grep -c AgentLensSpool`
  → 1 at 15:30 — circumstantial, as the verdict says. Nothing struck, nothing split.
- 2026-09-24T08:57:38+0200 — column → human_review by main-session. AI review verified, evidence in reports/board-triage ai_review-A/B/C triage
- 2026-09-24T08:57:49+0200 — main-session (board update A): moved ai_review -> human_review; AI review verified per reports/board-triage ai_review-A/B/C triage rows. In this project's mono-agent rule the session moves ai_review->human_review; the owner moves human_review->complete.

## Notes and lessons learned

- Empty section on creation.

## AI review verdict — run: 2026-09-05T15:27:49+0200

| Box | Status | Evidence |
|---|---|---|
| 1. failed post-check detaches `dev`, test proves `hdiutil detach` called | ✓ VERIFIED | `git show 5bb076c8 -- src/ramdisk.ts` lines ~104-117: on `!post.mounted` the code now calls `exec('hdiutil', ['detach', dev], …)` (best-effort, try/catch) before the retry. `src/test/ramdiskTwin.test.ts` both `test(...)` cases assert `calls.find(c => c.cmd==='hdiutil' && c.args[0]==='detach')` is truthy and (case 1) that its device arg is `/dev/disk999` — the exact device `hdiutil attach` returned to the stub. Read the diff body, not the commit message. |
| 2. racing calls end with ONE volume; loser returns winner's mount | ✓ VERIFIED | Same diff: after the detach, code does `const retry = ramDiskInfo(mountPoint, exec); if (retry.mounted) { …; return { mountPoint, sizeBytes: retry.sizeBytes ?? … } }`. Test case 1 stubs `df` to report "not mounted" on calls 1–2 and "mounted" on call 3 (the retry), then asserts `r.mountPoint === mountPoint` (the winner's mount) — i.e. the loser call returns the winner's volume, not a twin. Both cases traced line-by-line against the injected `exec`/`mkdirSpoolDir` seams added in the same diff (`opts.exec`, `opts.mkdirSpoolDir`), confirming the seam is real and used, not decorative. |
| 3. `mount | grep -c AgentLensSpool` stays 1 across a `spool ensure` + `setup` run | ✗ UNVERIFIED — deliberately not run; documented in-card as out of scope (mutates live RAM-disk state). Read-only check permitted by this review's constraints: `mount | grep -c AgentLensSpool` on this machine now returns `1` (consistent with the STATE block's hand-detach on 2026-09-02 09:27, and with no regression since). This is circumstantial — it does not exercise the actual two-process race the box describes — but the box's own rationale for skipping it is genuine (a real race test would create/detach real RAM disks on the reviewer's machine) and was already flagged in the STATE block as "Review decides whether that is acceptable evidence," not silently dropped or appended out of scope after the fact. `git log -p --follow` on this card shows box 3's wording present in the original authoring commit (card creation), unchanged since — it is an originally-scoped-out acceptance item, not a later appendix. |

**Test-run gate:** the two unit-test cases were read and traced against `src/ramdisk.ts`'s actual post-diff logic and are internally consistent (correct stub shape, correct assertions, `suite`/`test` mocha style matching the project's other `src/test/*.test.ts`), but were **not executed** — deferred per this review's hard constraint (no `mocha`/`pnpm test`/build, CPU-starved by a concurrent Rust build). Exact command deferred: `pnpm run compile-tests && npx mocha out/test/test/ramdiskTwin.test.js`.

**Defects noted (non-blocking):**
- Frontmatter carries no `implementation-commits:` field even though the card cites a landed commit (5bb076c8) in its body/STATE block — the backtracking field the TRDD schema expects for shipped code is absent. Should be added (`implementation-commits: [5bb076c8]`) on next touch; not a reason to reject since the commit is independently verifiable via git.
- `column: ai_review` with one open box is internally consistent here (the STATE block explicitly asks the reviewer to decide on box 3), not a mis-columned card.

**Verdict: APPROVE** — boxes 1–2 verified first-hand against the actual diff and test assertions (not just commit-message claims); box 3's non-completion is a documented, deliberate scope decision (not a hidden gap or out-of-scope appendix), correctly left for `human_review` to accept or demand a real two-process repro.
