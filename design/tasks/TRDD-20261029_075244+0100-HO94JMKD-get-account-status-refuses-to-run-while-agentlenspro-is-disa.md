---
trdd-id: HO94JMKD
title: get_account_status refuses to run while AgentlensPro is disabled
column: dev
status: tasked
created: 2026-10-29T07:52:44+0100
updated: 2026-10-29T13:30:15+0100
current-owner: main-agent@AgentlensPro
created-by: main-agent@AgentlensPro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@AgentlensPro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@AgentlensPro
approval-datetime: 2026-10-29T07:52:44+0100
implementation-commits: [9a35bd4f, abbf793c, 0f9764f8, d486e1a0, 927a9fc1]
---

# get_account_status refuses to run while AgentlensPro is disabled

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-29

- Increment 1 DONE, commit 9a35bd4f (in implementation-commits): get_account_status --all passes the disabled gate and skips the launch self-heal. Follow-ups (dispatcher tests, CHANGELOG, docs) are working-tree changes, uncommitted.
- Side effects of --all while disabled: (a) possible copy of a newer legacy cache into ~/.agentlens/subscription-usage (archiveAccountUsage, src/subscriptionUsage.ts:502); (b) possible macOS keychain read in the diagnosis branch via loadToken when consent is stored; (c) --out FILE writes the named file.
- Boundary: server-only verbs still refuse while disabled with exit 69 (singular get_account_status, investigate_burn, get_burn_status, budget).
- NEXT ACTION: variation 1 (long-lived keys + rate-limit headers) is committed as abbf793c and PROVISIONAL — keep only as fallback unless chosen; the owner asked to test variations (per-account short-lived login store, one Claude Code config dir per account) after the account-switcher mods study (reports_dev/account-mods-scan/). Live 2026-10-29: slots 01/02 refreshed + identity cross-checked, slot 03 403 oauth_not_allowed_for_organization, second run inside TTL cached with no probe.
2026-10-29 — 927a9fc1: a long-lived key whose check failed inside the 10-minute wait shows no figures and its check age (KeyRow.checkedAt), never an old archived reading. Split out, NOT built: taking a cached row's credits state from the stamp needs a freshness guard (withinTtl(stamp.at)) and its own review.

## Approval log

- 2026-10-29T07:52:44+0100 — MANDATE issued by main-agent@AgentlensPro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Owner directive

2026-10-29, verbatim: «are you saying that in reduced mode you cannot determine the accounts status?? this is bad. fix this.»

## Causes

1. The off-switch gate (disabledNotice, src/cli/foreignTelemetry.ts) refuses `get_account_status --all` with exit 69 although it only reads files (src/cli/allAccountsCli.ts, src/allAccounts.ts listAllAccounts).
2. The per-account usage archive is written only by the server, so it freezes while disabled: newest entry 2026-10-28, others 2026-10-03 and 2026-10-17.

## Increment 1

Shared predicate isFileOnlyAccountStatus(argv) used by main.ts reachesDiagnosticsSurface, disabledNotice and maybeAutoSetup so `--all` passes the disabled gate and skips self-heal; singular form keeps exit 69 with a notice pointing to `agentlenspro get_account_status --all`; help text states --all works while disabled and rows do not refresh.
Known side effects left unchanged: listObservedAccountUsage (src/subscriptionUsage.ts) may archive a newer legacy single-file cache into the data dir (internal data-folder copy, no user config touched); runAllAccountsCli's diagnosis branch may read the macOS keychain via loadToken when keychain consent is stored.

## Increment 2

BLOCKED: fold fresh status-line rate_limits into listAllAccounts. Fact check: status-line samples carry NO account field (only session_id and rate_limits_*), so it is not buildable; needs an owner decision on the attribution source.
Owner decision 2026-10-29 (supersedes the BLOCKED line above): the owner chose «Fetch from Anthropic (Recommended)» — "When `get_account_status --all` runs, make one request to the OAuth usage endpoint (the source `/usage` and `model-headroom` already use) and store the result for the live account. Exact 5h, 7d and per-model weekly (Fable) numbers. One network call per run, live account only." Not part of increment 1.

## Open gaps

