# AgentLens Architecture

AgentLens is a VS Code extension that receives OpenTelemetry (OTLP) telemetry from AI coding agents (GitHub Copilot, Claude Code, Codex), reads local session files and databases (including OpenCode's SQLite database), persists everything to a local SQLite database, summarises it into per-session cards, and visualises it in a sidebar and a full dashboard.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Extension Activation](#2-extension-activation)
3. [Data Ingestion Pipeline](#3-data-ingestion-pipeline)
4. [Local Log Ingestion](#4-local-log-ingestion)
5. [OTLP Collector](#5-otlp-collector)
6. [Session Summarizer](#6-session-summarizer)
7. [Per-Agent Summarizers](#7-per-agent-summarizers)
8. [SQLite Storage Layer](#8-sqlite-storage-layer)
9. [Session Data Model](#9-session-data-model)
10. [Frontend Architecture](#10-frontend-architecture)
11. [Cost Calculation](#11-cost-calculation)
12. [Auto-Configuration](#12-auto-configuration)
13. [Build Pipeline](#13-build-pipeline)

---

## 1. System Overview

```mermaid
graph TB
    subgraph Agents
        CP[GitHub Copilot<br/>OTLP HTTP spans]
        CC[Claude Code<br/>OTLP HTTP spans + logs]
        CX[Codex<br/>OTLP HTTP logs]
    end

    subgraph LocalLogs["Local log files / databases"]
        CL_LOGS["~/.claude/projects/**/*.jsonl"]
        CX_LOGS["~/.codex/sessions/**/*.jsonl"]
        CP_LOGS["~/.copilot/session-state/**/*.jsonl"]
        CP_VS["workspaceStorage/{hash}/chatSessions/{uuid}.jsonl<br/>(delta log — newer VS Code-family Copilot Chat)"]
        CP_JSON["workspaceStorage/{hash}/chatSessions/{uuid}.json<br/>(snapshot — older VS Code-family Copilot Chat)"]
        OC_DB["~/.local/share/opencode/opencode.db<br/>(SQLite — WAL merged at read time)"]
    end

    subgraph VSCode Extension
        COL[OtlpCollector<br/>HTTP :4318]
        LR[LogReader<br/>batch startup + 30s poll]
        STO[SessionStore<br/>5-min rolling span window]
        SUM[SpanSummarizer]
        WRI[DatabaseWriter]
        DB[(SQLite<br/>agentlens.db)]
        REPO[SessionRepository<br/>DB + live window]
        MCP[McpServer<br/>HTTP :4316/mcp]
        SID[SidebarPanel<br/>webview]
        DASH[DashboardPanel<br/>webview]
    end

    AGENT_MCP[Claude Code / MCP client] -- "POST :4316/mcp" --> MCP
    MCP -- listSessions / loadTimeline --> REPO

    subgraph Dashboard UI
        STATE[Preact Signals<br/>state.ts]
        TABS[Tab Components<br/>Sessions · Analytics · Cost · Alerts · Automation · Export · Help]
    end

    CP -- "POST /v1/traces" --> COL
    CC -- "POST /v1/traces<br/>POST /v1/logs" --> COL
    CX -- "POST /v1/logs" --> COL

    COL -- addSpan --> STO
    STO -- onUpdate → summarize → enqueue --> WRI

    CL_LOGS & CX_LOGS & CP_LOGS & CP_VS & CP_JSON & OC_DB --> LR
    LR -- "enqueue(card)" --> WRI

    WRI --> DB
    DB -- listSessions / queryDailyStats --> REPO
    STO -- live spans --> REPO
    REPO --> SID
    REPO --> DASH

    DASH -- "postMessage update<br/>+ analyticsData + burnRate" --> STATE
    STATE --> TABS
```

---

## 2. Extension Activation

> **Historical (pre-fork).** The VS Code extension host was removed before the fork
> (TRDD-6E6416B8): there is no `src/extension.ts` and no `vscode` dependency. The
> persistence modules this sequence wires up (`src/database/*`, `sessionRepository.ts`)
> are retained in-tree per the TRDD KEEP inventory but are exercised only by the unit
> tests, through the structural stand-ins in `src/vscodeCompat.ts`. The shipped runtime
> boots via `standalone/server.ts` and persists through the segmented span store
> (section 5) plus `~/.agentlens/forensics.db`. The sequence below is kept as the
> reference for the retained layer's original activation flow.

The extension activated in a fixed sequence.

```mermaid
sequenceDiagram
    participant VS as VSCode
    participant EXT as extension.ts
    participant DB as SQLite (db.ts)
    participant STO as SessionStore
    participant REPO as SessionRepository
    participant COL as OtlpCollector
    participant CFG as autoConfig

    VS->>EXT: activate(context)
    EXT->>EXT: createOutputChannel('AgentLens')
    EXT->>DB: openDatabase(globalStorageUri, extensionUri)
    Note over DB: Loads/creates agentlens.db<br/>Applies schema + migrations<br/>(cost_usd column guard)
    EXT->>STO: new SessionStore(context)
    EXT->>REPO: new SessionRepository(reader, writer, store)
    EXT->>REPO: migrateGlobalStateToSqlite()
    Note over REPO: One-time: globalState spans → SQLite
    EXT->>REPO: runRetention(retentionDays, blobsDir)
    Note over REPO: Delete sessions older than N days<br/>Evict orphaned blob files
    EXT->>STO: onUpdate → summarize → writer.enqueue<br/>→ drain → db.save + write last-write.json
    EXT->>COL: new OtlpCollector(port, store) + start()
    alt Port free
        COL-->>EXT: listening on :4318
    else EADDRINUSE
        COL-->>EXT: error — detect owner (plugin/standalone/foreign)
        EXT->>EXT: poll last-write.json every 2s<br/>reload DB snapshot on change
    end
    alt agentLens.enableLogIngestion = true (default)
        EXT->>LR: new LogReader(log)
        Note over EXT: setImmediate → defer off activation stack
        EXT->>LR: collectFileMeta() → all session files sorted newest-first
        Note over EXT: Fast group (.jsonl etc.): batch=10, setTimeout 0ms
        loop Fast batch
            LR->>LR: parseFile(filePath, agentKey)
            LR->>WRI: enqueue(card, workspace)
            WRI->>DB: drain → save
        end
        Note over EXT: Slow group (.json snapshots): batch=2, setTimeout 50ms
        loop Slow batch (after fast group completes)
            LR->>LR: parseFile(filePath, copilot_vscode_json)
            LR->>WRI: enqueue(card, workspace)
            WRI->>DB: drain → save
        end
        EXT->>EXT: setInterval(logReader.scan, 30_000ms)
    end
    par Auto-configure agents
        EXT->>CFG: autoConfigureCopilot(port)
        EXT->>CFG: autoConfigureClaudeCode(port)
        EXT->>CFG: autoConfigureCodex(port)
    end
    EXT->>VS: registerWebviewViewProvider('agentLens.dashboard')
    EXT->>VS: registerCommand('agentLens.openDashboard')<br/>registerCommand('agentLens.clearSessions')<br/>registerCommand('agentLens.showStorageStats')<br/>registerCommand('agentLens.exportData')<br/>registerCommand('agentLens.dumpSpanAttrs')
    EXT->>VS: createStatusBarItem → 'agentLens.openDashboard'
```

---

## 3. Data Ingestion Pipeline

There are two independent ingestion paths: OTLP (network) and local log files (disk). Both converge at `DatabaseWriter`.

```mermaid
flowchart TD
    subgraph OTLP["OTLP path (network)"]
        A[Agent emits OTLP payload<br/>HTTP POST /v1/traces or /v1/logs] --> B{Route}

        B -- /v1/traces --> T[processTraces<br/>Extract resourceSpans → spans]
        B -- /v1/logs  --> L[processLogs<br/>Extract logRecords → spans]
        B -- /v1/metrics --> M[processMetrics<br/>count only]

        T --> NS{Is Codex?}
        NS -- yes --> CS[Synthesise session ID<br/>Map OTEL trace → codex:conversation:turn]
        NS -- no  --> DS[Direct span<br/>preserve traceId + parentSpanId]

        L --> LS[Codex log reconstruction<br/>Prompt events → session boundary]

        CS --> ADD[store.addSpan]
        DS --> ADD
        LS --> ADD

        ADD --> UPD[updateSummary<br/>Increment heuristic counters]
        ADD --> TRIM[trimSpans<br/>Drop spans older than 5 min]
        ADD --> CB[Fire onUpdate callbacks]

        CB --> WRITE[Summarize → enqueue to DatabaseWriter]
        CB --> SID_CB[SidebarPanel<br/>300ms debounce + 5s heartbeat]
        CB --> DSH_CB[DashboardPanel<br/>300ms debounce + 10s heartbeat]
    end

    subgraph LOGS["Log file / database path (disk) — see §4"]
        LF["~/.claude · ~/.codex · ~/.copilot<br/>JSONL files<br/>~/.local/share/opencode/opencode.db (SQLite)"] --> LR[LogReader<br/>parseFile / scanOpenCode / scan]
        LR -- "enqueue(card)" --> WRITE
    end

    WRITE --> SQLITE[(SQLite<br/>sessions + timeline_entries<br/>+ edit_details + blobs/)]
    WRITE --> SIG[last-write.json]

    DSH_CB --> DSH_U[dashboard.update<br/>repo.listSessions + queryDailyStats<br/>+ queryBurnRate → postMessage]
```

---

## 4. Local Log Ingestion

A parallel, network-free ingestion path that reads session files written to disk by each agent. Implemented in `src/logReader.ts` (`LogReader` class).

### File locations

| Agent | Format | Default path | Env override |
| --- | --- | --- | --- |
| Claude Code | JSONL (append log) | `~/.claude/projects/<project>/<uuid>.jsonl` | `CLAUDE_CONFIG_DIR` (comma-separated config dirs) |
| Codex | JSONL (append log) | `~/.codex/sessions/<project>/<uuid>.jsonl` | `CODEX_HOME` (comma-separated home dirs) |
| Copilot CLI | JSONL (event log) | `~/.copilot/session-state/<uuid>/events.jsonl` | — (written automatically) |
| Copilot Chat (VS Code-family, newer) | JSONL (delta log) | `workspaceStorage/<hash>/chatSessions/<uuid>.jsonl` | — |
| Copilot Chat (VS Code-family, older) | JSON (snapshot) | `workspaceStorage/<hash>/chatSessions/<uuid>.json` | — |
| OpenCode | SQLite database (WAL mode) | `~/.local/share/opencode/opencode.db` (Linux/Mac) | `OPENCODE_DATA_DIR` (comma-separated data dirs) |

`workspaceStorage` is at `~/Library/Application Support/<IDE>/User/workspaceStorage` (macOS), `%APPDATA%\<IDE>\User\workspaceStorage` (Windows), or `$XDG_CONFIG_HOME/<IDE>/User/workspaceStorage` (Linux), where `<IDE>` is any VS Code-family IDE. AgentLens scans all known VS Code-family IDEs automatically — VS Code, VS Code Insiders, Cursor, Windsurf, VSCodium, Trae, and Kiro — via `VSCODE_FAMILY_IDE_NAMES` in `src/vscodeFamilyIdes.ts`. Standalone auto-config writes Copilot settings into every installed IDE's `settings.json`. Windows: Claude Code also checks `%APPDATA%\Claude\projects`. Linux/Mac: `XDG_CONFIG_HOME` is also checked for Claude.

### Copilot Chat — delta log format (`.jsonl`)

VS Code writes one JSONL per session where each line is an operation on the session state object:

| `kind` | Meaning |
| --- | --- |
| `0` | Initial session snapshot (`creationDate`, `sessionId`, `inputState.selectedModel`) |
| `1` | Set — `k` is key path, `v` is new value (e.g. `["requests", N, "completionTokens"]`) |
| `2` | Push — `k` is key path, `v` is array of items to append |

New turn: `kind=2` with `k=["requests"]` (exactly one element). Response sub-arrays (`k=["requests", N, "response"]`) are ignored. `completionTokens` arrives via kind=1 (streaming final) and optionally embedded in the kind=2 request push object (Format B); kind=1 always wins.

### Copilot Chat — snapshot format (`.json`)

Older VS Code Copilot Chat versions wrote the full session state as a single JSON object. The `requests` array contains all turns with `message.text`, `timestamp`, `modelId`, and tool call data. No token counts are stored. Only collected when no `.jsonl` sibling exists for the same session UUID.

### OpenCode — SQLite database

OpenCode stores all session data in a local SQLite database (`opencode.db`) using WAL (Write-Ahead Log) mode. AgentLens reads the database directly using `sql.js` (WASM SQLite), merging the WAL file at read time so in-progress sessions are visible immediately.

**WAL merge:** `opencode.db-wal` can be larger than the main database file when sessions are active. `_mergeWal()` parses the 32-byte WAL header (magic, page size, salt pair), iterates frames of size `24 + pageSize`, applies frames whose salt matches the database header, and returns a merged in-memory buffer for `sql.js` to open. The WAL mtime is checked alongside the database mtime so new sessions trigger a rescan.

**Three-query parse:** `_parseOpenCodeDb()` executes three queries in one pass:

1. **Session query** — `session` table: `id, title, directory, model, time_created, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write`. Filters: `parent_id` null/empty (skip sub-sessions), total tokens > 0. Model is stored as JSON (`{"id":"...", "providerID":"..."}`); the `id` field is extracted.
2. **Message query** — `message` table joined on `session_id`: per-assistant-turn timing (`time.created`, `time.completed` from the `data` JSON) and token counts.
3. **Part query** — `part` table joined with `message`: `type` (text / tool / step-start / step-finish / reasoning), `text`, `tool_name`, `callID`, `tool_input_json`, `tool_output`, `tool_status`, and timestamps. Results are grouped per session into `partsBySess` for card building.

**User request:** The last `text`-type part with `role=user` is used as `userRequest` (not the first) to capture the most recent user message in multi-turn sessions.

**Timeline:** `llmEvents` (one per assistant message, from the message query) and `toolEvents` (one per tool part, from the part query) are merged and sorted by timestamp into `TimelineEntry[]`.

### Scan mechanics

```mermaid
flowchart TD
    ACT[Extension activate] --> EN{agentLens.enableLogIngestion?}
    EN -- false --> SKIP[Skip log ingestion]
    EN -- true --> IMM[setImmediate — defer off activation stack]
    IMM --> COL[collectFileMeta<br/>Stat all session files → sort newest-first<br/>Build jsonlIds Set per chatSessions dir<br/>to skip .json files with .jsonl siblings]
    COL --> FAST[Fast group — .jsonl + others<br/>batch=10, setTimeout 0 ms between batches]
    COL --> SLOW[Slow group — .json snapshots avg 1.8 MB<br/>batch=2, setTimeout 50 ms between batches]
    FAST --> WRI[DatabaseWriter.enqueue]
    SLOW --> WRI
    WRI --> DB[(SQLite)]
    FAST -- all done --> SIGNAL[writeLastWriteSignal]
    SLOW -- all done --> SIGNAL
    SIGNAL --> TIMER[setInterval 30s → scan]
    TIMER --> INC[scan: re-stat all files<br/>parse only files whose mtime or size changed]
    INC -- cards --> WRI
```

**Incremental reads:** `_readNewLines` / `_readJsonFile` track `{ bytesRead, mtimeMs }` per file in a `Map<string, FileState>`. On each poll only files whose mtime or size has changed are re-parsed — the whole file is re-read each time (not byte-offset) to produce a complete card. `fileState` is not persisted to disk; on extension restart all files are re-scanned once.

**Two-phase startup loading:** the fast group (all non-.json files) runs first and surfaces recent sessions immediately. The slow group (legacy .json snapshots) starts after the fast group finishes, with a 50 ms gap between each 2-file batch to keep the extension host responsive (each ~60 ms parsing window).

### Data availability

| Field | OTLP | Claude / Codex logs | Copilot CLI log | Copilot Chat JSONL | Copilot Chat JSON | OpenCode SQLite |
| --- | --- | --- | --- | --- | --- | --- |
| Session ID, workspace | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Model | ✓ | ✓ | ✓ | ✓ (initial model only) | ✓ (first request) | ✓ |
| Timestamps, duration | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Input tokens | ✓ | ✓ | ✓ (from `session.shutdown`) | ✗ not stored | ✗ not stored | ✓ |
| Output tokens | ✓ | ✓ | ✓ | ✓ (`completionTokens` per turn) | ✗ not stored | ✓ |
| Cache read / write tokens | ✓ | ✓ | ✓ (from `session.shutdown`) | ✗ not stored | ✗ not stored | ✓ |
| User request text | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (last user message) |
| Tool calls (names) | ✓ | ✓ | ✓ | ✗ | ✗ (presence only) | ✓ |
| Tool call inputs / outputs | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ |
| File paths from tools | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| TTFT, per-tool timing | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Streaming speed, loop signals | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Full turn timeline | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ (LLM + tool entries) |

Sessions produced by `LogReader` carry `dataSource: 'log'` on `SessionSummaryCard`; OTLP sessions carry `dataSource: 'otel'`. The UI shows an OTEL/Log source badge on each session row.

When both feeds capture the same session (same sessionId — for Claude the OTEL summarizer keys cards by the transcript UUID carried in the `session.id` span attribute), the winner is decided by `src/feedMergePolicy.ts`: **for Claude sessions the log transcript wins on collision (OTEL is a lossy lower bound — collector-downtime loss plus the rolling summarization window; before the segmented span store, `MAX_SPANS` eviction was a third, since-removed loss mechanism); OTEL wins only where no transcript exists.** Every other source keeps the original OTEL-wins rule.

**Provenance stamps (P7).** The merge decision is recorded on the card itself: `feedMergePolicy.ts` stamps `tokensSource: 'log' | 'otel' | 'merged'` (which feed backs the served token/cost figures) and, on the outcomes that displaced or absorbed a twin, a human-readable `coverageNote` (e.g. the log-wins note that the colliding OTEL card was displaced). Stamps are applied at the decision points — the standalone merge, the repository merge/dedup, and identity-dedup absorption — so the provenance always matches the doctrine that picked the numbers, and they are re-stamped on every merge pass (self-correcting, never stale). A `null` `tokensSource` means a pre-P7 card: rendered as "unknown", never guessed.

### Bypasses SessionStore / SpanSummarizer

`LogReader` produces `SessionSummaryCard` objects directly (via `_buildCard`) and writes them straight to `DatabaseWriter`. The OTLP path's `SessionStore` and `SpanSummarizer` are not involved.

---

## 5. OTLP Collector

A minimal HTTP/1.1 server (Node `http` module) that handles three routes and maintains stateful session reconstruction for Codex.

```mermaid
graph LR
    subgraph HTTP Routes
        R1["GET /agentlens/plugin<br/>→ {agentlens:true, kind:'plugin'}"]
        R2["POST /v1/traces<br/>max body: 50 MB"]
        R3["POST /v1/logs<br/>max body: 50 MB"]
        R4["POST /v1/metrics"]
    end

    subgraph Codex Session State
        S1[codexFallbackTraceId<br/>resets after 30s inactivity]
        S2[codexSessionByOtelTraceId<br/>OTEL trace → session ID]
        S3[codexCurrentSessionByConversation<br/>conversation ID → active session]
        S4[codexSessionRootByTrace<br/>trace ID → root span]
    end

    subgraph Span Output
        SP[Span<br/>traceId · spanId · parentSpanId<br/>name · startTime · endTime<br/>attributes · status]
    end

    R2 --> PT[parseTraces<br/>resourceSpans→spans]
    R3 --> PL[parseLogs<br/>logRecords→spans]

    PT -- Codex spans --> S1
    PT -- Codex spans --> S2
    PT -- Codex spans --> S3
    PL -- codex.user_prompt --> S3
    PL -- non-prompt events --> S4

    PT --> SP
    PL --> SP
```

**Key non-obvious behaviour:** Codex session IDs (`codex:{conversationId}:prompt-N`, an ordinal per prompt cycle, or `codex:{conversationId}:{turnId}` when a turn id is present) are assigned on arrival. Once set, the mapping is immutable even if spans arrive out of order or are retried.

This per-prompt grouping lives **once** in `src/codexSessionNormalizer.ts` (`CodexSessionNormalizer` — it owns `codexSessionByOtelTraceId`, `codexCurrentSessionByConversation`, the per-conversation prompt ordinal, and the resolve logic). All three OTLP-log ingest paths share it: `otlpParser.parseLogPayload` constructs one per call (state scoped to a payload), while `OtlpCollector` and the standalone server's `processLogs` each hold one long-lived instance so the grouping persists across payloads. Before this consolidation the shipped standalone path had drifted to group Codex by conversation id alone. The downstream summarizer (`summarizers/codex.ts` `groupCodexSpansBySession`) independently re-derives the same per-prompt grouping from stored spans, so it is the store key, not the summarized view, that this normalizer keeps consistent.

**gen_ai response content (Codex/OpenAI).** The `gen_ai_latest_experimental` instrumentation does not put the assistant's reply on the LLM span — it emits it as a separate `gen_ai.choice` / `gen_ai.assistant.message` **log event** correlated to the span by `traceId:spanId`, arriving on a different request either before or after the span. `processLogs` formats that event (shared `src/genAiContent.ts` `formatGenAiEventContent` → the `gen_ai.output.messages` shape `extractResponseText` reads) and calls `SegmentedSpanStore.injectSpanAttribute(traceId, spanId, 'gen_ai.output.messages', …)`. That is a **read-time overlay**: the store records the attribute in an in-memory `Map<traceId:spanId, {key:value}>` and merges it into the span when the span is next read via `loadRange` — so ordering does not matter and no persisted NDJSON segment is ever rewritten. The overlay is cap-evicted (oldest-first, 500) and in-memory only (rebuilt from live events, not persisted across restart).

### Standalone span store — segmented, append-only, no eviction

The standalone server persists every received span through `src/segmentedSpanStore.ts`:

```text
~/.agentlens/spans/
├── 2026-07-09.ndjson    # one JSON span per line, bucketed by UTC receive day
├── 2026-07-10.ndjson
└── index.json           # per-segment {count, minTs, maxTs, bytes} — atomic write, self-healing
```

- **Append is O(record).** Spans buffer in memory and the 5-second flush tick appends one chunk per touched segment. A segment file is **never rewritten** — the previous single-file store's rewrite pattern destroyed 420GB of SSD in 4.4 hours, and its shutdown rewrite was the last survivor of that pattern.
- **No span-count cap, no eviction.** The previous store capped at `MAX_SPANS=50,000` and was measured losing 1,700 spans in a single restart (`Loaded 50000 spans (capped from 51700)`). The segmented store keeps everything until retention expires the whole segment.
- **Memory is a time window, not the store.** The in-memory `spans` array holds only the rolling summarization window (`AGENTLENS_SUMMARY_WINDOW_HOURS`, default 24h; under heap pressure it halves down to a 5-minute floor, logged loudly). Boot and any range query load **only the segments overlapping the requested time range** via `loadRange()` — never the whole store.
- **Retention deletes whole expired segments only** (`AGENTLENS_SPANS_RETENTION_DAYS`, default 30), on boot + daily, one explicit log line per deletion: `retention: deleted segment 2026-06-01.ndjson, N spans, age 39d`. Nothing is ever dropped silently.
- **Retention is persistently configurable** (`src/retentionConfig.ts`, TRDD-ZAV74M8Q). The five retention knobs (spans/summary/bodies) resolve at boot with the precedence **env var > `DATA_DIR/config.json` > built-in default**, each min-floored. `config.json` lives in `DATA_DIR`, so a value set once survives an uninstall/upgrade/CLI-path-change and the always-on daemon (which a shell `export` can't reach) re-reads it every boot. `agentlenspro config [list|get|set]` inspects/persists them; a `set` on a corrupt config file refuses to write rather than clobbering it. A single `RETENTION_META` table is the source of truth both the server and the CLI read.
- **One-time migration.** The first boot splits a legacy `spans.json` (NDJSON or the older whole-array format) into daily segments and renames it to `spans.json.bak` — preserved, never deleted.
- **No native dependencies** (deliberate): better-sqlite3 would give indexed queries but breaks `npx` portability; plain NDJSON + a JSON index stays pure-Node and greppable.

### Always-on, no-loss ingestion + admission control (D3K7QM2P)

Ingestion must keep going whenever any Claude instance is active, lose nothing, and survive 20+
instances (plus subagents) hammering the CLI at once. This is achieved WITHOUT a two-process split —
the ingestion daemon **is** the standalone server, kept always-on by the hooks themselves:

- **JSONL is already loss-less.** Claude/Codex/Copilot write their transcripts to disk themselves;
  `LogReader.scan()` tails them with persisted byte offsets and backfills everything on restart. The
  server being down never loses a transcript.
- **Hook durability (`src/cli/hookHandlers.ts`).** A hook event that can't be delivered — server down,
  or shed under load — is appended to `~/.agentlens/hook-spool/` and a **detached, stampede-locked**
  server revive is fired (`.daemon-revive.lock`, the pidfile guard as backstop). The server drains the
  spool through the same `/api/hook-events` ingest path on boot and on a slow tick, so nothing is lost
  across the revive window. The spool is bounded (oldest-dropped) so a permanently-down server can't
  fill the disk. `AGENTLENS_NO_REVIVE=1` is a spool-only mode for externally-supervised setups.
- **`agentlenspro daemon`** names this role (start/stop/restart/status/install/uninstall); `status`
  shows the spool depth, `install` writes a launchd agent for 24/7 supervision (opt-in).
- **Admission control (`src/resourceMonitor.ts` + `src/admissionController.ts`).** Both HTTP servers
  share one resource monitor (RSS, per-core load, free disk — TTL-cached) and one bounded-concurrency
  controller. Under load it queues overflow briefly (bounded + deadlined, never blocking a caller
  unbounded) and sheds `503 + Retry-After` only at a hard wall. **Shedding is loss-free**: a shed hook
  spools (above), a shed OTLP export is retried by the exporter / backfilled by the next scan, and a
  shed agent-gate fails open (never blocks a launch). `/events` (SSE), `/api/server-stats`, and the
  hook-config kill-switch read are exempt so health + control always answer under load. Limits are
  env-tunable (`AGENTLENS_MAX_INFLIGHT*`, `AGENTLENS_MAX_RSS_MB`, `AGENTLENS_MIN_FREE_DISK_MB`,
  `AGENTLENS_LOADAVG_MAX`, `AGENTLENS_ADMIT_*`) and CPU-scaled; live counters ride `/api/server-stats`.

### Body store — content-addressed, verify-then-delete (TRDD-K3WDPR7M)

Raw OTEL request/response bodies (opt-in capture — `src/captureConfig.ts`,
`agentlenspro config set captureRawBodies on|off`) no longer accumulate as loose JSON files or
feed a gzip archiver. They are ingested into a **content-addressed body store** at
`<dataDir>/store/` (`src/store/db.ts`, `bodyStore.ts`, `ingestPass.ts`):

```text
Claude Code raw body write
  → live bodies dir (plain files: DATA_DIR/otel-bodies, or the RAM-disk spool when capture is on)
  → ingestPass(): sectionize the body into literal + shared-span parts (src/store/sections.ts),
    hash each span (its content IS its address), write new spans + body/part metadata into an
    IN-MEMORY DuckDB instance — never a persistent .duckdb file (see below)
  → flush(): the in-memory tables are written ONCE to immutable, zstd-compressed Parquet parts
    under store/{blobs,bodies,parts}/ and never rewritten
  → VERIFY: reconstructBody() re-reads the body from the flushed, DURABLE Parquet parts and
    compares its sha256 against the original file's bytes
  → only on a proven byte-identical match is the source file deleted
```

**Why fileless DuckDB.** A *persistent* `.duckdb` file rewrites row-groups internally — measured
at 5 MB of device writes for a single 881 KB turn (300× worse than the alternative below). Running
DuckDB `:memory:` and flushing to Parquet parts that are written once and never rewritten avoids
that amplification entirely; `temp_directory` is set to `''` so an over-limit query fails loudly
instead of silently spilling to the SSD mid-query.

**Deduplication.** Because consecutive turns re-send most of the same transcript, spans are
deduplicated by content hash across the whole store (`Store.known`, reloaded from the durable
Parquet parts on boot) — re-ingesting a body that shares spans with an earlier one adds zero new
bytes for those spans. This is most of where the size reduction below comes from, not compression
alone.

**RAM-disk spool (opt-in capture only, macOS).** When raw-body capture is on, the *write itself*
is the SSD wear the store cannot avoid downstream, so `src/ramdisk.ts` mounts a RAM-disk volume
(`AgentLensSpool`) and Claude Code's `OTEL_LOG_RAW_API_BODIES` is pointed at it instead of a real
path — the live bodies dir the pipeline above drains is then volatile memory, not disk. A
boot-time LaunchAgent (`agentlenspro spool ensure`, `src/cli/spoolLaunchAgent.ts`) re-creates the
spool at login, since a reboot destroys the RAM disk but Claude Code reads the env var only at
launch; the drain runs every 60s in spool mode (vs. hourly otherwise) with an emergency cap so a
runaway producer cannot fill volatile memory.

**Legacy `.wad` archive — read-only fallback, not the current write path.** Before this store, an
hourly archiver pass gzip-packed each body into a monthly `.wad` volume (`src/bodyArchive.ts`)
with no cross-body dedup — the identical ~268 KB `tools` array was stored again every single turn.
That archiving behavior is retired (the same periodic pass now ingests into the content-addressed
store instead), but existing `.wad` volumes are **never deleted automatically** — reclaiming them
is a separate, explicit decision — and remain readable: `src/store/migrateArchive.ts` drains a
`.wad` volume into the content-addressed store the same verify-then-delete way, and
`/api/bodies/export` (`exportBodiesFromStore` in `src/store/bodyStore.ts`) reads from **both** the
store and the `.wad` archive so an export never silently misses a body that has already been
reclaimed from the live directory.

Measured on this project's own captured history: ~52 GB of raw bodies (live capture plus the
drained legacy archive) compressed to ~270 MB of Parquet on disk (~190×), with every body verified
byte-identical at ingest time — full-corpus validation was still in progress at the time of
writing (`reports/storage-migration/20260715_003054+0200-backfill-and-drain.md`). A smaller,
independently-run dry run separately measured 167× (4.00 GB → 24 MB, 7,439/7,439 bodies
verified).

### Delta-log persistence for session/offset state (TRDD-K3WDPR7M)

`log-sessions.json` and `log-offsets.json` were previously rewritten **in full** on every save —
measured at ~9.4 MB/min of device writes combined, regardless of how many records actually
changed. `src/store/deltaLog.ts`'s `DeltaLog<T>` replaces the whole-file rewrite with a
`<name>.snapshot.ndjson` + `<name>.delta.ndjson` pair: each save hashes every record's serialized
form and appends **only** the records that changed (plus tombstones for records that disappeared)
to the delta file — a save where nothing changed now writes zero bytes. The delta log is
periodically compacted back into a fresh snapshot once it grows past the snapshot's own size
(bounding replay cost on load), and a crash mid-append can only lose a torn trailing line, which
`load()` drops on the next read — the record it belonged to is simply re-derived and re-appended
on the next save.

---

## 6. Session Summarizer

`summarizeSpans()` is called on the live rolling span window (last 5 minutes). It groups raw spans into agent-session cards and computes cross-session efficiency metrics. Historical sessions are read directly from SQLite; the two sources are merged by `SessionRepository`.

```mermaid
flowchart TD
    IN["spans: Span[]"] --> GRP[Group spans by traceId<br/>Build parentSpanId → children map]

    GRP --> CP_FIND[Find invoke_agent spans<br/>Copilot roots]
    GRP --> CC_FIND[Find claude_code.interaction spans<br/>Claude roots]
    GRP --> CX_FIND[Group by codex session ID<br/>Codex roots]

    CP_FIND --> CP_SYN{Missing parents?}
    CP_SYN -- yes --> CP_SYNTH[Synthesise invoke_agent root<br/>for orphan spans]
    CP_SYN -- no --> CP_B
    CP_SYNTH --> CP_B[buildCopilotSessions]

    CC_FIND --> CC_SYN{Missing interaction?}
    CC_SYN -- yes --> CC_SYNTH[Synthesise claude_code.interaction]
    CC_SYN -- no --> CC_B
    CC_SYNTH --> CC_B[buildClaudeSessions]

    CX_FIND --> CX_B[buildCodexSessions]

    CP_B --> SESSIONS["SessionSummaryCard[]"]
    CC_B --> SESSIONS
    CX_B --> SESSIONS

    SESSIONS --> LOOP[detectLoopSignals<br/>per session]
    SESSIONS --> BG[Background spans<br/>orphans not in any session]
    SESSIONS --> EFF[EfficiencyReport<br/>token totals · TTFT · cache hit rate]

    LOOP --> OUT[FullSummary]
    BG --> OUT
    EFF --> OUT
```

---

## 7. Per-Agent Summarizers

Each agent uses a different span structure. The summarizers normalise these into a common `SessionSummaryCard`.

```mermaid
graph TB
    subgraph copilot["Copilot - buildCopilotSessions"]
        CP_ROOT[invoke_agent span<br/>root of session]
        CP_LLM[chat gpt-4.1 span<br/>type: llm<br/>tokens · model · TTFT<br/>output messages JSON]
        CP_TOOL[execute_tool span<br/>type: tool<br/>gen_ai.tool.name<br/>gen_ai.tool.call.arguments]
        CP_ROOT --> CP_LLM
        CP_ROOT --> CP_TOOL
    end

    subgraph claude["Claude - buildClaudeSessions"]
        CC_ROOT[claude_code.interaction<br/>root - may be synthetic]
        CC_LLM[claude_code.llm_request<br/>type: llm<br/>input/output/cache tokens<br/>ttft_ms · stop_reason]
        CC_TOOL[claude_code.tool<br/>type: tool<br/>tool_name · file_path]
        CC_ROOT --> CC_LLM
        CC_ROOT --> CC_TOOL
    end

    subgraph codex["Codex - buildCodexSessions"]
        CX_PROMPT[codex.user_prompt<br/>session boundary]
        CX_LLM[codex.sse_event / codex.completion<br/>type: llm · token counts]
        CX_TOOL[exec_command / apply_patch<br/>type: tool]
        CX_PROMPT --> CX_LLM
        CX_PROMPT --> CX_TOOL
    end

    CP_ROOT & CC_ROOT & CX_PROMPT --> CARD["SessionSummaryCard<br/>source · model · turns<br/>workspace · projectPath?<br/>tokens · cacheHitRate<br/>timeline: TimelineEntry[]<br/>filesRead/Changed/Searched<br/>toolCounts · errors · outcome"]
```

---

## 8. SQLite Storage Layer

Introduced in phases 1–4. The database is the authoritative source for all historical session data. The live 5-minute span window supplements it for in-progress sessions.

### Schema

```mermaid
erDiagram
    sessions {
        TEXT session_id PK
        TEXT trace_id
        TEXT source
        TEXT workspace
        TEXT project_path
        TEXT model
        INTEGER start_time
        INTEGER duration_ms
        INTEGER turns
        INTEGER input_tokens
        INTEGER output_tokens
        INTEGER cache_read_tokens
        INTEGER cache_create_tokens
        REAL cache_hit_rate
        INTEGER total_tool_calls
        INTEGER total_llm_calls
        INTEGER errors
        TEXT outcome
        INTEGER is_sidechain
        TEXT user_request
        TEXT tool_counts
        TEXT loop_signals
        TEXT files_read
        TEXT files_changed
        TEXT files_searched
        REAL cost_usd
    }
    timeline_entries {
        INTEGER id PK
        TEXT session_id FK
        TEXT span_id
        INTEGER position
        TEXT type
        TEXT label
        TEXT model
        INTEGER input_tokens
        INTEGER output_tokens
        INTEGER ttft
        INTEGER duration_ms
        TEXT action
        TEXT decision
        INTEGER is_error
        TEXT error_message
        TEXT timestamp
        INTEGER has_blob
    }
    edit_details {
        INTEGER id PK
        INTEGER timeline_entry_id FK
        TEXT file_path
        TEXT tool_name
        INTEGER has_blob
    }
    sessions ||--o{ timeline_entries : "has"
    timeline_entries ||--o{ edit_details : "has"
```

Large string fields (`responseText`, `thinking`, `toolInput`, `fullResult`, `oldString`, `newString`) above 512 bytes are stored as files at `globalStorageUri/blobs/<spanId>-<field>.txt` rather than inline in the DB. The `has_blob` flag indicates when to read from disk instead.

### Component responsibilities

```mermaid
graph TD
    subgraph srcdb["src/database/"]
        SCH[schema.ts<br/>SCHEMA_SQL - CREATE TABLE statements]
        DBT[db.ts<br/>AgentLensDb - opens DB, applies<br/>schema + migrations, save/dispose]
        WRI[writer.ts<br/>DatabaseWriter - enqueue/drain/clearAll<br/>Computes cost_usd at write time]
        REA[reader.ts<br/>DatabaseReader - listSessions<br/>queryDailyStats · queryLifetimeStats<br/>searchSessions · queryBurnRate<br/>loadSessionTimeline · loadBlob]
        MIG[migration.ts<br/>migrateGlobalStateToSqlite<br/>One-time globalState to SQLite]
        RET[retention.ts<br/>runRetention - DELETE old sessions<br/>Evict orphaned blob files]
    end

    subgraph srcroot["src/"]
        PRI[pricing.ts<br/>lookupRates · calcTokenCostUsd<br/>contextWindowTokens per model]
        REPO[sessionRepository.ts<br/>SessionRepository<br/>Merges DB + live window<br/>Single access point for session data]
    end

    DBT -- raw SqlDatabase --> WRI
    DBT -- raw SqlDatabase --> REA
    PRI --> WRI
    PRI --> REA
    WRI --> REPO
    REA --> REPO
    SCH --> DBT
    MIG --> REPO
    RET --> REPO
```

### Data flow: write path

```mermaid
sequenceDiagram
    participant STO as SessionStore
    participant SUM as summarizeSpans
    participant WRI as DatabaseWriter
    participant DB as SQLite
    participant BLB as blobs/ dir
    participant SIG as last-write.json

    STO->>SUM: getSpans() on each onUpdate
    SUM->>WRI: enqueue(SessionSummaryCard, workspace)
    WRI->>DB: BEGIN transaction
    WRI->>DB: INSERT OR REPLACE INTO sessions (incl. cost_usd)
    WRI->>DB: DELETE old timeline_entries for session
    WRI->>DB: INSERT timeline_entries + edit_details
    WRI->>DB: COMMIT
    WRI->>BLB: write blob files async (if content ≥ 512 bytes)
    WRI->>SIG: db.save() + write lastWriteMs
```

### Data flow: read path

```mermaid
sequenceDiagram
    participant DASH as DashboardPanel
    participant REPO as SessionRepository
    participant REA as DatabaseReader
    participant DB as SQLite
    participant STO as SessionStore
    participant WV as Webview

    DASH->>REPO: listSessions()
    REPO->>REA: listSessions() — historical from DB
    REPO->>STO: getSpans() → summarizeSpans() — live window
    REPO-->>DASH: merged + sorted SessionSummaryCard[]

    DASH->>REPO: queryDailyStats({ since: 30d })
    DASH->>REPO: queryLifetimeStats()
    DASH->>REPO: queryBurnRate(activeSessionId)
    REA->>DB: SELECT with aggregates / JOIN
    REA-->>DASH: DailyStatRow[] / LifetimeStats / BurnRate + Projection

    DASH->>WV: postMessage { type:'update', sessionSummary,<br/>analyticsData, burnRate }

    WV->>DASH: postMessage { type:'loadSessionDetail', sessionId }
    DASH->>REPO: loadSessionTimeline(sessionId)
    REA->>DB: SELECT timeline_entries + edit_details
    DASH->>WV: postMessage { type:'sessionDetail', timeline }

    WV->>DASH: postMessage { type:'loadBlob', spanId, field }
    DASH->>REPO: loadBlob(spanId, field)
    REA->>BLB: readFile
    DASH->>WV: postMessage { type:'blobContent', content }

    WV->>DASH: postMessage { type:'searchSessions', query }
    DASH->>REPO: searchSessions(query)
    REA->>DB: SELECT + COUNT with WHERE/ORDER/LIMIT
    DASH->>WV: postMessage { type:'searchResults', sessions, totalCount }
```

### Cross-window sync

When two VS Code windows are open and one holds the OTLP collector (port 4318), the other cannot collect spans. The non-collector window polls `last-write.json` every 2 seconds and reloads a fresh DB snapshot via `openReadonlySnapshot()` when the timestamp advances.

### Storage management

`agentLens.sessionRetentionDays` (default 90) controls how long sessions are kept. `runRetention` is called at activation and every 24 hours. After deleting old rows it scans `blobs/` and removes any file whose span ID is no longer in `timeline_entries`.

`agentLens.showStorageStats` reports DB file size, blob directory size, session count, and date range to the Output channel.

---

## 9. Session Data Model

```mermaid
classDiagram
    class SessionSummaryCard {
        +sessionId: string
        +traceId: string
        +source: copilot, claude_code, codex
        +dataSource: otel, log
        +conversationId?: string
        +workspace: string
        +projectPath?: string
        +userRequest: string
        +model: string
        +turns: number
        +inputTokens: number
        +outputTokens: number
        +cacheReadTokens: number
        +cacheCreateTokens: number
        +cacheHitRate: number
        +durationMs: number
        +startTime: string
        +filesRead: string[]
        +filesChanged: string[]
        +filesSearched: string[]
        +toolCounts: Record~string,number~
        +totalToolCalls: number
        +totalLlmCalls: number
        +errors: number
        +outcome: string
        +timeline: TimelineEntry[]
        +backgroundSpans: BackgroundSpanSummary[]
        +loopSignals: LoopSignal[]
    }

    class TimelineEntry {
        +type: llm, tool, background
        +spanId: string
        +label: string
        +model?: string
        +inputTokens?: number
        +outputTokens?: number
        +ttft?: number
        +durationMs: number
        +action?: string
        +responseText?: string
        +toolInput?: string
        +decision?: string
        +isError: boolean
        +timestamp: string
        +editDetails?: EditDetail[]
    }

    class EditDetail {
        +filePath: string
        +oldString?: string
        +newString?: string
        +content?: string
        +toolName?: string
    }

    class DailyStatRow {
        +day: string
        +totalTokens: number
        +cacheReadTokens: number
        +cacheCreateTokens: number
        +outputTokens: number
        +costUsd: number
        +sessionCount: number
    }

    class BurnRate {
        +tokensPerMinute: number
        +costPerHour: number
    }

    class Projection {
        +totalTokens: number
        +totalCostUsd: number
        +remainingMinutes: number
        +contextFillPct: number
    }

    SessionSummaryCard "1" *-- "many" TimelineEntry
    TimelineEntry "1" *-- "many" EditDetail
    BurnRate "1" -- "0..1" Projection : paired with
```

**Lazy timeline loading:** `SessionSummaryCard.timeline` is always `[]` when read from SQLite. The webview requests individual timelines on demand via `loadSessionDetail`. Blob fields (`responseText`, `thinking`, etc.) are further deferred until the user expands an entry (`loadBlob`).

---

## 10. Frontend Architecture

The dashboard is a Preact application bundled into `media/dashboard.js`. It uses `@preact/signals` for reactive state — no Redux, no Context, no prop drilling.

### Signal graph

```mermaid
graph TD
    subgraph coredata["Core data - set by DashboardPanel"]
        SIG_SUM[sessionSummary<br/>FullSummary or null]
        SIG_TOOLS[toolCalls<br/>Record of string to number]
        SIG_TL[sessionTimelines<br/>sessionId to TimelineEntry array]
        SIG_BLOB[blobCache<br/>spanId:field to string]
        SIG_DS[dailyStats<br/>DailyStatRow array]
        SIG_LS[lifetimeStats<br/>LifetimeStats or null]
        SIG_BR[burnRateData<br/>BurnRateData or null]
        SIG_SR[searchResults<br/>SearchResultData or null]
        SIG_RSR[rangedSearchResults<br/>DB results for active time range]
    end

    subgraph uicontrols["UI controls"]
        SIG_LIM[sessionLimit<br/>number, default 10]
        SIG_AGT[selectedAgentFilter<br/>AgentFilter, default all]
        SIG_WS[workspaceFilter<br/>WorkspaceFilter, default all]
        SIG_TAB[activeTab<br/>string, default sessions]
        SIG_TF[sessionTextFilter<br/>string]
        SIG_SK[sessionSortKey<br/>start_time · total_tokens · duration_ms<br/>errors · prompt · model · source · cost]
        SIG_SD[sessionSortDir<br/>asc or desc]
        SIG_TR[timeRange<br/>preset + optional since/until]
        SIG_INF[insightFilter<br/>all · loop · efficiency]
        SIG_IGN[ignoredInsightKeys<br/>Set of string]
    end

    subgraph Computed
        COMP_AF[agentFilteredSessions<br/>computed — filter by source + workspace]
        COMP_AWS[availableWorkspaces<br/>computed — unique workspace paths]
        COMP_DISP[displaySessions<br/>computed — last N sessions]
        COMP_RS[rangedSessions<br/>computed — time range + DB merge]
        COMP_FS[filteredSessions<br/>computed — text filter + sort]
        COMP_PRES[agentPresence<br/>computed — which agents active]
    end

    SIG_SUM --> COMP_AF
    SIG_AGT --> COMP_AF
    SIG_WS --> COMP_AF
    SIG_SUM --> COMP_AWS
    COMP_AF --> COMP_DISP
    SIG_LIM --> COMP_DISP
    COMP_AF --> COMP_RS
    SIG_TR --> COMP_RS
    SIG_RSR --> COMP_RS
    COMP_RS --> COMP_FS
    SIG_TF --> COMP_FS
    SIG_SK --> COMP_FS
    SIG_SD --> COMP_FS
    COMP_RS --> COMP_PRES

    COMP_FS --> TAB_COMPS[Tab components]
    COMP_DISP --> TAB_COMPS
    SIG_TL --> TAB_COMPS
    SIG_BLOB --> TAB_COMPS
    SIG_DS --> TAB_COMPS
    SIG_LS --> TAB_COMPS
    SIG_BR --> TAB_COMPS
    SIG_SR --> TAB_COMPS
    SIG_TAB --> TAB_COMPS
```

**Key computed signal semantics:**

- `agentFilteredSessions` — all in-memory sessions filtered by agent pill, data source, and workspace dropdown. No limit applied. This is the root filter — all downstream computeds derive from it, so the workspace filter automatically scopes every tab.
- `availableWorkspaces` — sorted list of unique workspace paths from all loaded sessions. Drives the workspace dropdown options.
- `displaySessions` — `agentFilteredSessions` sliced to `sessionLimit` (most recent N). Used for the Sessions table.
- `rangedSessions` — for bounded presets (7d/30d/…): merges `rangedSearchResults` (DB) with in-memory sessions that fall in the window. For "All": returns `agentFilteredSessions` directly.
- `filteredSessions` — `rangedSessions` with text filter and sort applied. Used by Sessions table, Insights, and Efficiency charts within Analytics. Analytics charts that must stay time-ordered (ESTIMATED COST, TOKEN USAGE PER SESSION, CONTEXT GROWTH) source from `rangedSessions` directly.

**Workspace field flow:** `workspace` is stored in the `sessions` SQLite table (always present, `NOT NULL`). `project_path` is an optional secondary path some OTEL exporters populate. Both are mapped by `DatabaseReader.listSessions` into `SessionSummaryCard`. For OTEL-sourced sessions, `workspace` is stamped onto the card by `DatabaseWriter.enqueue` (the summarizers produce `workspace: ''` as a placeholder). For log-sourced sessions, `_buildCard` receives and records the workspace at parse time.

### Tab component overview

Six flat top-level tabs; secondary views are sub-panels within the expanded session row or the Analytics layout.

```mermaid
graph LR
    APP[App.tsx<br/>sticky tab bar · time range picker<br/>agent filter pills · text filter] --> T1

    T1[Sessions<br/>sortable table — all columns<br/>OTEL/Log source badge per row<br/>expand-in-place detail panel]
    T1 --> D1[Overview sub-tab<br/>stat tiles · burn rate · InsightCards]
    T1 --> D2[Trace sub-tab<br/>waterfall — LLM calls + tool calls<br/>lazy timeline · blob expand]
    T1 --> D3[Flow sub-tab<br/>turn-to-tool semantic graph<br/>canvas · lazy timelines]
    T1 --> D4[Tools sub-tab<br/>donut chart + call table]
    T1 --> D5[Files sub-tab<br/>files changed list · open in editor]

    T2[Analytics<br/>ESTIMATED COST · AGENT BREAKDOWN<br/>TOKEN USAGE PER SESSION · CONTEXT GROWTH]
    T2 --> A1[CostBarChart — per-session bars<br/>daily total overlay · pricing mode toggle<br/>CSV export download button]
    T2 --> A2[AgentCard ×3 — per-agent stat tiles]
    T2 --> A3[SessionTokenChart — input/output bars<br/>day boundary highlights]
    T2 --> A4[ContextGrowthChart — animated<br/>per-session spotlight · play/pause/speed]

    T3[Alerts<br/>configurable threshold alerts<br/>VS Code notification with View Alerts + Copy Prompt]
    T4[Automation<br/>loop breaker · turn wrap-up<br/>error cascade · context compaction]
    T5[Export<br/>full or redacted JSON export]
    T6[Help<br/>sticky TOC nav · glossary · OTEL setup]
```

**Chart data isolation:** Analytics charts (`CostBarChart`, `SessionTokenChart`, `ContextGrowthChart`) source from `rangedSessions` (always newest-first by time) so the Sessions table sort key has no effect on their order.

### DashboardPanel ↔ Webview message protocol

```mermaid
sequenceDiagram
    participant EXT as DashboardPanel (Node)
    participant WV  as Webview (Preact)

    Note over EXT,WV: Initial load
    EXT->>WV: HTML with window.__INITIAL_SESSION_SUMMARY__<br/>window.__INITIAL_TOOL_CALLS__

    Note over EXT,WV: Live updates (onUpdate + 10s heartbeat)
    EXT->>WV: {type:'update', summary, sessionSummary,<br/>analyticsData:{dailyStats,lifetimeStats},<br/>burnRate:{sessionId,burnRate,projection}}

    Note over EXT,WV: Lazy timeline loading
    WV->>EXT: {type:'loadSessionDetail', sessionId}
    EXT->>WV: {type:'sessionDetail', sessionId, timeline}

    Note over EXT,WV: Lazy blob loading
    WV->>EXT: {type:'loadBlob', spanId, field, editIndex?}
    EXT->>WV: {type:'blobContent', spanId, field, content}

    Note over EXT,WV: Session search
    WV->>EXT: {type:'searchSessions', query:SearchQuery}
    EXT->>WV: {type:'searchResults', sessions, totalCount, offset}

    Note over EXT,WV: UI actions
    WV->>EXT: {type:'clearAll'}
    WV->>EXT: {type:'askAI', prompt, agent}
    WV->>EXT: {type:'openFile', filePath}
    WV->>EXT: {type:'exportSessionData'}
    WV->>EXT: {type:'openSidebar' | 'closeSidebar'}
    WV->>EXT: {type:'automation', automationId, agent, prompt, ...}
    WV->>EXT: {type:'alert', label, detail, severity}
    Note over EXT: showWarning/Error/InformationMessage<br/>with 'View Alerts' + 'Copy Prompt' buttons<br/>Copy Prompt writes AI-ready text to clipboard
```

### Copy-branch export (⧉ tree) + `/api/branch-dump`

The Sessions detail section bar, each sub-agent branch (`SubAgentBranch`), and the Flow view carry a
`CopyBranchButton` (`media/src/CopyBranchButton.tsx`) that serializes a whole branch to a
self-describing text tree via the runtime-neutral `src/shared/branchSerialize.ts` (the same pure
module the mocha suite tests — one source of truth, imported by the webview). It materializes lazy
descendants with the existing `loadSessionDetail` / `loadBlob` messages, stamps a session-id +
project-slug header and a per-node OTEL match key `⟨span=… req=… trace=…⟩`, and offloads any body over
~8 KB to `POST /api/branch-dump` — a localhost-only writer confined to
`~/.claude/projects/<slug>/agentlens-branch-dumps/` (the slug must name a real project dir;
single-segment filename; resolved-parent containment check; inherits the uiServer CSRF + admission
guards). If the endpoint is unavailable the button inlines an honest "omitted" marker so a copy never
fails.

---

## 11. Cost Calculation

ONE rate table — `src/shared/pricing.ts` — serves both runtimes (it replaced the two hand-synced
copies that used to live in `src/pricing.ts` and `media/src/pricing.ts` and had drifted apart):

1. **Host / standalone server** — at write time via `calcTokenCostUsd` (per-call, applies the >200K
   tiered surcharge); `cost_usd` is stored in the `sessions` row and used for all aggregate queries
   (`SUM(cost_usd)`, `queryDailyStats`, `queryBurnRate`).
2. **Browser** — at display time via `calcTokenCost` (flat rates over session totals — per-call sizes
   cannot be reconstructed there); per-turn cost shown in the Cost tab and Flow tooltip. Request-mode
   billing (`PricingMode` 'request' / 'request-annual') is computed in `media/src/sessionMetrics.ts`
   as `turns × multiplier × $0.04`, with the multipliers coming from the same shared `ModelRates`.

```mermaid
flowchart TD
    subgraph exthost["Host / standalone - write time"]
        CARD[SessionSummaryCard] --> PRI_EXT[src/shared/pricing.ts<br/>calcTokenCostUsd]
        PRI_EXT --> DB_COST[sessions.cost_usd<br/>stored in SQLite]
    end

    subgraph browser["Browser - display time"]
        ENTRY[TimelineEntry<br/>model · tokens] --> LR[lookupRates<br/>normalise + prefix match]
        LR --> RATES{Rates found?}
        RATES -- no  --> ZERO[cost=0, modelUnknown=true]
        RATES -- yes --> MODE{PricingMode}
        MODE -- token --> TC[src/shared/pricing.ts calcTokenCost<br/>input/cacheRead/cacheWrite/output<br/>per-MTok rate / 1,000,000]
        MODE -- request-annual --> RA[sessionMetrics.ts request math<br/>turns x multiplierAnnualPostJun1 x $0.04<br/>annual-plan holders post-Jun 2026]
        MODE -- request --> RC[sessionMetrics.ts request math — DEPRECATED<br/>turns x multiplier x $0.04<br/>pre-Jun 2026 billing only]
        TC --> ENTRY_COST[calcEntryCost - Flow tooltip]
        TC --> SESS_COST[calcSessionCost - Cost tab table]
        RC --> SESS_COST
        RA --> SESS_COST
    end

    subgraph analytics["Analytics - query time"]
        DB_COST --> AGG[queryDailyStats<br/>SUM cost_usd GROUP BY day]
        DB_COST --> LIFE[queryLifetimeStats<br/>SUM cost_usd]
        DB_COST --> BURN[queryBurnRate<br/>tokensPerMinute x costPerToken x 60]
    end
```

`contextWindowTokens` (stored in `src/shared/pricing.ts`) enables the `Projection` calculation: given current session token usage and burn rate, estimate time to context exhaustion and final cost.

Pricing data covers: OpenAI (GPT-4.1 through GPT-5.5), Anthropic (Claude Haiku/Sonnet/Opus 4.x), Google (Gemini 2.5–3.5), Codex, and fine-tuned models. Last updated: 2026-05-28.

### Keep-warm / cache-gap diagnostic (P6)

`src/shared/keepWarm.ts` (runtime-neutral — imported by the host and the webview) measures the cost of letting the Anthropic prompt cache expire between turns. The cache TTL is NOT a fixed 5 minutes — it is resolved per session from the regime matrix in `src/shared/cacheTtl.ts` (TRDD-VY1IUVUM): a subscription MAIN session rides a **1-hour** tier, a subagent/usage-credits/API session **5 min**, a fork inherits its parent; env overrides (`FORCE_PROMPT_CACHING_5M`/`ENABLE_PROMPT_CACHING_1H`) win, and every number carries a `ttlSource` (`doc-matrix`/`config`/`measured`/`assumed`). `computeKeepWarm(timeline, regime)` takes that resolved `TtlRegime` and classifies against its `regime.ttlMs` (the old global `CACHE_TTL_MS` constant is gone — a fixed 5-min assumption mis-flagged warm 20-min gaps on subscription mains as cold). A turn that lands past the resolved TTL re-pays the full prefix at the cache-WRITE rate (1.25×) instead of reading it at 0.1× — a 12.5× difference on the dominant bucket, invisible in per-turn totals. `computeKeepWarm` classifies each consecutive `claude_code.api_request` pair: gap < `ttlMs` → WARM turn; gap ≥ `ttlMs` with a re-write signature (`cacheCreate > cacheRead`) → COLD turn whose `cache_creation` tokens are the measured waste; gap ≥ `ttlMs` without the signature → counted in neither bucket (no observed penalty — inventing waste would be a lie). The measured falsifier flips `ttlSource` to `measured` when a cache hit lands after the assumed expiry, contradicting the regime. The session's first request is the unavoidable warm-up, excluded by construction; a session with no `api_request` entries returns `null`, never zeros presented as measurements. Consumers: the burn monitor's hot-session decoration and per-session `keepWarm` report (`src/burnMonitor.ts`), the MCP diagnostics tools, and the dashboard badge.

---

## 12. Auto-Configuration

When the standalone server boots as the canonical instance (default OTLP port — a non-default `AGENTLENS_OTLP_PORT` deliberately does NOT touch global agent configs), it attempts to configure each agent automatically (`standalone/server.ts` startup block).

```mermaid
flowchart TD
    ACT[Server boot — canonical instance] --> PAR[Run in parallel]

    PAR --> CC_CFG[ensureTelemetryConfig + ensureAgentLensStopHook<br/>~/.claude/settings.json — via safeConfigEdit]
    PAR --> CX_CFG[autoConfigureCodex<br/>~/.codex/config.toml]
    PAR --> CP_CFG[autoConfigureCopilotStandalone<br/>VS Code-family user settings.json files on disk]

    CC_CFG --> CC_KEYS["env block:<br/>CLAUDE_CODE_ENABLE_TELEMETRY=1<br/>OTEL_TRACES_EXPORTER=otlp<br/>OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:{port}<br/>OTEL log flags for tool details + user prompts<br/><br/>Stop hook → pending-prompt.txt"]

    CX_CFG --> CX_KEYS["toml otel section:<br/>log_user_prompt = true<br/>exporter otlp-http endpoint=...<br/>trace_exporter otlp-http endpoint=..."]

    CP_CFG --> CP_KEYS["github.copilot.chat.otel.enabled = true<br/>exporterType = 'otlp-http'<br/>otlpEndpoint = http://localhost:{port}<br/>(each installed IDE variant's settings.json)"]

    CC_KEYS --> RESTART[Requires Claude Code restart]
    CX_KEYS --> RESTART
    CP_KEYS --> RELOAD[Requires IDE reload]
```

---

## 13. Build Pipeline

Four independent esbuild targets produce four output bundles.

```mermaid
graph LR
    subgraph Source
        SRC_DASH[media/src/dashboard.tsx<br/>+ media/src/**]
        SRC_SB[media/src/sidebarWebview.ts]
        SRC_SA[standalone/server.ts]
        SRC_CLI[standalone/cli.ts]
    end

    subgraph esbuild targets
        B2[Dashboard bundle<br/>format: iife · platform: browser<br/>jsx: preact/jsx-runtime]
        B3[Sidebar bundle<br/>format: iife · platform: browser]
        B4[Server bundle<br/>format: cjs · platform: node]
        B5[CLI bundle<br/>format: cjs · platform: node]
    end

    subgraph Outputs
        O2[media/dashboard.js]
        O3[media/sidebar.js]
        O4[standalone/server.js]
        O5[standalone/cli.js]
    end

    SRC_DASH --> B2 --> O2
    SRC_SB --> B3 --> O3
    SRC_SA --> B4 --> O4
    SRC_CLI --> B5 --> O5
```

`sql.js` is not bundled: the standalone server resolves it from `node_modules` at runtime (`require.resolve('sql.js')` + `locateFile` for its WASM, `standalone/server.ts`) and uses it to read OpenCode's SQLite database — when `sql.js` is unavailable, OpenCode ingestion falls back to the per-message JSON files.

### Type-check vs bundle

```mermaid
graph LR
    TSC1["tsc --noEmit<br/>tsconfig.json — checks src/"] --> TC_ONLY[Type errors only<br/>No output]
    TSC2["tsc --noEmit -p media/tsconfig.json<br/>checks media/src/"] --> TC_ONLY
    ESB[esbuild.js] --> BUNDLES[Bundles output<br/>No type checking]
    TC_ONLY & BUNDLES --> CI["pnpm run compile<br/>passes only when both succeed"]
```

---

## File Map

```text
agentlenspro/
├── src/
│   ├── otlpCollector.ts          # HTTP server, Codex session synthesis
│   ├── otlpParser.ts             # Pure parsing (tests/standalone)
│   ├── sessionStore.ts           # 5-min rolling span window, onUpdate callbacks
│   ├── sessionRepository.ts      # Merges DB + live window; single session data access point
│   ├── spanSummarizer.ts         # Orchestrates per-agent builders
│   ├── segmentedSpanStore.ts     # Standalone span persistence — daily append-only NDJSON segments,
│   │                             #   per-segment index, range loads, retention, spans.json migration
│   ├── shared/                   # Runtime-neutral modules imported by BOTH src/** and media/src/**
│   │   │                         #   (no Node imports, no DOM APIs; guarded by scripts/check-no-mirrors.js)
│   │   ├── pricing.ts            # THE rate table: lookupRates, calcTokenCostUsd (host), calcTokenCost (webview)
│   │   ├── summarizerTypes.ts    # SessionSummaryCard, TimelineEntry, and all card/diagnosis types
│   │   ├── telemetryTypes.ts     # Span, SpanAttribute, SpanStatus, LoopSignal(Type)
│   │   ├── cacheBreak.ts         # Cache-break classifier + report builder + CAUSE_LABEL
│   │   ├── keepWarm.ts           # Keep-warm / cache-gap diagnostic (TtlRegime-aware, computeKeepWarm)
│   │   ├── cacheTtl.ts           # The doc-verified prompt-cache TTL matrix (regime × auth × env → ttlMs)
│   │   ├── tokenBuckets.ts       # Disjoint four-bucket normalization (disjointBuckets, contextTokens)
│   │   ├── fallbackCounters.ts   # Parse-fallback counters (mass-corruption visibility)
│   │   ├── residentCost.ts       # Resident-cost itemization over a ContextHistory
│   │   ├── spawnRollup.ts        # Spawn-cost rollup + antipattern detections
│   │   └── tokensByCause.ts      # Tokens-by-cause attribution rollup
│   ├── autoConfigNode.ts         # Claude/Codex file-based config
│   ├── exportData.ts             # JSON export helpers
│   ├── logReader.ts              # LogReader — local log ingestion (Claude/Codex/Copilot CLI/Copilot Chat JSONL+JSON)
│   ├── loopDetector.ts           # Loop signal detection
│   ├── types.ts                  # Host-only types (SessionSummary)
│   ├── database/
│   │   ├── schema.ts             # SCHEMA_SQL — CREATE TABLE statements + indexes
│   │   ├── db.ts                 # AgentLensDb — open, migrate, save, dispose
│   │   ├── writer.ts             # DatabaseWriter — enqueue/drain, blob writes, cost_usd
│   │   ├── reader.ts             # DatabaseReader — list, search, analytics, burn rate, blobs
│   │   ├── migration.ts          # migrateGlobalStateToSqlite (one-time)
│   │   ├── retention.ts          # runRetention — DELETE old sessions + blob eviction
│   │   └── types.ts              # Shared DB types
│   ├── summarizers/
│   │   ├── claude.ts             # Claude Code session builder
│   │   ├── copilot.ts            # Copilot session builder
│   │   ├── codex.ts              # Codex session builder
│   │   └── helpers.ts            # Shared attribute/token extraction
│   └── test/
│       ├── sessionStore.test.ts
│       ├── database/
│       │   ├── writer.test.ts
│       │   ├── reader.test.ts
│       │   ├── reader.analytics.test.ts
│       │   ├── migration.test.ts
│       │   ├── retention.test.ts
│       │   └── sessionRepository.test.ts
│       └── pricing.test.ts
├── media/
│   ├── src/
│   │   ├── App.tsx               # Preact root, message handler, tab router, sticky tab bar
│   │   ├── state.ts              # Signals: sessions, timelines, blobs, analytics, sort, time range
│   │   ├── types.ts              # Webview-specific message/UI types + re-exports of src/shared types
│   │   ├── sessionMetrics.ts     # calcSessionCost, calcEntryCost, fmtUsd
│   │   ├── utils.ts              # Formatting helpers, agent colors, session labels
│   │   ├── agentProfiles.ts      # Per-agent alert/automation thresholds (localStorage)
│   │   ├── AgentThresholdInputs.tsx  # Reusable form input components for threshold editing
│   │   ├── sidebarWebview.ts     # Sidebar JS (no JSX)
│   │   ├── styles/
│   │   │   ├── base.css          # Global variables, layout primitives
│   │   │   ├── tabs.css          # Tab bar (sticky), tab-mini buttons
│   │   │   ├── toolbar.css       # Time range picker, agent filter pills, search bar
│   │   │   ├── components.css    # Cards, tables, tool-insights-table, empty states
│   │   │   ├── tooltip.css       # has-metric-tip, metric-tooltip (global hover tooltip)
│   │   │   ├── waterfall.css     # Trace waterfall timeline
│   │   │   ├── summaries.css     # Session detail expand: sw-detail, sw-bg-* blocks
│   │   │   ├── heatmap.css       # heatmap-axis-label used by Cost/Efficiency charts
│   │   │   ├── insights.css      # InsightCard styles
│   │   │   ├── graph.css         # Flow semantic graph canvas overlay
│   │   │   ├── help.css          # Help tab typography, TOC nav, glossary
│   │   │   └── export.css        # Export tab card layout
│   │   └── tabs/
│   │       ├── Sessions.tsx      # Sortable session table, expand-in-place detail panel
│   │       │                     #   sub-tabs: Overview (InsightCards) · Trace · Flow · Tools · Files
│   │       ├── Analytics.tsx     # ESTIMATED COST · AGENT BREAKDOWN · TOKEN USAGE · CONTEXT GROWTH
│   │       ├── Insights.tsx      # InsightCard component + generateInsights; clipboard copy icon
│   │       ├── Cost.tsx          # CostBarChart (canvas), per-session cost table, M/K token toggle, CSV export, fmtUsd
│   │       ├── SessionCharts.tsx # ContextGrowthChart (animated), SessionTokenChart, TurnsLink
│   │       ├── Traces.tsx        # Waterfall rows (Step/StepRow), background span groups
│   │       ├── Flow.tsx          # Turn-to-tool semantic graph (canvas), FlowCanvas component
│   │       ├── Agents.tsx        # computeStats helper used by Analytics AgentCard
│   │       ├── Tools.tsx         # ToolsChart (donut + table) used by Sessions detail
│   │       ├── Alerts.tsx        # Alert config UI, checkAlerts, AlertNotification type
│   │       ├── Automation.tsx    # Automation config UI, checkAutomations, prompt building
│   │       ├── Export.tsx        # Raw + redacted JSON export UI
│   │       └── Help.tsx          # Sticky TOC nav, glossary, OTEL setup guide
│   ├── dashboard.js              # Compiled Preact bundle
│   ├── dashboard.css             # Compiled styles
│   └── sidebar.js                # Compiled sidebar script
├── standalone/
│   ├── server.ts                 # Standalone HTTP server (no VS Code)
│   └── cli.ts                    # The ONE executable: `agentlenspro` — thin shim over src/cli/main.ts
├── src/cli/                      # The single-executable dispatcher (TRDD-7284WCW7)
│   ├── main.ts                   # Top-level dispatch: --version/--help fast paths, subcommand routing
│   ├── diagnosticsCli.ts         # 32 diagnostic tools + ops flags (schemas live from the server)
│   ├── serverControl.ts          # server start|stop|restart|status [--supervise], dashboard
│   ├── hookHandlers.ts           # `agentlenspro hook` / `agentlenspro gate` stdin handlers
│   ├── hookInstall.ts            # hook/OTEL/skill (un)installers + registration migration
│   ├── heartbeatCostCli.ts       # `agentlenspro heartbeat-cost`
│   ├── configCli.ts              # `agentlenspro config` — retention knobs (TRDD-ZAV74M8Q)
│   ├── envCli.ts                 # `agentlenspro env` — environment/system detection (TRDD-HUWJVQJA)
│   ├── setup.ts                  # `agentlenspro setup` — detect → converge → verify-per-step → self-test
│   └── cliCore.ts                # shared JSON-RPC/REST transport + endpoint/env resolution
├── src/environment/             # `agentlenspro env` facet registry (TRDD-HUWJVQJA) — all fail-soft,
│   │                            #   pure classifiers + async gather(), no server, injectable for tests
│   ├── types.ts                  # the EnvFacet contract + EnvReport
│   ├── exec.ts                   # fail-soft time-boxed run()/which()/toolVersion() helpers
│   ├── index.ts                  # the facet REGISTRY + gatherAll() (runs facets concurrently)
│   ├── terminal.ts               # terminal kind by PROCESS ANCESTRY + ai-maestro/tmux/ssh
│   ├── os.ts · runtime.ts · claude.ts · filesystem.ts · user.ts
│   └── network.ts · cloud.ts · tooling.ts · mcp.ts
├── src/retentionConfig.ts       # persistent retention config layer (TRDD-ZAV74M8Q)
├── scripts/
│   └── safe_config_edit.py       # Verified-transaction config editor (backup, verify-diff, lock)
├── esbuild.js                    # Build configuration (4 targets)
├── package.json                  # npm package manifest — bins, scripts, dependencies
└── ARCHITECTURE.md               # This file
```
