# C3 shared case matrix — `buildAccountStateRecord` + `discreteKey` + the timeline WRITER

> **This file is the CANONICAL copy** and lives next to the artifacts it specifies. It was
> authored during the slice under gitignored `docs_dev/`; that copy is scratch and may be stale.
> The generator, the Rust port and both test files cite THIS path.
>
> **Case 23 (`writer-failed-flush-rebuffers`) was added after the fact** and is documented at the
> end of Part 3 — the original Part 3 stopped at the happy path.

One matrix, three authors: the oracle generator (`gen-acctstatetimeline-expected.mjs`), the Rust
port (in `crates/agentlens-core/src/account_state_timeline.rs`), and the parity test
(`acctstatetimeline_parity.rs`). Same ids, same order, in all three.

TS source of truth: `src/accountStateTimeline.ts` (compiled to `out/test/accountStateTimeline.js`).

## What is ALREADY ported (do NOT re-port)

`describe_plan`, `describe_account_mode`, `resolve_auth_regime_label`,
`account_state_timeline_path`, `read_timeline`, `resolve_state_at` — all in
`crates/agentlens-core/src/account_state_timeline.rs`. The module's own header comment claiming
`resolveStateAt` / `buildAccountStateRecord` are "NOT PORTED YET" is STALE for the first of them;
whoever edits the module fixes that comment.

## Part 1 — the record (`buildAccountStateRecord`)

`buildAccountStateRecord(account: AccountInfo | null, ttlCtx: TtlContext | null, now)` →

```
{ ts, accountId, email, mode, plan, authRegime, ttlMinutes, ttlSource }
```

Key ORDER is exactly that. **These are `null`, NOT absent** (`accountId`, `email`) — unlike the
log-event sink, this record has no optional keys; every key is always present.

Load-bearing details:
- `email` falls back to `account.label` when `account.email` is missing — **`?? `, so an EMPTY
  STRING email is kept**, not replaced by the label.
- `plan` is `describePlan(planType, rateLimitTier)` ONLY when `account && account.source !==
  'none'`; otherwise the literal `'unknown'`.
- `authRegime` is `resolveAuthRegimeLabel(...) ?? 'unknown'`.
- `ttlMinutes`/`ttlSource` come from `classifyTtlRegime('main', ttlCtx)` — **always `'main'`**,
  because `get_account_status` is a main-conversation tool. Passing the subagent kind here would
  silently halve every TTL.

| # | id | Input | Watch for |
|---|---|---|---|
| 1 | `full-subscription` | account with uuid+email+planType+rateLimitTier, `billingType: 'stripe_subscription'`, `source: 'claude.json'`; a ttlCtx with `auth: 'subscription'` | every key present; plan is the human name |
| 2 | `no-account` | `account: null`, `ttlCtx: null` | `accountId`/`email` are `null`; `plan` is `'unknown'`; `authRegime` is `'unknown'` |
| 3 | `source-none` | an account with a real planType but `source: 'none'` | `plan` is `'unknown'` — the planType is DELIBERATELY ignored |
| 4 | `email-falls-back-to-label` | `email` absent, `label: 'work acct'` | `email` = `'work acct'` |
| 5 | `email-empty-string-kept` | `email: ''`, `label: 'work acct'` | `email` = `''` — `??` keeps it; a `||` port would return the label |
| 6 | `ttlctx-wins-over-billing` | `billingType: 'stripe_subscription'` but `ttlCtx.auth: 'usage-credits'` | `authRegime` = `'usage-credits'` — a present ctx ALWAYS wins |
| 7 | `no-ttlctx-api-billing` | `ttlCtx: null`, `billingType: 'api'` | `authRegime` = `'api-key'` |
| 8 | `unknown-plan-type-echoed` | a planType this code has never heard of | echoed VERBATIM with the multiplier, NOT replaced by `'unknown'` |

## Part 2 — the change-detection key (`discreteKey`)

```ts
[r.accountId ?? '∅', r.mode, r.plan, r.authRegime, r.ttlMinutes].join('\x01')
```

**`email` and `ttlSource` are NOT in the key, on purpose** — and that is the trap. A port that
includes `ttlSource` writes a record every time the source flips `assumed`→`measured`, turning a
few-writes-per-hour timeline into a firehose. `accountId: null` becomes the literal `'∅'`
(U+2205), and the separator is `\x01`, not a comma.

