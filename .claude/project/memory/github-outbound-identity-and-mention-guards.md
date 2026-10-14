---
name: github-outbound-identity-and-mention-guards
description: "check-identities is green but an address is public / agent pasted an account table into an issue / email leaked in a GitHub comment / redact a published comment / identity guard scans files not posts / a bare @handle paged a stranger on github / at-mention notified the wrong person / how to write a handle without pinging / mentions: search qualifier vs text search / @manager @janitor notified by mistake / deny-identity-leak-to-github.js PreToolUse hook / pasting get_account_status into a comment / is this hit a real address or a placeholder / bulk redaction sweep / searching for at-mentions returns thousands of hits / backtick the handle to make it inert"
ocd: 2026-08-02
lmd: 2026-10-14
metadata:
  node_type: memory
  type: project
  tier: component
publish-globally: false
---

# GitHub outbound posts — identity leaks and @mentions

^ATOM-K3U3-GHM5 [desc:"The file-scanning identity check cannot see outbound posts — a second guard covers gh", keywords: check-identities_is_green_but_an_address_is_public agent_pasted_an_account_table_into_an_issue email_leaked_in_a_github_comment redact_a_published_comment guard_scans_files_not_posts, type: reference, ocd: 2026-08-02, lmd: 2026-08-02]

An identity guard that scans FILES cannot see what an agent POSTS. On 2026-08-02 `check-identities` was green while three of the owner's real email addresses sat in three PUBLIC GitHub issue comments (AgentlensPro#8, ai-maestro#95, ai-maestro#102) — agents had pasted `get_account_status --all` and `lifetime-status.sh` tables, whose every row carries an account's email, straight into a comment. The check was not broken and needed no fix: its scope is tracked and shipped files, and a comment is neither. The second enforcement point is `scripts/deny-identity-leak-to-github.js` (PreToolUse on Bash), which scans any `gh` verb that publishes prose — including the body it would read from `--body-file`, the shape all three leaks actually took — and denies on an email or a real-username home path. Verified by replaying the real leaked body through it: denied, all three addresses named masked. [^1] [^2]

^ATOM-N20K-LDOD [desc:"A bare @handle in GitHub prose pages a real user; backtick it, and use mentions: to find real pages", keywords: at-mention_paged_a_stranger_on_github @manager_@janitor_notified_by_mistake how_to_write_a_handle_without_pinging mentions_search_qualifier_vs_text_search, type: reference, ocd: 2026-08-02, lmd: 2026-08-02]

An `@name` written in GitHub prose PAGES the account with that handle, and the handles agents reach for are already taken by real people. On 2026-08-02 agents writing role names in issue bodies notified two strangers across 9 issues (confirmed with the authoritative `mentions:<user>` search qualifier — NOT with a text search for the handle, whose 932 hits were GitHub tokenising the word and matching every prose use of it). The fix is one character each side: wrapped in backticks the handle renders as code and notifies nobody. The outbound guard `scripts/deny-identity-leak-to-github.js` now denies a bare mention in any `gh` post, stripping fenced and inline code first so the backticked form still passes.

## Governed by

- [[agentlenspro-ops-lessons-testing-and-process-hygiene]] — the testing and process-hygiene overview this page details.

## Notes and lessons learned

[^1]: [id:ATOM-OT53-GHOC, status:valid, desc:"A file-scoped check proves nothing about outbound text; verify each hit before redacting", keywords:"green_identity_check_but_public_leak pasting_an_account_table_into_an_issue bulk_redaction_sweep is_this_hit_a_real_address_or_a_placeholder", ocd:2026-08-02, lmd:2026-08-02] DO NOT paste a tool table into a GitHub issue, PR or comment without redacting it first, and DO NOT conclude "no identities are exposed" from a green `check-identities`, BECAUSE that check scans tracked and shipped FILES only — three real addresses sat in public comments while it reported clean, and a published address cannot be unsent. DO route the account/status views through a redaction pass before posting (the PreToolUse guard now refuses the obvious cases), and when sweeping a repo for leaks, VERIFY each hit before editing: one of the four hits found that day was a synthetic `johndoe` example in someone's documentation, and a bulk redaction would have mangled it for nothing.
[^2]: [id:ATOM-RFW9-SKOO, status:valid, desc:"A text search for a handle counts the word, not the ping", keywords:"searching_for_at-mentions_returns_thousands_of_hits same_count_for_different_handles mentions_qualifier", ocd:2026-08-02, lmd:2026-08-02] DO NOT search for who was paged with a text query like `@manager user:Emasoft`, BECAUSE GitHub tokenises away the `@` and matches the WORD — it returned 932 hits, nearly identical counts for four different handles, which is a signal that means nothing. DO use the `mentions:<user>` qualifier, which is recorded from the actual notification and returned the true answer (5 issues each).
