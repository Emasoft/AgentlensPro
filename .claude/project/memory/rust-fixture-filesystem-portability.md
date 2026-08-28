---
name: rust-fixture-filesystem-portability
description: "the test passes locally but fails only on CI / green on macOS red on ubuntu / the workspace test run aborts at the first failing binary so later tests never ran / report.premium.lastModel got claude-fable-5 expected claude-opus-5 / burnguard_parity fails on CI only / newest by mtime picked the wrong file / git checkout does not preserve mtimes / all fixture files share one timestamp / pinned mtimes are fixture data / durable_state_round_trips left (4, 1) right (3, 2) / log_reader_parity rotation not detected / remove_file then write did not change the inode / ext4 reuses a freed inode but APFS does not / how do I reproduce the CI filesystem condition locally / a fixture depending on unguaranteed filesystem behaviour"
ocd: 2026-08-28
lmd: 2026-08-28
metadata:
  node_type: memory
  type: component
  tier: component
  globs: [rust-core/crates/agentlens-core/tests/**]
publish-globally: false
---

# rust-fixture-filesystem-portability


^ATOM-2PSS-WR4Q [desc: "a parity fixture that depends on mtimes or inode allocation is green on APFS and red on ext4; commit the mtimes and rotate by rename", keywords: passes_locally_fails_on_CI green_on_macOS_red_on_ubuntu mtime_lost_on_checkout git_does_not_preserve_mtimes newest_by_mtime_wrong_file lastModel_fable-5_instead_of_opus-5 burnguard_parity inode_reused_after_delete ext4_inode_reuse APFS_never_reuses_inode rotation_not_detected imported_skipped_4_1_instead_of_3_2 log_reader_parity reproduce_CI_filesystem_locally fixture_depends_on_filesystem_behaviour, ocd: 2026-08-28, lmd: 2026-08-28]

Two CI-only failures on 2026-08-28, one root shape: **a fixture depended on filesystem
behaviour macOS guarantees and Linux does not.** Both were invisible locally and cost a CI
round-trip each.

**mtimes are fixture DATA.** `BodiesActivityTracker` ranks responses by `md.modified()`
(`log_reader.rs` stat → `ResponseEntry { t: mtime }`). The oracle pinned mtimes with
`utimesSync`, but **git checkout does not carry mtimes** — on a fresh clone all five
`*.response.json` share one checkout timestamp, no `e.t > cur.t` ever fires, and the fold
keeps whichever readdir yielded first. Fix: the generator records every `touch()` into
`expected.mtimes` and the test re-pins before polling (the pattern `agentgate_parity.rs`
already used). Reproduce the CI condition with `touch -r <ref> {} +` — **`touch {} +` alone
gives distinct nanosecond mtimes, not the exact ties CI has**, so it reproduces a different
condition and can pass where CI fails.

**Inode allocation is a policy, not a guarantee.** A rotation set up as `remove_file` +
`write` gets a fresh inode on APFS; **ext4 hands the just-freed number straight back**, so
`import_file_state`'s `rec_ino != ino` check saw nothing rotated and resumed the file.
Fix: **write-then-rename** — the replacement is created while the original still holds its
inode, so a distinct one falls out of the allocator having no choice, on every POSIX fs.
`rename` is also atomic, so the path is never briefly absent (which `stat` would have
counted as a skip for a third, different reason).

**This class cannot be caught locally.** mtimes can be clobbered to imitate CI; inode
allocation policy cannot. CI is the only honest oracle for filesystem-dependent behaviour —
and because the workspace run aborts at the first failing test binary, **each fix reveals
the next test CI had never reached**, so budget for serial round-trips rather than
expecting one green run.

## Notes and lessons learned
