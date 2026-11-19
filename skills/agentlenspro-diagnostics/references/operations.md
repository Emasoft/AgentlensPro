# agentlenspro-diagnostics — Install, server control, local commands

> Reference file, read on demand from [../SKILL.md](../SKILL.md). Section names in **bold** that
> are not in this file are listed, with the file that holds them, in that index.

## Install / repair — `agentlenspro setup`

ONE idempotent verb installs, verifies, or repairs the whole stack:

```bash
agentlenspro setup --dry-run   # read-only: shows what would change, exits 0
agentlenspro setup --yes       # converge: every step CHECK → ACT → VERIFY, then self-test
```

Pipeline (fail-fast — a FAIL stops the run, remaining steps SKIP, exit non-zero):
**environment** (read-only heuristics: platform/arch + WSL label, Node vs the engines floor,
native-dep resolvability, foreign-process-on-OTLP-port, `~/.claude` presence, free disk —
hard-fails on native Windows with WSL2 guidance, on old Node, or on a broken install) →
data-store (sqlite quick_check; corrupt DB backed ASIDE, never wiped) → spool-migration → otel-env →
hooks → status line (refreshes a stale stamp of agentlenspro's own command; never installs or wraps
one) → skill → old-package migration → server → final end-to-end self-test (synthetic span
round-trip + registered hook/gate execution) → memory-check. A second run over a converged install reports
**0 actions** — that is the idempotency proof. Data is NEVER deleted by setup.

**Platforms: macOS and Linux; Windows ONLY via WSL2** (native win32 is refused by the
environment probe — install Node ≥ 20.9 inside the WSL distro and `npm install -g agentlenspro`
there). Hook registrations changed by setup need a Claude Code session restart to take effect.

## Server, daemon & telemetry control

The tools call a resident server; these verbs manage it. `setup` wires everything, but each is
also a standalone command:

```bash
agentlenspro server start|stop|restart|status      # the UI/API + OTLP server (background)
agentlenspro server start --supervise              # foreground crash-restart supervisor (exit 78 = terminal, no respawn)
agentlenspro dashboard                             # ensure the server is up, then open http://localhost:3000
agentlenspro daemon start|stop|restart|status      # the always-on ingestion daemon (same process as the server);
                                                   # `status` also prints the hook-spool depth. Hooks auto-revive it,
                                                   # so no log is lost while it is down
agentlenspro daemon install|uninstall              # launchd agent (macOS) keeping the daemon up 24/7 across
                                                   # logout+reboot — opt-in; the CLI still starts it on demand without this
agentlenspro telemetry install|uninstall|status    # the Claude Code full-telemetry env in ~/.claude/settings.json
                                                   # (verified transaction; the verb form of --install-otel/--uninstall-otel,
                                                   # plus `status` to check whether it is wired)
agentlenspro heartbeat-cost [--oneline]            # exact token + $ cost of the last settled janitor heartbeat fire
```

`server` vs `daemon`: they are the SAME process — `server` is the operator-facing name (it serves
the dashboard), `daemon` is the ingestion-facing name (it drains the hook spool). Use `daemon
install` only when you want ingestion to survive a full logout/reboot without any Claude session
running; for interactive use the on-demand `--start-server` (or any tool call) is enough.

### Memory guard of alcore

alcore exits with status 1 when a memory limit is breached and writes a culprit log to `rss-hard-cap.log` in the data dir. Both limits are checked every 5 s:
- `AGENTLENS_RSS_HARD_CAP_MB` (default 2048): commit cap on mimalloc committed bytes. A breach writes a `RSS HARD CAP` log.
- `AGENTLENS_FOOTPRINT_BACKSTOP_MB` (default 3 times the commit cap, 6144 MB; half of host RAM when that is smaller and still above the cap): checked only while the commit is at or under the cap, macOS only. Above it, writes `FOOTPRINT BACKSTOP` lines to the same log. An override counts only as a positive MB value above the commit cap.
- `alcore serve` prints its effective limits once at start on its output (a `memory guard:` line; that output is server.log when the server was started by `agentlenspro server start`).
- Not covered: the startup work that runs before the first guard tick (the store open, the boot sweep and the inline hook-spool drain), and the time between two 5-second ticks.

