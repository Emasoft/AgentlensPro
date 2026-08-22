# C2(b) shared case matrix — `buildDroppedLogEventRecord` parity

> **This file is the CANONICAL copy** and lives next to the artifacts it specifies. It was
> authored during the slice under gitignored `docs_dev/`; that copy is scratch and may be stale.
> The generator, the Rust port and the parity test all cite THIS path.

One matrix, three authors: the oracle generator (`gen-logeventsink-expected.mjs`), the Rust
builder (`build_dropped_log_event_record`), and the parity test (`logeventsink_parity.rs`).
Every case below MUST appear, in this order, with these exact ids, in all three.

TS source of truth: `src/logEventSink.ts` (compiled to `out/test/logEventSink.js`).

## Signature

```ts
buildDroppedLogEventRecord(name: string, bare: string, wireAttrs: {key,value}[],
                           rec: Record<string, unknown>, ts = Date.now()): DroppedLogEventRecord
```

`ts` is ALWAYS passed explicitly in the fixture (no `Date.now()` — there is no clock seam).

## Record key ORDER — load-bearing, it is what `JSON.stringify` writes

`ts, ev, name, session?, traceId?, spanId?, tsEvent?, severity?, attrs, body?`

Optional keys are **absent**, never `null` (TS `...(x ? {x} : {})`). `attrs` is always present,
`{}` when empty.

## `unwrapAttrValue` — FIRST present wins, in this fixed probe order

`stringValue, intValue, doubleValue, boolValue, arrayValue, kvlistValue, bytesValue`
→ the inner value **verbatim**. `intValue` arrives as a JSON **string** and stays a string
(`Number()` would corrupt 64-bit ids). An unknown wrapper shape → the whole value object, raw.

## Cases

| # | id | Input | Expected |
|---|---|---|---|
| 1 | `full` | name `claude_code.user_prompt`, bare `user_prompt`, attrs: `session.id`=str, `count`=intValue `"9007199254740993"`, `ratio`=doubleValue 0.5, `ok`=boolValue true; rec: traceId, spanId, `timeUnixNano` string, `severityText` `"INFO"`, `body`:{stringValue}; ts 1700000000000 | every key present, in order; `count` stays the STRING |
| 2 | `session-fallback` | no `session.id`, has `session_id` | `session` = the `session_id` value |
| 3 | `no-session` | neither key | `session` ABSENT |
| 4 | `session-empty` | `session.id` = `""` | `session` ABSENT (empty string is falsy) |
| 5 | `tun-number` | `timeUnixNano` as a NUMBER `1700000000123456789` | `tsEvent` = `Math.round(n/1e6)` |
| 6 | `tun-nonnumeric` | `timeUnixNano` = `"12x"` | `tsEvent` ABSENT (regex `^\d+$`) |
| 7 | `tun-zero` | `timeUnixNano` = number `0` | `tsEvent` ABSENT (`> 0` required) |
| 8 | `tun-absent` | no `timeUnixNano` | `tsEvent` ABSENT |
| 9 | `ids-empty` | `traceId` = `""`, `spanId` = `""`, `severityText` = `""` | all three ABSENT |
| 10 | `body-kvlist` | `body` = `{kvlistValue:{...}}` (no `stringValue`) | `body` ABSENT |
| 11 | `body-plain-string` | `body` = `"hello"` (a bare string, not an object) | `body` ABSENT (TS requires an object) |
| 12 | `attr-array-kvlist-bytes` | attrs with `arrayValue`, `kvlistValue`, `bytesValue` | inner values kept verbatim (objects stay objects) |
| 13 | `attr-unknown-wrapper` | attr value `{"weirdValue": 1}` | the WHOLE `{"weirdValue":1}` object kept raw |
| 14 | `attr-multi-wrapper` | attr value carrying BOTH `intValue` and `stringValue` | `stringValue` wins (probe order) |
| 15 | `attr-bad-shape` | one attr with a **missing** `key`, one with `value: null`, one with `value: 5` | all three SKIPPED |
| 16 | `attr-duplicate-key` | same key twice, different values | **LAST** wins (plain assignment in a loop) |
| 17 | `attrs-empty` | `wireAttrs: []` | `attrs` = `{}`, present |
| 18 | `attr-order` | keys `zeta`, `alpha`, `mid` in that order | `attrs` key order = insertion order, NOT sorted |
| 19 | `body-empty-string` | `body` = `{stringValue: ""}` | `body` **PRESENT** as `""` — the guard is `typeof === 'string'`, not truthiness, unlike every other optional |

## Fixture file

`rust-core/crates/agentlens-core/tests/fixtures/logeventsink-expected.json`:

```json
{ "cases": [ { "id": "full", "name": "...", "bare": "...", "attrs": [...], "rec": {...},
              "ts": 1700000000000, "expected": { ...the record... } }, ... ] }
```

`expected` is the record as JSON — so a missing key and a `null` key are DIFFERENT, and key
order is preserved by `JSON.stringify` / serde_json `preserve_order`.

## Rust side

`pub fn build_dropped_log_event_record(name: &str, bare: &str, attrs: &[Map<String, Value>],
rec: &Map<String, Value>, ts: i64) -> Map<String, Value>` in
`rust-core/crates/agentlens-ingest/src/lib.rs`. `Map` is `serde_json::Map` (already the crate's
`Attr` type — a wire attr is exactly `{key, value}`).

## Parity assertion

Compare the SERIALIZED record to the fixture's `expected` serialized the same way — key ORDER
included. A key-set-only comparison would pass against a sorted map and is not acceptable.
