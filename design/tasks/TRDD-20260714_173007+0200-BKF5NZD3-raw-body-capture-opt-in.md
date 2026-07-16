---
trdd-id: BKF5NZD3
title: Raw-body capture must be opt-in — the server re-arms it on every boot
column: dev
created: 2026-07-14T17:30:07+0200
updated: 2026-07-14T17:30:07+0200
current-owner: a0fce09a
task-type: bugfix
parent-trdd: K3WDPR7M
severity: critical
---

# Raw-body capture must be opt-in — the server re-arms it on every boot

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-07-14

**The SSD burn never stopped, and this is why.** `OTEL_LOG_RAW_API_BODIES` is an
unconditionally-**owned** telemetry key (`src/telemetryConfig.ts:117`) that the server
**force-converges on every boot** (`standalone/server.ts:3237` → `ensureTelemetryConfig`).
So the removal at 04:22 could not stick: a hook revived the server, its boot re-applied the
owned set, and the key was **re-added at 15:07** — proven by the two `safeConfigEdit`
backups (`~/.claude/settings.json.agentlens-bak-20260714_{042225291,150707632}`), whose diff
is exactly this one key.

**NEXT ACTION:** implement the fix below (TDD), then restart and measure REAL device writes
(`scripts_dev/measure_writes.py` — `ri_diskio_byteswritten`, never file-size growth).

### Load-bearing facts

- **The convergence loop is unconditional** (`telemetryConfig.ts:235`):
  `if (env[key] !== value) ops.push({op:'set', ...})`. A key the user deletes is re-added
  the next boot. There was **no way to turn raw-body capture off** — by design, unnoticed.
- **`--uninstall-otel` would RESTORE the burn.** The marker records
  `OTEL_LOG_RAW_API_BODIES: {hadKey: true, priorValue: 'file:…/otel-bodies'}` (managed
  2026-07-07) — the user had set it by hand *before* AgentlensPro. So the uninstall path,
  which faithfully restores prior state, re-arms the 35 GB/day sink. Uninstalling to stop
  the burn would have made it worse.
- **Cost of the key** (measured, TRDD-K3WDPR7M): Claude Code re-serializes the WHOLE
  conversation on EVERY LLM request — 0.7–1.9 MB each, ~21 MB/min, **~35 GB/day**, with no
  documented cleanup. 22 GB had accumulated. The only two documented sinks are `1` (inline,
  truncated at 60 KB → useless) and `file:<dir>` (untruncated, unbounded).
- **Claude Code reads `env` at LAUNCH.** A settings edit reaches only *future* sessions —
  which is why 13 stale sessions kept writing through the 04:22 fix.

## The fix

1. **`src/captureConfig.ts` (new)** — raw-body capture becomes a durable, discoverable knob
   in `DATA_DIR/config.json` (the same file retention already uses), precedence
   `env > file > default`, **default OFF**. It is the single most expensive thing we can ask
   Claude Code to do, so it must be opt-in, and the opt-out must be one the tool cannot undo.
2. **`ownedKeys()` is gated on it** — the key is only *owned* when capture is on.
3. **Capture OFF must ACTIVELY DELETE the key**, not merely stop adding it. Omitting it from
   the owned set is not enough: the converge loop only touches owned keys, so an already-
   present key would sit in settings.json forever and keep burning. Guard: delete **only our
   own value** (`file:${bodiesDir}`) — a user who points the sink at their own directory owns
   that choice, and we must not clobber it.
4. **`removeTelemetryConfig()` must NOT restore the key while capture is off.** "Uninstall =
   restore prior state" is the right contract in general, but capture-off is an explicit user
   intent that must outlive the uninstall of our wiring — otherwise the undo path re-arms the
   burn (the same class of bug as #3).
5. **`agentlenspro disable` strips the key too.** "Disable AgentlensPro" must mean "stop all
   the writing we caused", and the biggest write we cause is *asking Claude Code to dump every
   body*. A kill-switch that leaves the burn running is a lie.

## Verify

- Gate GREEN: `bash scripts/safe-deploy.sh --dry-run` (baseline 1025 passing).
- `agentlenspro config list` shows `captureRawBodies=off (default)`.
- Boot the server with capture off ⇒ the key is **absent** from settings.json and **stays**
  absent across a second boot (the re-arm is dead).
- Boot with capture on ⇒ the key is present (no functionality lost — it is opt-in, not gone).
- REAL device writes measured after the restart, not file-size growth.

## Bug autopsy — why this happened, and the guardrail

"Owned keys" conflated two very different things: **wiring** (endpoint, exporters, intervals —
cheap, idempotent, correct to force-converge) and a **capture policy with an unbounded cost**
(dump the whole conversation to disk, every request, forever). Force-converging the first is
right; force-converging the second removes the user's ability to say no — and we did it in a
loop that runs on every server boot, which any hook can trigger. The guardrail: **a setting
whose cost is unbounded is never "owned" — it is a knob, defaulting to the cheap value, and
every undo path (uninstall, disable) must honor OFF rather than restore ON.**