## Local commands — no server needed (`config`, `env`)

These two subcommands run entirely client-side (they never touch the MCP server), so they work
whether or not the server is up.

### `agentlenspro config` — persistent data retention

Retention is tunable by six `AGENTLENS_*` env vars, but env vars are ephemeral and never reach the
launchd daemon. `config` persists them to `~/.agentlens/config.json` (in the data dir, so a value set
once survives an uninstall / upgrade / CLI-path change, and the always-on daemon re-reads it every
boot). Each knob resolves at boot as **env var > config.json > built-in default**, min-floored.

```bash
agentlenspro config                              # list every knob: effective value + source (env|file|default)
agentlenspro config get spansRetentionDays       # one knob's value + where it came from
agentlenspro config set spansRetentionDays 90    # persist a change (prints "restart to apply")
agentlenspro server restart                       # apply it
```

Knobs: `spansRetentionDays` (30) · `summaryWindowHours` (24) · `bodiesMaxGb` (8) ·
`bodiesRetentionDays` (31) · `logEventsRetentionDays` (31) · `apiCallsRetentionDays` (90) · `summaryCardDays` (14; the summary is built over log cards active since 00:00 UTC that many days ago, 0 = every card). Raw-body capture is mandatory (no knob): bodies land directly on the SSD at
`~/.agentlens/otel-bodies` and the drain ingests them every 60 s (the RAM-disk spool and the
`bodiesMaxAgeHours`/72h batching wait were removed in TRDD-Z53IJFE9). A
`set` on a corrupt config file REFUSES to write rather than clobbering it. Recipe — keep a year of
traces on a big disk: `agentlenspro config set spansRetentionDays 365 && agentlenspro server
restart`.

### Emergency stop: the real brakes, and `agentlenspro disable [reason]` / `enable` (collection only)

**The brakes that stop AgentlensPro doing something** (live, no restart):

- the dashboard right-panel switches (the same four as `--hooks`: burn gate, image cache-guard, event capture, advisor) — per switch, in realtime for every running session;
- `agentlenspro --hooks gate=off|warn|enforce cacheguard=off capture=off advisor=off` — the same switches from the CLI (no args shows them);
- `AGENTLENS_GATE=off` in the environment — silences every burn-gate guard, the image guard included; read on each invocation;
- `agentlenspro --uninstall-hooks` — removes the agentlens hook entries. A running session keeps its hooks until it restarts, and the next launch of a verb that self-heals the install registers them again (`AGENTLENS_NO_AUTOSETUP=1` stops that). The review gate and the review supervisor are never switchable.

**The kill-switch stops only COLLECTION.** `agentlenspro disable [reason]` drops one flag file that stops storing telemetry, raw
API bodies and hook events, plus the CLI hook spool (the status line is not collection: it always POSTs to the server, which stores it, and when no server takes the sample the hook appends it to the write-ahead file of the store, `<dataDir>/statusline/<stream>/<UTC day>/wal-cli.ndjson`, which `alcore statusline-seal --data-dir DIR` later turns into parquet parts with no server), in
**every** Claude Code session already running, on that session's next hook fire. No restart needed (a `settings.json` edit alone
cannot reach a session that already loaded its config). `AGENTLENS_DISABLED=1` in the environment is the same switch for the
process that sees it. The server runs in **no-collection mode** (answers, stores no telemetry, raw bodies or hook events; it still stores status-line samples). The switch refuses no command and
parks no skill: every verb runs while it is armed, and the burn-gate, the image cache-guard, the in-band advisor, the review
gate, the review supervisor and the dashboard switches stay as they were. `disable` stops a running server (its mode is read
only at boot) and the next hook revives it in no-collection mode; `server stop --stay-down` keeps it down. `disable` also turns
raw-body capture off; `enable` clears the flag and restarts a server still in no-collection mode. When a server answers, in three
cases it restarts nothing, the server stays in no-collection mode, and `enable` prints the reason and exits 2:

