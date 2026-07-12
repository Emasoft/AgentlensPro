---
trdd-id: HUWJVQJA
title: CLI environment/system detection surface — agentlenspro env (facets + JSON report)
column: complete
created: 2026-07-13T01:12:21+0200
updated: 2026-07-13T01:35:00+0200
current-owner: claude-code-review
assignee: claude-code-review
priority: 2
severity: LOW
task-type: feature
release-via: publish
delivery: direct-push
target-branch: main
feature-branch: feat/cli-env-detection
test-requirements: [unit, lint, typecheck]
relevant-rules: []
attempts: 0
last-test-result: not-run
implementation-commits: []
---

# CLI environment/system detection surface

## ⏵ STATE — READ FIRST — 2026-07-13

**✅ DONE + gated GREEN 1002 passing / 0 failing (was 938 baseline; +64 tests). Committed on
`feat/cli-env-detection` (f611c4a feature, docs commit next), verified live.** All 10 facets ship
in `src/environment/` behind the `EnvFacet` registry; `agentlenspro env [facet] [--json] [--out FILE]
| env list` wired in main.ts + USAGE. Foundation + 3 exemplars authored directly; the 7 detector
modules via a parallel spark-agent fan-out on the exemplar contract. Live smoke confirmed:
terminal=iterm via process ancestry, git worktree+branch, tailscale running, agentlens ports
4316/4318/3000, 31 plugins, `--out` writes 10 facets as JSON with only a digest to stdout. Two
post-fan-out fixes: `go` probed with `go version` (not `--version` → garbage), tooling label spacing.
Docs: README "Environment diagnostics" + ARCHITECTURE tree + CHANGELOG [2.6.0] + package.json → 2.6.0.
**NOT pushed — v2.6.0 release awaits USER confirmation** (npm pkg, not a plugin).

---
_Original plan below (superseded by the DONE summary above):_

## ⏵ STATE (original plan) — 2026-07-13

**Ask (user, /goal):** add a diagnostic surface to the `agentlenspro` CLI that detects and reports
the full nature of the runtime environment — terminal kind (iTerm/Ghostty/WezTerm/kitty/Alacritty/
Warp/Hyper/Windows Terminal/macOS Terminal/VS Code/tmux/…), OS + version + arch, Claude Code context
(desktop vs CLI vs VS Code, session id, permissions, headless worktree, background agent), ai-maestro
membership, container/dev-container/CI/WSL/sandbox, filesystem + git-worktree, user/account, network
(interfaces, VPN incl. Tailscale, proxy config, listening local services, router/NAT), cloud ecosystems
(AWS/Azure/GCP), tooling (compilers, package managers, linters/formatters, version managers, runtimes,
venv/conda, PATH), and configured MCP servers. Each facet queryable **singly** OR **all as one big JSON
report** (`--json --out FILE`) to save tokens.

