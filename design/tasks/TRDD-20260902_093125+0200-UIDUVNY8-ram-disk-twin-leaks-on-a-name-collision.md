---
trdd-id: UIDUVNY8
title: ensureRamDisk leaks a twin volume when the spool name is already taken
column: dev
created: 2026-09-02T09:31:25+0200
updated: 2026-09-02T11:46:12+0200
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

## Notes and lessons learned

- Empty section on creation.