- The NO_REVIVE brake file (`NO_REVIVE` in the data dir, `~/.agentlens` by default) exists: `enable` honours it. Run
  `agentlenspro server restart` (with `AGENTLENS_DISABLED` unset): it restarts the server in collection mode and deletes the
  brake file itself once the start succeeds.
- `AGENTLENS_DISABLED=1` stays set in the environment (the verb cannot lift the env half): unset it, then re-run
  `agentlenspro enable`. With it set, `enable` exits 2 in the exit-0 cases below too.
- This dir's server is in no-collection mode but the data dir resolved from the environment differs from the enabled one (the
  stop could hit another dir's server): re-run as `AGENTLENS_DATA_DIR=<enabled dir> agentlenspro enable`.

It also restarts nothing, exit 0, when the answering server belongs to another data dir (not ours to restart) or already
collects. When no server answers (exit 0, braked or not), nothing needs restarting: the next failed hook POST revives one in
collection mode (the flag is gone), unless `AGENTLENS_NO_REVIVE=1` is set in the hook environment. If the NO_REVIVE brake file is
armed, no hook revives one: `agentlenspro server start` lifts the brake and starts one, collecting.

⚠ **Neither is how you stop a burning workload.** The kill-switch stops the *measurement*, not the burn — the guards stay on, but
the stored numbers you would diagnose the burn from stop exactly when they matter most. Reach for it only to take AgentlensPro's
storage out of the picture (debugging its own disk writes, handing the machine to someone else). To abort a run that is draining
the window, see **Budgeting a timed run** below.

### `agentlenspro env` — environment / system detection

Reports the full nature of the environment the CLI is running in — terminal kind resolved by
**process ancestry** (not `$TERM_PROGRAM`, which lies across subshells/ssh/multiplexers). Query one
facet, or omit it for the whole report; `--out FILE` writes the full JSON to disk and prints only a
one-line digest (keep a big report out of context).

```bash
agentlenspro env                       # whole environment, human digest
agentlenspro env list                  # the 10 facets + aliases
agentlenspro env terminal              # one facet (iterm/ghostty/tmux/vscode/…, ai-maestro, ssh)
agentlenspro env --json --out env.json # full report to a file (digest to stdout) — the agent default
agentlenspro env filesystem            # git worktree (main vs linked) + branch, fs type, free disk
```

| Facet (aliases) | Reports |
|---|---|
| `terminal` (term) | host terminal by process ancestry, multiplexer, ai-maestro agent, ssh, tmux |
| `os` (system) | OS product/version, kernel, arch, CPU, memory, uptime |
| `runtime` (ci, container, context) | CI runner, container/dev-container/WSL/sandbox, Claude Code context |
| `claude` (claude-code, permissions) | config dir, settings permission summary, plugin cache, CLAUDE.md, CLI version |
| `filesystem` (fs, disk) | cwd/home/project, fs type, git repo + worktree + branch, free disk |
| `user` (account, whoami) | user, uid/gid, groups, shell, sudo-capable |
| `network` (net) | interfaces, VPN (Tailscale/utun/WireGuard), proxy, DNS, listening ports, gateway |
| `cloud` (aws, azure, gcp) | AWS/Azure/GCP via env + local config + installed CLI (never contacts a metadata server) |
| `tooling` (tools, dev) | runtimes, package managers, compilers, linters, version managers — with versions |
| `mcp` (mcp-servers) | configured MCP servers from `~/.claude.json` + project `.mcp.json` |

Use cases: attach `agentlenspro env --json --out env.json` to a bug report; in CI, `agentlenspro env
runtime` confirms you're on GitHub Actions / in a container before running; `agentlenspro env terminal`
disambiguates a tmux pane from its GUI host; `agentlenspro env tooling` inventories a fresh machine.
Every detector is fail-soft and time-boxes its probes — an off-cloud `aws` or a stalled `tailscale`
can never wedge the report.