**Reference method (verified — the janitor's identify_environment.py + lib/state.py, v0.41.0):**
- Terminal kind by **PROCESS ANCESTRY**, not `$TERM_PROGRAM` (which lies — inherited into subshells /
  goes stale). Walk parent PIDs via `ps -axo pid=,ppid=,command=`, match each ancestor cmd against a
  pattern table (tmux/iterm/wezterm/kitty/ghostty/alacritty/hyper/warp/vscode/apple-terminal),
  NEAREST match wins. Override: `JANITOR_FORCE_TERMINAL_KIND`.
- ai-maestro agent: env flags `AIMAESTRO_AGENT`/`THIS_IS_AIMAESTRO` truthy, OR internals
  `AMP_AGENT_ID`/`AID_AUTH` present.
- container/sandbox: `/.dockerenv` (docker), `/run/.containerenv` (podman), `/proc/version` contains
  microsoft/wsl (WSL), env markers `KUBERNETES_SERVICE_HOST`/`CODESPACES`/`REMOTE_CONTAINERS`/
  `DEVCONTAINER`/`GITPOD_WORKSPACE_ID`/`container`/`APP_SANDBOX_CONTAINER_ID`.
- OS version: `sw_vers -productVersion` (macOS) / `/etc/os-release` PRETTY_NAME (Linux).
We RE-IMPLEMENT this in TypeScript (the CLI is TS/Node; we do not shell out to the janitor). Same
signals, ported. Not a Claude Code plugin → do NOT push; releases wait for user confirmation.

**Design — modular facet framework (runtime = Node, lives in `src/environment/`):**
- `src/environment/exec.ts` — fail-soft async `run(cmd,args,{timeoutMs})` → `{ok,stdout}` (never throws;
  detection must never crash), `which(bin)`, `firstLine`. All probes time-boxed.
- `src/environment/types.ts` — `FacetResult`, the `EnvFacet` contract `{ name, aliases, gather(): Promise<unknown>, render(v): string }`, shared primitives.
- Detector modules, ONE facet each, exposing PURE classifiers (injectable inputs, unit-tested) + a thin
  async `gather()`:
  - `terminal.ts` — process-ancestry terminal kind (port table) + multiplexer (tmux/screen/zellij) +
    ai-maestro + the raw terminal env signals (TERM/TERM_PROGRAM/WT_SESSION/…). PURE: `parsePsTable`,
    `processAncestry`, `terminalFromCommand`, `aiMaestroFromEnv`.
  - `os.ts` — system/release/arch/version/kernel/hostname/uptime/cpu/mem (os module + sw_vers/os-release).
  - `runtime.ts` — CI (GITHUB_ACTIONS + generic CI + others), container/devcontainer/WSL/sandbox
    (port markers), Claude Code (CLAUDECODE, session id, desktop/CLI/vscode-integrated, headless),
    background-agent. PURE: `ciFromEnv`, `containerSignals`, `claudeContextFromEnv`.
  - `filesystem.ts` — cwd/home/project dir/fs-type/git repo + **worktree** (linked vs main, branch,
    common-dir), disk free, case-sensitivity.
  - `user.ts` — user/uid/gid/groups/shell/home/sudo-capable.
  - `network.ts` — hostname, non-internal interfaces, VPN (Tailscale via `tailscale status`/utun*/
    interface names), proxy env (HTTP(S)_PROXY/NO_PROXY/npm), DNS, listening local ports/services
    (lsof/ss), default gateway.
  - `cloud.ts` — AWS (env AWS_*, ~/.aws, `aws` cli), Azure (AZURE_*, `az`, ~/.azure), GCP (GOOGLE_*,
    `gcloud`, ~/.config/gcloud). Env/file/CLI presence only — NO metadata-server calls by default
    (opt-in `--probe-imds` later; IMDS hits are slow + can hang off-cloud).
  - `tooling.ts` — compilers, package managers, linters/formatters, version managers, language runtimes
    (node/python/ruby/go/java/deno/bun), active venv/conda, PATH. Concurrent `which` + version probes.
  - `mcp.ts` — configured MCP servers (parse `~/.claude.json` + project `.mcp.json` + settings).
  - `claude.ts` — Claude Code config dir, session id, permission mode (from settings.json), installed
    plugins/marketplaces count, subscription/plan hints (best-effort, non-authoritative).
- `src/environment/index.ts` — the facet REGISTRY (static array) + `gatherAll()` + `renderFacet`.
- `src/cli/envCli.ts` — `runEnvCli(argv)`: `env` (all, text digest), `env <facet>`, `env list`,
  `--json`, `--out FILE` (full JSON to disk, one-line digest to stdout — token economy). Wire
  `case 'env'` into `main.ts` + a USAGE block in `diagnosticsCli.ts`.

**Phases:**
1. **Foundation + exemplars (me):** `exec.ts`, `types.ts`, `terminal.ts` (the load-bearing port),
   `os.ts`, `runtime.ts`, `index.ts` (registry with the 3), `envCli.ts`, wire main.ts + USAGE, tests
   for the PURE classifiers. Gate GREEN, commit. This sets the CONTRACT the fan-out follows.
2. **Fan-out (spark agents, 1 file each):** `filesystem.ts`, `user.ts`, `network.ts`, `cloud.ts`,
   `tooling.ts`, `mcp.ts`, `claude.ts` — each conforms to the Phase-1 `EnvFacet` contract + exemplar,
   fail-soft, cross-platform, with a pure-classifier unit test. I integrate each into `index.ts`.
   Gate GREEN, commit (batched ≤5 files per commit).
3. **Docs + polish:** README "Environment diagnostics" section, USAGE, ARCHITECTURE bullet, CHANGELOG.
   Final gate. (Version bump → v2.6.0, but DO NOT push — user confirms release.)

**Gate:** `bash scripts/safe-deploy.sh --dry-run` GREEN (baseline 938/0). No server.ts change here, so
no bundle rebuild needed for mocha — BUT rebuild `node esbuild.js` before any live CLI smoke (the
linked `agentlenspro` runs the built `standalone/cli.js`). Commit often; merge --no-ff; DO NOT push.

## Approval log
Tier-0 (agent-independent) — in-scope feature on the project's own source, reversible, no baseline
deviation, no external-facing change. Authored under /go-on-yourself + the direct /goal request.
