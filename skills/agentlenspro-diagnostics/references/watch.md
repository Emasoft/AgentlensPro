# agentlenspro-diagnostics — Watching any metric for peaks

> Reference file, read on demand from [../SKILL.md](../SKILL.md). Section names in **bold** that
> are not in this file are listed, with the file that holds them, in that index.

## Watching ANY metric for peaks — `agentlenspro watch`

`budget` answers one question and **exits** on the answer. `watch` observes one metric
**indefinitely and never stops on an alert** — it reports each peak as it happens and keeps going.
Use it when the question is "tell me whenever X spikes", not "may I start this run".

```bash
agentlenspro watch --metric cache-create --session <id> --mode rate --threshold 50000
agentlenspro watch --metric pct-5h --threshold 80
agentlenspro watch --metric tokens-per-min --threshold 1000000 --interval 15
agentlenspro watch --metric cost --session <id> --mode since --threshold 5
```

| scope | metrics | source |
|---|---|---|
| **session** (needs `--session <id>`) | `input` `output` `cache-read` `cache-create` `tokens` `cost` `turns` | `get_agent_tokens` — truly cumulative, so every mode is exact |
| **account** | `pct-5h` `pct-7d` `cost-5h` `cost-7d` `cost-per-min` | `get_window_eta` — **rolling gauges**, not accumulators |
| **machine** | `tokens-per-min` `active-sessions` | `get_burn_status` — live rate |

**Modes.** `total` = the current value · `rate` = change per minute (a source that is already a
rate is read straight, not differenced) · `since` = consumed since `--since` (**default: the moment
the watch started**). A **past** `--since` is reconstructed from the transcript — session-scoped
token metrics only, and **deduped by message id**, because Claude Code repeats one message's full
usage on every content-block row (measured over-count: **1.7× on cache-read, 2.1× on output**).

**Peaks, not samples.** An excursion opens when the value reaches `--threshold` (one `PEAK-START`
line) and closes when it falls below `threshold × --hysteresis` (default `0.9`), emitting one
`PEAK` line with the **maximum reached and how long it lasted**. Nothing is printed in between —
a line per sample would flood the stream, and a monitor that floods is stopped automatically, so
a chatty alert destroys itself. Hysteresis exists so a value oscillating on the threshold does not
open and close an excursion every poll. `--every` opts into per-sample echo; `--json` emits one
object per line.

**Exit codes are a contract**, and a caller mistake never borrows a runtime code: `0` stopped
cleanly (`--for` elapsed) · `2` the metric had no value to watch · **`64` (sysexits EX_USAGE) the
command line was wrong**. `budget` gains the same `64`, so a mistyped flag can no longer be
mistaken by a harness for its `1` = ABORT. `--for MINUTES` bounds a watch's lifetime (default `0`
= until killed). If the feed stops returning a value the watch says so ONCE and keeps polling —
an hour of silence must never be readable as "nothing crossed the threshold" when it means "there
has been nothing to measure".

**It refuses what it cannot answer honestly** rather than returning a plausible number: a
session metric with no `--session`, a "since" on something that is already a rate, a per-run total
for machine-wide burn, a past `--since` on a rolling gauge. A feed that has no value yields a
stated failure, never a fabricated `0` — `0` is a measurement and absence is not.

### Durable, SSD-friendly logging (`--log` / `--flush-ms`) — on both `watch` and `budget`

```bash
agentlenspro watch --metric tokens-per-min --threshold 2000000 --log ~/logs/burn.log --flush-ms 1000
```

Writes are **coalesced**: lines buffer for `--flush-ms` (default `1000`, max `60000`, `0` = write
through) and land as ONE append. A monitor that wrote every event immediately would turn a
200-byte line into a full flash page-program cycle, all day, for a file nothing reads in between.

The trade is explicit and bounded — **up to `flush-ms` of lines are lost if the process is killed
uncleanly** — but integrity never is:

- only **complete lines** are buffered, so a flush can never emit a fragment;
- a flush is a single `appendFileSync` with `O_APPEND`, so two watchers on one file interleave at
  line boundaries instead of clobbering each other;
- the buffer is **capped** — a failing disk cannot grow it without limit; the oldest lines are
  dropped and **counted**, and the count is reported on recovery, because a log that silently
  loses events lies by omission;
- `exit`, `SIGINT` and `SIGTERM` all flush, so an orderly stop loses nothing;
- the flush timer is `unref`'d and never holds a finished process open.

Verified by SIGKILL mid-run: every line on disk was complete and newline-terminated, zero
malformed records. Apart from this opt-in log, `watch` and `budget` **write nothing** — every tool
they call is a read.