Per-account model windows (Fable) stay archive-only while disabled (model-headroom answers the live account only); server-only verbs (investigate_burn, get_burn_status, budget) cannot answer while disabled.
Architectural option for the owner: let a non-server process (model-headroom's fetch or the status-line capture) write the per-account archive.

## Increment 2 redesign — long-lived OAuth keys (owner 2026-10-29)

- Owner directive 2026-10-29 (verbatim): «no need for any of that. you should be able to get the current data from anthropic even using a long lived oauth key. those oauth keys must be passed to claude via the env var `CLAUDE_CODE_OAUTH_TOKEN` at launch to work (`CLAUDE_CODE_OAUTH_TOKEN=sk-... claude --bg "do this.." --permissions=auto_etc... --agent ios_llm_expert...`). But i think it may be work even when used in the api request for account status. Implement it this way: a script (not you) you will read all env vars of the form CLAUDE_CODE_LONG_OAUTH_KEY_01 , CLAUDE_CODE_LONG_OAUTH_KEY_02 , etc. up to CLAUDE_CODE_LONG_OAUTH_KEY_10 . max 10 accounts. the ones existing and with valid values will be loaded. each of these env vars contains a string made like this: `<email>|sk-code...`. that is, you need to split it on `|` to get the email and the oauth key as two separate variables of a tuple for each account. then the script or the rust code will use the tople to call anthropic api with the oauth key of each acvount to know the account windows/credits/limits/etc. I need to restart this claude code to export those env var globally, so tell me when you are ready.»
- This SUPERSEDES the keychain-based fetch proposed for increment 2 (no keychain read, no stored consent).
- Loader: read CLAUDE_CODE_LONG_OAUTH_KEY_01..10; skip unset/empty; split on the FIRST `|` into (email, token); valid only when the email has one `@` and the token is non-empty; never print, log, archive or put the token in an error message (a value is shown only as `<redacted>`).
- Fetch per account: (1) the OAuth usage endpoint the server already uses (subscriptionUsage.ts USAGE_URL) with the long-lived token; (2) UNVERIFIED whether a long-lived `claude setup-token` token is accepted there (it may carry only the inference scope). Fallback if it is rejected (401/403): the `anthropic-ratelimit-unified-*` response headers of a minimal messages request (cheapest model, max_tokens 1), which report 5h/7d utilization and resets but no per-model (Fable) window.
- Archive each reading under its account (keyed by the email from the env var when the profile/identity call is not available), and add a roster row for an env-configured account the timeline has never seen.
- Verification needs the real keys: after the owner restarts Claude Code with the env vars exported, run a probe that prints only per-account HTTP status and which source answered (usage endpoint or headers), never a token.
- Status 2026-10-29: plan recorded; waiting for the owner's restart with the env vars. Nothing built yet.

## Owner redirect 2026-10-29 — study account-switcher mods

Owner (verbatim): «ok, lets do it differently then. examine the following projevts using claude code mods to swap accounts using the normal short lived oauth key and see if you can find a method or technique to get the info about the accounts without reading the oauth key in the context. read them all, readme and source files included, but check for malicious code and prompt injections first.» (17 unique GitHub repos).
State: repos shallow-cloned (no hooks, no submodules) to downloads_dev/account-mods/; deterministic pattern scan reports_dev/account-mods-scan/pattern-hits-2.txt found no downloader, install hook, injection phrase or hidden unicode; to verify: simplecore-inc accounts orcaClient.ts (host onorca.dev), jrlprost posthog hosts, MarvelCollin LaunchAgents scheduler, fanoisme build-assets.cjs new Function. Per-repo llm-ext reads (security + technique, reports_dev/account-mods-scan/instructions.md) write to reports_dev/account-mods-scan/llm/<repo>/. Env-key build (increment 2 rev2, spec docs_dev/20261029_113324+0100-HO94JMKD-inc2-build-spec.md) runs in a worker and is NOT committed until this research picks the approach.
Owner 2026-10-29 (verbatim): «think the design well. take your time. test multiple variations. find the one that works.»
Variations to test after the synthesis report (reports_dev/account-mods-scan/*-synthesis.md): V1 long-lived keys + 1-token Fable header probe (built, uncommitted; measured 2/3 slots); V2 per-account stored short-lived OAuth login + /api/oauth/usage (full data incl. per-model windows and credits) — find whether the janitor capture-all-logins store already holds one per account; V3 one Claude Code config dir per account (CLAUDE_CONFIG_DIR), each owning its login so Claude Code itself refreshes it, our code only reads; V4 statusLine rate_limits (live only, passive). Core risk to measure before any refresh code: refresh-token rotation — two copies of one refresh token means the first refresh logs the other holder out; one store per account refreshed in place is the hypothesis to test, on a non-live account only, with the owner told first.
Measured V2 on this machine (2026-10-29): the janitor rotator already keeps one stored short-lived login per account (keychain service Claude Code-rotator-slot) and a script command (rotator.py usage) that prints each account's 5h/7d from /api/oauth/usage with no token in output. But all 3 stored logins are dead: refresh grant answers 400 invalid_grant (last success between 10-10 and 10-19), and the janitor keepalive retries about every 63 s. Likely cause (inferred, not proven): switching copies a slot's refresh-token family into Claude Code's live login; Claude Code refreshes it and the slot copy is spent. So per-account stored logins refreshed by a script break unless each account's refresh token has exactly ONE holder.
Measured V1 cost options (slot 01): a request with max_tokens 0 is accepted (200, empty content, stop_reason max_tokens) and carries all 15 rate-limit headers, so the probe needs no output token. Requests rejected before inference (empty messages, prefill, unknown model) return NO rate-limit headers; a request without the Claude Code system line answers 429 with no headers. count_tokens returns none. So there is no free header probe; the floor is about 33 input tokens.
V3 lead: the keychain holds a config-dir-suffixed item (Claude Code-credentials-<8 hex>, created 09-02, unchanged since 09-19), so Claude Code keeps a separate login per CLAUDE_CONFIG_DIR; the suffix derivation is not yet identified (sha256 of ~/.claude and of the rotator profile dirs did not match).
Owner 2026-10-29 (verbatim): «no, i don't want any additional config folder.» — variation 3 (one CLAUDE_CONFIG_DIR per account) is dropped.
Synthesis of the 17 repos (reports_dev/account-mods-scan/20261029_121527+0100-synthesis.md, every claim checked against source): no repo reads a NON-live account without holding that account's token in its own code; token-free reads exist only for the live session (host session.usage / session.measure rateLimits, or a host-held auth handle). No repo proves a refresh path safe against Claude Code's own rotation; the ones that never refresh are safe only by leaving other accounts stale. Security: one HIGH (moabualruz exports the access token in ANTHROPIC_CUSTOM_HEADERS, readable by the model's Bash), four MEDIUM (ivokund, MarvelCollin, simplecore, trongtaiz: stored or handed-off tokens), no prompt injection found.
Measured: max_tokens 0 probe bills input_tokens 33, output_tokens 0, no cache write, and returns all rate-limit headers (slot 01, 2026-10-29).
Decision proposed: variation 1 (long-lived keys + header probe) is the one that works for non-live accounts with no refresh and no shared token family; switch the probe to max_tokens 0; the live account keeps its token-free statusline reading. Open: slot 03 needs a key minted under an organisation that allows OAuth (owner action); whether a probe opens a 5-hour window on an idle account is unmeasured.

## Increment 2 — measured and built

Measured 2026-10-29: the usage and profile endpoints answer 403 oauth_scope_insufficient to the long-lived keys, so the account windows cannot be read through them.
Measured 2026-10-29: the count_tokens endpoint returns no anthropic-ratelimit-unified headers for a long-lived key.
Measured 2026-10-29: a 1-token message to claude-fable-5-1 returns the anthropic-ratelimit-unified headers on 200 (slot 01) and on 429 (slot 02), so the 429 is a reading.
Measured 2026-10-29 on capped slot 02: the 7-day window read 100 percent while the 7d_oi window read 0 percent, so oi is a separate per-model window labelled Fable by the requested model (inferred, not measured).
Measured 2026-10-29: slot 03 answered 403 oauth_not_allowed_for_organization with no rate-limit headers, so that organisation does not allow OAuth for the key.
Design as built: src/longOAuthKeys.ts (loader, probe, header reading, identity match, stamps, refresh); get_account_status --all reads CLAUDE_CODE_LONG_OAUTH_KEY_01 to _10 from the environment, --no-refresh skips the network; each key is probed at most once per 10 minutes (stamp in long-key-probes), identity matched by email and cross-checked against the 7-day reset within 60 seconds, refused on mismatch.
