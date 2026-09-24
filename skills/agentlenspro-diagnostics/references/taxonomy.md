# agentlenspro-diagnostics — Taxonomy

> Reference file, read on demand from [../SKILL.md](../SKILL.md). Section names in **bold** that
> are not in this file are listed, with the file that holds them, in that index.

## Taxonomy — what these numbers ARE (read before choosing `--mode`)

Every metric belongs to exactly one **measurement kind**, and the kind decides which questions are
answerable. This is why the commands refuse some combinations instead of returning a number: the
refusal is the design, not a limitation.

| Kind | Behaves like | Metrics | `total` | `rate` | `since` |
|---|---|---|---|---|---|
| **Cumulative** | an odometer — only ever rises | `input` `output` `cache-read` `cache-create` `tokens` `cost` `turns` | ✅ | ✅ | ✅ exact |
| **Rolling gauge** | a fuel gauge on a window that empties behind you | `pct-5h` `pct-7d` `cost-5h` `cost-7d` | ✅ | ✅ | ⚠️ allowed, but can go **negative** as old usage leaves the window (the watch says so at arm time) |
| **Live rate** | a speedometer — already per-minute | `cost-per-min` `tokens-per-min` | ✅ | ✅ read straight, never differenced | ❌ *"already a rate"* |
| **Instant gauge** | a headcount — true only right now | `active-sessions` | ✅ | ✅ | ❌ *"no per-run total"* |

Kind and scope are independent: `cost-per-min` is a live rate on the **account**, `tokens-per-min`
a live rate on the **machine**.

⚠️ **A threshold on a cumulative `total` fires exactly once and then never again** — an odometer
that passes 100k never drops back under it, so the excursion cannot close. That is arithmetically
right and useless as an alert, so the watch warns you at arm time and points at `--mode rate`
(recurring spikes) or `--mode since` (this run only). Prefer those two for alerting.

And exactly one **scope**, which decides what the number covers and what you must pass:

| Scope | Covers | Requires | Served by |
|---|---|---|---|
| **session** | one conversation | `--session <id>` (get one from `get_recent_sessions`) | `get_agent_tokens` |
| **account** | one OAuth account's rate-limit windows | nothing | `get_window_eta` |
| **machine** | every session on this box | nothing | `get_burn_status` |

**Three honesty rules the output obeys — trust them when reading it:**

1. **`null` is not `0`.** A feed with no number says so and the watch reports it; it never prints a
   `0` you might act on. If a value stops arriving, the watch says that too, once.
2. **A refusal beats a plausible number.** `--metric cost --mode since --since <past>` is rejected
   at parse time because a past cost cannot be reconstructed without per-message pricing — it does
   not silently substitute a token count.
3. **Provenance is labeled.** `capacity.source: same-plan-proxy` means the window cap was borrowed
   from another account on your plan — good to an order of magnitude, not a hard boundary.
4. **Every alert names the culprit.** A peak or an abort carries `who:` — the top workdirs by
   burn, with each one's share and the watched session marked `←THIS`. The machine is shared by
   many sessions and workdirs, so *"is this mine?"* is part of the alert, never a follow-up.

**Exit codes are a contract** (both long-lived commands): `0` fine · `1` **ABORT** (budget only) ·
`2` could not answer honestly · `64` your command line was wrong. A harness can branch on these;
`64` deliberately never collides with `1`, so a typo can't masquerade as a real abort.