| # | id | Two records differing only in… | Expected |
|---|---|---|---|
| 9  | `key-ignores-email` | `email` | SAME key |
| 10 | `key-ignores-ttlsource` | `ttlSource` | SAME key |
| 11 | `key-ignores-ts` | `ts` | SAME key |
| 12 | `key-null-account-is-sentinel` | one `accountId: null`, one `accountId: '∅'` | SAME key — a documented collision, keep it |
| 13 | `key-mode-differs` | `mode` | DIFFERENT key |
| 14 | `key-ttlminutes-differs` | `ttlMinutes` | DIFFERENT key |

## Part 3 — the writer (`AccountStateTimeline`)

Rust shape (own the whole struct; NO auto timer — alcore's chore drives the flush, the same split
every other chore uses):

```rust
pub struct AccountStateTimeline { /* file_path, buffer, buffered_bytes, last_key */ }
impl AccountStateTimeline {
    pub fn open(file_path: PathBuf) -> Self;          // seeds last_key from the file TAIL
    pub fn record(&mut self, state: Map<String, Value>) -> bool;  // true iff enqueued
    pub fn flush(&mut self);                          // append + fsync ONCE per batch
    pub fn buffered(&self) -> usize;                  // for tests
}
```

- `FLUSH_MAX_RECORDS = 32`, `FLUSH_MAX_BYTES = 16 * 1024`; `record` auto-flushes when either is
  reached. `buffered_bytes` grows by `JSON.stringify(state).length + 1` per record.
- **`open` seeds `last_key` from the LAST line of the file** so a restart into an unchanged state
  does not re-log it. An unreadable/absent file or a torn tail ⇒ `None`, never an error.
- **`flush` fsyncs ONCE per batch, never per record** — per-record fsync is the SSD killer this
  design exists to avoid.
- **A failed write RE-BUFFERS the batch in front of anything enqueued meanwhile** and never
  panics. Losing the batch instead would be silent data loss; the buffer is bounded in practice
  because discrete changes are rare.

| # | id | Sequence | Expected |
|---|---|---|---|
| 15 | `writer-first-record-enqueues` | one record onto an empty timeline | `record` → true, 1 buffered, file still absent until flush |
| 16 | `writer-same-key-is-noop` | the same discrete state twice | second `record` → false, still 1 buffered |
| 17 | `writer-email-change-is-noop` | same state, different `email` | second → false (the key ignores email) |
| 18 | `writer-mode-change-enqueues` | same account, different `mode` | second → true, 2 buffered |
| 19 | `writer-flush-writes-ndjson` | 2 records then `flush()` | file has 2 lines, each the record verbatim, trailing newline |
| 20 | `writer-reopen-seeds-last-key` | flush, drop, `open` the same path, record the SAME state | → false — a restart into an unchanged state re-logs nothing |
| 21 | `writer-torn-tail-seeds-none` | a file whose last line is truncated JSON | `open` succeeds, `last_key` is None, the next record enqueues |
| 22 | `writer-32-records-autoflushes` | 32 records with 32 DIFFERENT discrete keys | the file exists before any explicit flush; 0 buffered |
| 23 | `writer-failed-flush-rebuffers` | 2 records, then a flush whose parent dir is a FILE | buffer back to 2 (NOT dropped), no file, and a later record enqueues behind it (3) |

Case 23 was added after the eight above were written, and it is the one that matters most: a
writer that swallowed the io error and cleared the buffer passes all of 15–22 and loses every
state change during a disk problem, silently. The buffer count is the only observable that
separates the two.

Cases 15–22 are NATIVE Rust tests (the TS writer has no clock/fs seam worth oracling); cases 1–14
are TS-ORACLED. Put them in different files: the oracle cases in `acctstatetimeline_parity.rs`,
the writer cases in `account_state_writer.rs`.

## Fixture file (cases 1–14 only)

`rust-core/crates/agentlens-core/tests/fixtures/acctstatetimeline-expected.json`:

```json
{ "records": [ { "id": "full-subscription", "account": {...}|null, "ttlCtx": {...}|null,
                 "now": 1700000000000, "expected": {...} }, ... ],
  "keys":    [ { "id": "key-ignores-email", "a": {...record...}, "b": {...record...},
                 "same": true } , ... ] }
```
