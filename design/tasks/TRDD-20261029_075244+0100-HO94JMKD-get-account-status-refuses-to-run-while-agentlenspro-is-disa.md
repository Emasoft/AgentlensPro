---
trdd-id: HO94JMKD
title: get_account_status refuses to run while AgentlensPro is disabled
column: dev
status: tasked
created: 2026-10-29T07:52:44+0100
updated: 2026-10-29T11:09:15+0100
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
implementation-commits: [9a35bd4f]
---

# get_account_status refuses to run while AgentlensPro is disabled

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-29

- Increment 1 DONE, commit 9a35bd4f (in implementation-commits): get_account_status --all passes the disabled gate and skips the launch self-heal. Follow-ups (dispatcher tests, CHANGELOG, docs) are working-tree changes, uncommitted.
- Side effects of --all while disabled: (a) possible copy of a newer legacy cache into ~/.agentlens/subscription-usage (archiveAccountUsage, src/subscriptionUsage.ts:502); (b) possible macOS keychain read in the diagnosis branch via loadToken when consent is stored; (c) --out FILE writes the named file.
- Boundary: server-only verbs still refuse while disabled with exit 69 (singular get_account_status, investigate_burn, get_burn_status, budget).
- NEXT ACTION: increment 2 (fetch the live account from the OAuth usage endpoint on --all). Note: model-headroom appears to already archive its OAuth fetch into the per-account archive (the live row read observed 11m ago after a model-headroom run) - TO BE VERIFIED. If true, the footer verdict usageRefreshCapability must learn about that path.

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
