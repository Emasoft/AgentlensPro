---
name: agent-context-integrity-false-positives
description: "the janitor flags injection/authority-override patterns in CLAUDE.md or .claude/project/memory and says content arrived from outside this repo's identity / AICTX-003 ticket offered / should I open it"
ocd: 2026-08-22
lmd: 2026-08-22
metadata:
  node_type: memory
  type: reference
  tier: component
publish-globally: false
---

# agent-context-integrity-false-positives


^ATOM-SKK6-Q2ET [desc: "All 5 recurring agent-context-integrity findings on this repo are false positives; the 'arrived from outside' claim resolves to ONE BLANK LINE.", keywords: agent-context-integrity injection_pattern_in_CLAUDE.md authority-override_HIGH worm-self-propagation_npm_publish AICTX-003 content_arrived_from_outside Roger_Reed_author, type: reference, ocd: 2026-08-22, lmd: 2026-08-22]

The heartbeat's `[agent-context-integrity]` detector repeatedly reports **5 injection/authority
patterns in 3 files** here, and offers an `AICTX-003` ticket. **Triaged 2026-08-22 — all five are
FALSE POSITIVES. Do not open the ticket; re-confirm cheaply with the commands below rather than
re-investigating from scratch.**

| flagged | what it actually is |
|---|---|
| `CLAUDE.md:309`, `:356` | project doctrine ABOUT documentation reliability, authored by the repo owner 2026-08-04. It uses words like *supersedes* / *sole authority* / *false*, which is what the `authority-override` pattern matches. |
| `.claude/project/memory/agentlenspro-publish-pipeline.md:3,:31` | a page that DOCUMENTS the npm publish pipeline, so it necessarily contains `npm publish` — the shai-hulud `worm-self-propagation` signature. Owner-authored. |
| `.claude/project/memory/image-resident-cost-guard.md:17` | owner-authored doctrine. |

**The load-bearing part is the provenance claim**, because it is the only sentence that would
justify alarm: *"1 of them carry commits by an author other than this repo's own identity, so that
content arrived from outside."* That is technically true and practically empty. This repo is a
FORK of AgentLens, so it inherits upstream commits by that project's author (three, all
2026-06-04: a trailing newline, an MCP settings toggle, a docs honesty pass). Of the **431 lines**
in today's `CLAUDE.md`, exactly **one** is still attributed to them — **and it is a blank line.**

Re-confirm in two commands, both cheap:

```bash
git blame -L 309,309 -- CLAUDE.md          # -> the owner, not an outside author
git blame --line-porcelain -- CLAUDE.md | grep "^author " | sort | uniq -c
```

The second prints the author histogram; anything other than "owner, plus 1 line" is a REAL change
in provenance and deserves a fresh look. That is the discriminator — not the pattern hits, which
will fire forever on doctrine that discusses authority and on a page that documents publishing.

## Notes and lessons learned
