---
name: multi-account-window-status
description: "how do I see every account's rate-limit windows not just the live one / should I rotate and onto which account / why does a non-live account show unreadable / what does rolled mean in get_account_status --all / an account had headroom but nothing could see it / stale usage reading still useful"
ocd: 2026-08-02
lmd: 2026-08-02
metadata:
  node_type: memory
  type: project
  tier: component
---

# multi-account-window-status

`agentlenspro get_account_status --all` answers "where does EVERY account stand", from data already on
disk — **no credential is read for a non-live account, ever**. It exists because a rotator faces a
bootstrap paradox: deciding whether to switch needs the headroom of the accounts it is NOT on, and the
only way to learn an account's status used to be to already be on it. See
[[claude-subscription-usage-endpoint]] for the singular reading it is built from.


^ATOM-1SB4-NM5B [desc:"get_account_status --all joins the roster, the per-account usage archive and (not) the statusline store", keywords: where_does_the_multi_account_answer_come_from which_file_knows_an_account_exists roster_vs_usage_archive_vs_statusline_store, ocd: 2026-08-02, lmd: 2026-08-02]

The answer is a JOIN of three files, each contributing what the others cannot. `account-state.ndjson` is the ROSTER — the only source that knows an account EXISTS, since `~/.claude.json` holds exactly one `oauthAccount` (the live one). `subscription-usage/<accountUuid>.json` holds each account's last true window numbers. The statusline Parquet store holds per-turn rate_limits but only recently and only for the live account, so it cannot answer for a non-live one at all.


^ATOM-GLUZ-NJ36 [desc:"key per-account files on accountUuid; the refresh-token fingerprint is not an identity", keywords: cache_key_changed_without_an_account_switch one_account_scattered_across_many_files orphaned_per_fingerprint_cache_files which_field_identifies_an_account, ocd: 2026-08-02, lmd: 2026-08-02]

The per-account usage archive is keyed by `accountUuid`, NEVER by the credential fingerprint. The fingerprint derives from the REFRESH token, which Anthropic rotates server-side, so it changes with no account switch — keying files on it scatters one account across a growing pile of orphaned files. The fingerprint stays INSIDE each record as the cache-validity key, where a change is correctly a cache MISS rather than a new identity.


^ATOM-GQQ8-IMQD [desc:"freshness is per window; aged keeps the number as a lower bound rather than discarding it", keywords: what_does_aged_mean_in_account_status why_is_freshness_per_window_not_per_account five_hour_and_seven_day_disagree_on_staleness, ocd: 2026-08-02, lmd: 2026-08-02]

`freshness` is reported PER WINDOW, not per account: the 5h and 7d roll at wildly different rates, so one day-old reading yields a known-empty 5h and a merely-aged 7d, and a single account-level label cannot say both. Five values — `fresh` (measured), `aged` (past the TTL but NOT reset; utilization only grows inside a window, so the number survives as a LOWER bound), `rolled` (INFERRED ~0%), `stale` and `unreadable` (both null WITH a reason). The account-level field is just the worse of the two.


^ATOM-T948-58D3 [desc:"rolled: a reset window plus a machine that was off the account is EMPTY, not unknown", keywords: rolled_window_never_fires stale_reading_should_be_empty compare_leftAt_to_which_timestamp window_reset_but_still_reported_as_current inference_reported_as_measurement, ocd: 2026-08-02, lmd: 2026-08-02]

A stale reading is NOT automatically unknown. A window carries an absolute `resetsAt`; once that instant passes the window it described no longer exists, and if this machine was already OFF the account when the NEW window began, nothing local can have filled it — so the account is EMPTY, not unknown. That single inference is what makes observed data useful for rotation. The comparison is `leftAt` vs the RESET instant, not vs the reading, and it is suppressed when the reading's account contradicts what `~/.claude.json` claims.


^ATOM-W8ZG-2G8J [desc:"an unreadable account is a ROW with a reason, never an omission", keywords: why_does_an_account_show_unreadable_instead_of_being_omitted missing_row_reads_as_no_headroom empty_roster_is_blind_not_no_accounts per_model_weekly_bucket_makes_account_look_spent, ocd: 2026-08-02, lmd: 2026-08-02]

`unreadable` is NEVER an absent row, and this is the whole reason the feature was asked for. 'Cannot read this account' and 'this account has no headroom' are OPPOSITE signals to a rotator, and a missing row renders as the second — which is how a machine stalls at its limit while an account with a nearly empty window sits unseen. Same rule as the `blind` flag on an empty roster: never 'no accounts'. Model-scoped weekly buckets are reported but never folded into the account verdict, because a spent per-model bucket does not block other models.


^ATOM-BTBU-57A5 [desc:"a diagnostic for a wedged machine must not depend on that machine's server", keywords: cannot_reach_localhost_4316 diagnostic_fails_when_the_server_is_down tool_description_claims_offline_but_proxies verify_the_offline_claim, ocd: 2026-08-02, lmd: 2026-08-02]

The plural verb is served by a CLI fast path that BYPASSES the server: it reads only files, and its audience is deciding what to do about a machine that is already in trouble. The first build proxied to the server and answered `cannot reach http://localhost:4316/mcp` when stopped — while the tool description already claimed it worked cold. Verify an offline claim by stopping the server and running the command.


^ATOM-3G7H-SN3B [desc:"the archive only fills if something REFRESHES; rotation is the one moment a non-live account can be read", keywords: all_accounts_show_unreadable archive_never_fills nothing_fetches_usage_on_a_schedule when_can_a_non-live_account_be_read keychain_opt-in_does_not_reach_the_server, ocd: 2026-08-02, lmd: 2026-08-02]

Archiving on fetch preserves only what something else already asked for — and nothing did: 13 h after
the archive shipped it still held ONE record. The server now refreshes at startup, hourly, and ON
ACCOUNT CHANGE. The last is the one that makes non-live rows possible at all: limits are per account
and the usage endpoint only ever answers for the credential currently installed, so the ONLY chance to
capture account B's windows is while B is live — miss it and B stays `unreadable` until the next
rotation. The refresh passes NO `allowKeychain` (a daemon that can hang on a macOS password dialog is
worse than a stale number), so on macOS it needs `AGENTLENS_READ_KEYCHAIN_USAGE=1` in the SERVER's
environment; setting it for the CLI does nothing, because the fetch is server-side. [^1]

## Notes and lessons learned

[^1]: [id:ATOM-EIRJ-GPEU, status:valid, desc:"log every outcome of a background refresh, not just success", keywords:"cannot_tell_if_the_timer_fired silence_means_two_things logged_only_success feature_unverifiable_from_the_log", ocd:2026-08-02, lmd:2026-08-02] DO NOT log only the SUCCESS of a periodic background refresh, BECAUSE a refusal (no readable token, a 429 cooldown) then looks exactly like the timer never firing, and "is this working?" has no answer from the log — measured: it cost a full diagnostic cycle unable to distinguish the two. DO log every outcome with its reason, deduplicated on the reason so a recurring refusal states itself once.
