#!/usr/bin/env node
// Load generator for TRDD-HFV4AIT7: floods alcore's OTLP + hook-events endpoints at
// concurrency for a fixed duration, then reports request throughput and the
// server-side counter delta (spans_appended / hook receivedSinceBoot).
//
// No deps — plain Node http, keep-alive agents.
//
// TRDD-PQ40PZ9D: --mix transcripts appends synthetic Claude Code JSONL to
// <isolated-home>/.claude/projects/bench-transcripts/ to drive log-sweeper card rebuilds;
// it refuses the real home (subtree guard). In this mode reqPerSec/ok2xx count FILE APPENDS
// (not http posts), underRate means "appends under target", and targetDownAtSec means the
// append target (fs) went down. Acceptance deltas: logSessionsDelta>=1, summaryMissesDelta>=1,
// dataVersionDelta>0 — the snapshot's /api/summary read is what drives the summary miss/rebuild.
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/** Per-request ceiling. Above this the server is not "slow", it is not answering — and the run
 *  must still terminate and report that. */
const REQUEST_TIMEOUT_MS = Number(process.env.BENCH_REQUEST_TIMEOUT_MS) || 10_000;

// B4: exact-string flag matching means `--rate=2` is an unknown flag, not a lenient `--rate 2` —
// list every accepted numeric flag once here so an unlisted or malformed value fails fast (exit 2)
// before any http call, rather than silently running with a default.
const FLAG_TO_KEY = {
  '--otlp-port': 'otlpPort', '--ui-port': 'uiPort', '--seconds': 'seconds',
  // Sessions, not raw throughput. The USER's question is "many Claude Code sessions in
  // parallel", and a flat-out flood answers a different one: it runs ~6,250x this machine's
  // measured 26 spans/s peak, which manufactures allocator behaviour no fleet produces.
  '--concurrency': 'concurrency', '--sessions': 'sessions', '--spans-per-session': 'spansPerSession',
  '--rate': 'rate', '--spans-per-request': 'spansPerRequest', '--new-session-every': 'newSessionEvery',
  '--progress-sec': 'progressSec', '--subagent-share': 'subagentShare',
  // TRDD-PQ40PZ9D (transcripts mode): --lines-per-sec is the TOTAL append rate across ALL
  // workers (not per-worker); --transcripts-home must be an isolated scratch home.
  '--transcripts-home': 'transcriptsHome', '--lines-per-sec': 'linesPerSec',
};

function parseArgs(argv) {
  const out = {
    otlpPort: 4901, uiPort: 3901, seconds: 30, concurrency: 32, mix: 'both',
    sessions: 0, spansPerSession: 26,
    // TRDD-C19SUVPH: --rate makes pacing target REQUESTS/s directly (any mix, incl. statusline),
    // which --sessions cannot express — --sessions only ever meant "N Claude Code sessions each at
    // their measured spans/s peak", a statement about OTLP, not about a statusline-only arm.
    rate: 0, spansPerRequest: 20, newSessionEvery: 0, progressSec: 300, subagentShare: 0.31, allowLive: false,
    // TRDD-PQ40PZ9D: transcripts mode appends synthetic Claude Code JSONL lines to
    // <transcriptsHome>/.claude/projects/bench-transcripts/<session>.jsonl.
    transcriptsHome: '', linesPerSec: 5,
  };
  const errors = [];
  const given = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-live') { out.allowLive = true; continue; }
    if (a === '--mix') { out.mix = argv[++i]; continue; }
    // Object.hasOwn, not a bare index: FLAG_TO_KEY[a] resolves an inherited name like
    // "constructor" or "toString" to Object.prototype's own method instead of undefined,
    // so `constructor 1` on the CLI silently passed through as a "known" flag.
    const key = Object.hasOwn(FLAG_TO_KEY, a) ? FLAG_TO_KEY[a] : undefined;
    if (!key) { errors.push(`unknown flag: ${a}`); continue; }
    const raw = argv[++i];
    // raw.trim() === '': Number('') is 0, which passes `value < 0` and
    // Number.isFinite, so an unset shell var (`--rate "$UNSET"` -> `--rate ""`) silently
    // became rate=0 — the flat-out-flood default — instead of a caught bad argument.
    if (raw === undefined || raw.trim() === '') {
      errors.push(`invalid value for ${a}: ${JSON.stringify(raw)}`);
      continue;
    }
    if (a === '--transcripts-home') {
      out[key] = raw;
      given.add(key);
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`invalid value for ${a}: ${JSON.stringify(raw)}`);
      continue;
    }
    out[key] = value;
    given.add(key);
  }
  return { out, errors, given };
}

/** Cross-field / enum checks parseArgs cannot do inline. Runs before any http call so a bad
 *  flag combination fails fast (exit 2) instead of burning the run's --seconds. */
function validateArgs(out, given) {
  const errors = [];
  if (!['otlp', 'hooks', 'both', 'statusline', 'transcripts'].includes(out.mix)) errors.push(`--mix must be one of otlp,hooks,both,statusline,transcripts, got ${JSON.stringify(out.mix)}`);
  if (!(out.concurrency >= 1)) errors.push('--concurrency must be >= 1');
  // Array.from({ length: 2.5 }) makes 2 workers while paceMsPerReq is computed from the
  // un-truncated 2.5 — the pacing math and the actual worker count would then disagree.
  if (!Number.isInteger(out.concurrency)) errors.push('--concurrency must be an integer');
  if (!(out.seconds > 0)) errors.push('--seconds must be > 0');
  if (!(out.progressSec >= 1)) errors.push('--progress-sec must be >= 1');
  if (!(out.subagentShare >= 0 && out.subagentShare <= 1)) errors.push('--subagent-share must be within [0,1]');
  if (!Number.isInteger(out.otlpPort) || out.otlpPort < 1 || out.otlpPort > 65535) errors.push('--otlp-port must be an integer in 1-65535');
  if (!Number.isInteger(out.uiPort) || out.uiPort < 1 || out.uiPort > 65535) errors.push('--ui-port must be an integer in 1-65535');
  // An explicit zero on either --rate or --sessions is rejected below; flat-out (both 0, the
  // defaults) stays reachable only by omitting both flags.
  if (given.has('rate') && !(out.rate > 0)) errors.push('--rate must be > 0 when given');
  // Mirrors the --rate rule directly above: --sessions "$N" with N=0 was another flat-out
  // path, since a session count of 0 leaves nothing to bound the request rate either.
  if (given.has('sessions') && !(out.sessions > 0)) errors.push('--sessions must be > 0 when given');
  if (!Number.isInteger(out.spansPerRequest) || out.spansPerRequest < 1) errors.push('--spans-per-request must be an integer >= 1');
  if (!(out.spansPerSession >= 1)) errors.push('--spans-per-session must be >= 1');
  if (!(out.newSessionEvery === 0 || out.newSessionEvery >= 1)) errors.push('--new-session-every must be 0 or >= 1');
  if (!Number.isInteger(out.sessions)) errors.push('--sessions must be an integer');
  // TRDD-PQ40PZ9D: transcripts mode is paced ONLY by --lines-per-sec (total lines/s across
  // workers); --rate and --sessions express http-request/span rates a transcript append
  // cannot honour.
  if (out.mix === 'transcripts' && (given.has('rate') || given.has('sessions'))) errors.push('--rate and --sessions are not valid with --mix transcripts (use --lines-per-sec)');
  if (!Number.isInteger(out.linesPerSec) || out.linesPerSec < 1) errors.push('--lines-per-sec must be an integer >= 1');
  if (out.mix === 'transcripts' && !out.transcriptsHome) errors.push('--mix transcripts requires --transcripts-home');
  if (out.mix !== 'transcripts' && out.transcriptsHome) errors.push('--transcripts-home is only valid with --mix transcripts');
  return errors;
}

// B4: validated BEFORE the live-port refusal below and before any http call — an unknown flag,
// a numeric flag with a missing/non-finite/negative value, or an out-of-range value must exit 2
// immediately, never run silently with a default (`--rate=2` matches no exact flag string above
// and is therefore an unknown flag, not a lenient `--rate 2`).
const { out: args, errors: parseErrors, given: givenFlags } = parseArgs(process.argv.slice(2));
const argErrors = [...parseErrors, ...validateArgs(args, givenFlags)];
if (argErrors.length > 0) {
  console.error(`bad arguments: ${argErrors.join('; ')}`);
  process.exit(2);
}

// LIVE-PORT REFUSAL (TRDD-C19SUVPH item 7, half 1) — checked BEFORE any http call, so a synthetic
// flood can never reach the real collector's canonical ports by construction, not by operator
// care: a benchmark that floods :3000/:4318 pollutes the live store with spans/statusline rows
// indistinguishable from real Claude Code activity.
if (!args.allowLive && (args.otlpPort === 4318 || args.uiPort === 3000)) {
  console.error('refusing: --ui-port 3000 or --otlp-port 4318 targets the live collector; pass --allow-live to override');
  process.exit(2);
}
const SESSION_IDS = Array.from({ length: 16 }, (_, i) => `bench-session-${i.toString(16).padStart(4, '0')}`);
const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

// model.id + model.display_name pairing for the statusline payload (statuslineUsage.ts reads
// model.display_name only, but a realistic payload carries both, same as the live WAL).
const MODEL_PAIRS = [
  { id: 'claude-opus-5', display_name: 'Opus 5' },
  { id: 'claude-sonnet-5', display_name: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', display_name: 'Haiku 4.5' },
];

// --new-session-every: a sliding window of the 16 newest ids, so a long soak keeps discovering
// "new" sessions the way a real fleet does instead of hammering the same 16 forever. Off (0) by
// default: the window just stays the static SESSION_IDS seed.
let sessionWindow = [...SESSION_IDS];
let sessionWindowNextIdx = SESSION_IDS.length;
function growSessionWindow() {
  sessionWindow.push(`bench-session-${(sessionWindowNextIdx++).toString(16).padStart(4, '0')}`);
  if (sessionWindow.length > 16) sessionWindow.shift();
}
function pickSession() {
  return sessionWindow[Math.floor(Math.random() * sessionWindow.length)];
}

// cost.total_cost_usd must RISE per session over the run (statusline's own semantics: a
// monotonically increasing cumulative cost) — a flat/random value would never exercise a reader
// that diffs successive samples.
const statuslineCostBySession = new Map();

// Synthetic project path/slug for the statusline payload's path-shaped fields — long enough to
// match a real project-dir/transcript-path byte weight (TRDD-C19SUVPH item 1 targets ~1.9-2.0KB;
// short /tmp paths alone measured ~330 bytes light). No reader opens these paths.
const BENCH_PROJECT_DIR = '/tmp/al-bench-data/bench-project-synthetic-workspace-for-load-testing';
const BENCH_PROJECT_SLUG = BENCH_PROJECT_DIR.replace(/\//g, '-');

// B3: prompt_id must stay stable across 20 consecutive samples of the SAME session, then rotate —
// one real API call's prompt_id spans many statusline ticks, not one per tick.
const statuslinePromptBySession = new Map(); // session -> { id, count }

// B3: rate_limits are account-wide, not per-sample — every session on one account shares one
// slowly-rising used_percentage and one reset time fixed at process start, never a fresh random
// number on every POST.
const RUN_START_SEC = Math.floor(Date.now() / 1000);
const rateLimitState = {
  fiveHour: { usedPercentage: 5 + Math.random() * 25, resetsAt: RUN_START_SEC + 18000 },
  sevenDay: { usedPercentage: 5 + Math.random() * 25, resetsAt: RUN_START_SEC + 604800 },
};

// B3: mean statusline body size in bytes, surfaced in the result as statuslineBodyBytesMean.
const statuslineBodyBytes = { total: 0, count: 0 };

function hex(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function strAttr(key, value) {
  return { key, value: { stringValue: String(value) } };
}
function intAttr(key, value) {
  return { key, value: { intValue: String(value) } };
}
function doubleAttr(key, value) {
  return { key, value: { doubleValue: value } };
}

function makeOtlpBody(spanCount = 20) {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const spans = [];
  for (let i = 0; i < spanCount; i++) {
    const session = pickSession();
    const model = MODELS[Math.floor(Math.random() * MODELS.length)];
    const inputTokens = 500 + Math.floor(Math.random() * 5000);
    const outputTokens = 50 + Math.floor(Math.random() * 800);
    const cacheRead = Math.floor(Math.random() * 20000);
    const cacheCreate = Math.floor(Math.random() * 4000);
    spans.push({
      traceId: hex(32),
      spanId: hex(16),
      name: 'claude_code.api_request',
      startTimeUnixNano: nowNs.toString(),
      endTimeUnixNano: (nowNs + 1_000_000n).toString(),
      attributes: [
        strAttr('session.id', session),
        strAttr('model', model),
        intAttr('input_tokens', inputTokens),
        intAttr('output_tokens', outputTokens),
        intAttr('cache_read_input_tokens', cacheRead),
        intAttr('cache_creation_input_tokens', cacheCreate),
        doubleAttr('cost_usd', Math.random() * 2),
      ],
    });
  }
  return JSON.stringify({
    resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 'bench' }, spans }] }],
  });
}

function makeHookBody() {
  const session = pickSession();
  const evName = Math.random() < 0.5 ? 'PreToolUse' : 'PostToolUse';
  return JSON.stringify({
    hook_event_name: evName,
    session_id: session,
    tool_name: 'Bash',
    tool_input: { command: 'echo bench' },
    cwd: '/tmp/al-bench-data',
  });
}


// TRDD-PQ40PZ9D: synthetic Claude Code assistant JSONL transcript line. Shape pinned to what the
// log-scan parser actually reads (agentlens-logscan/src/lib.rs:842 assistant branch):
// `type:"assistant"`, `message.model`, `message.id` (usage dedup per message.id — :851),
// `message.content[]` blocks, `message.usage{input_tokens,output_tokens,cache_read_input_tokens,
// cache_creation_input_tokens}` (disjoint_anthropic :147), top-level `timestamp` (ISO,
// parse_iso_ms in agentlens-spanstore/src/lib.rs:165 — len>=20, optional ms fraction), top-level
// `cwd` (:762 — first truthy cwd becomes the card's workspace). Top-level `sessionId` is NOT
// read — the session id IS the file stem (:1279), so the bench names files
// `<home>/.claude/projects/bench-transcripts/<session>.jsonl`. `cache_creation` tier sub-object
// is OMITTED: an older-CC shape the parser legally reports as "no tier sub-object". One row per
// fresh `msg_w<i>_<session>_<n>` id — every row is a first row, so no usage row is dropped by
// the per-message.id dedup; the worker-index prefix keeps two workers appending to one session
// from colliding ids.
function makeTranscriptLine(i, n) {
  const session = pickSession();
  const model = MODELS[Math.floor(Math.random() * MODELS.length)];
  const ts = new Date().toISOString(); // parse_iso_ms accepts ISO-with-ms (len>=20, optional frac)
  const line = {
    type: 'assistant',
    timestamp: ts,
    cwd: BENCH_PROJECT_DIR, // first row's cwd becomes the card workspace (lib.rs:762)
    message: {
      id: `msg_w${i}_${session}_${n}`,
      model,
      content: [{ type: 'text', text: `bench turn ${n}: ` + 'x'.repeat(200) }],
      usage: {
        input_tokens: 500 + Math.floor(Math.random() * 5000),
        output_tokens: 50 + Math.floor(Math.random() * 800),
        cache_read_input_tokens: Math.floor(Math.random() * 200000),
        cache_creation_input_tokens: Math.floor(Math.random() * 20000),
      },
    },
  };
  return { session, line: JSON.stringify(line) };
}


// Transcripts mode state: the fixed project-dir slug under <home>/.claude/projects/ and the
// per-run memo of created transcript files (growSessionWindow can mint a new session id at any
// tick, so the file for a session is ensured lazily right before its first append).
const TRANSCRIPT_SLUG = 'bench-transcripts';
const transcriptFilesEnsured = new Set();
function ensureTranscriptFile(home, session) {
  const dir = path.join(home, '.claude', 'projects', TRANSCRIPT_SLUG);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${session}.jsonl`);
  if (!transcriptFilesEnsured.has(p)) {
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
    transcriptFilesEnsured.add(p);
  }
  return p;
}

/**
 * Synthetic /api/statusline-samples body, shaped like the real statusline.py payload (see
 * recordFromStatuslinePayload in src/statuslineUsage.ts for the fields that reader actually
 * consumes, and the newest live WAL row for the rest — TRDD-C19SUVPH item 1). transcript_path/
 * cwd/scratchpad_dir point under /tmp/al-bench-data: no reader opens them, they only exist so the
 * shape matches a real payload's string-field weight for the ~1.9-2.0KB body-size target.
 */
function makeStatuslinePayload() {
  const session = pickSession();
  const isSubagent = Math.random() < args.subagentShare;
  const model = MODEL_PAIRS[Math.floor(Math.random() * MODEL_PAIRS.length)];
  // Rising cumulative cost per session — a flat/random value would never exercise a reader that
  // diffs successive samples (statusline's own semantics: total_cost_usd only ever grows).
  const prevCost = statuslineCostBySession.get(session) ?? Math.random() * 5;
  const cost = prevCost + Math.random() * 0.05;
  statuslineCostBySession.set(session, cost);
  // B3: prompt_id stays stable for 20 consecutive samples of this session, then rotates — one
  // real API call's prompt_id spans many statusline ticks, not one per tick.
  let promptState = statuslinePromptBySession.get(session);
  if (!promptState || promptState.count >= 20) {
    promptState = { id: hex(32), count: 0 };
    statuslinePromptBySession.set(session, promptState);
  }
  promptState.count++;
  const inputTokens = 500 + Math.floor(Math.random() * 5000);
  const outputTokens = 50 + Math.floor(Math.random() * 800);
  const cacheRead = Math.floor(Math.random() * 200000);
  const cacheCreate = Math.floor(Math.random() * 20000);
  const totalInput = inputTokens * 40 + cacheRead;
  const totalOutput = outputTokens * 40;
  const contextWindowSize = 200000;
  const usedPct = Math.min(100, Math.round(((totalInput + totalOutput) / contextWindowSize) * 100));
  // B3: rate_limits are account-wide and rise slowly across the whole run — see rateLimitState.
  rateLimitState.fiveHour.usedPercentage = Math.min(100, rateLimitState.fiveHour.usedPercentage + 0.001);
  rateLimitState.sevenDay.usedPercentage = Math.min(100, rateLimitState.sevenDay.usedPercentage + 0.001);
  // B3: no `ts` field here — the server STAMPS ITS OWN ts on every stored row. statusline_store.rs
  // `append()` (rust-core/crates/agentlens-core/src/statusline_store.rs:289-304) flattens the
  // client payload, then does `flat.insert("ts", num(ts_ms))` with its OWN now_ms(), overwriting
  // whatever this field said. Sending a client ts would be dead weight the server discards, so it
  // is omitted rather than faked (confirmed via `tldr search "fn append" statusline_store.rs`).
  const body = JSON.stringify({
    session_id: session,
    transcript_path: `/tmp/al-bench-data/.claude-mirror/projects/${BENCH_PROJECT_SLUG}/${session}.jsonl`,
    cwd: BENCH_PROJECT_DIR,
    scratchpad_dir: `/tmp/al-bench-data/scratchpad/${BENCH_PROJECT_SLUG}/${session}`,
    prompt_id: promptState.id,
    effort_level: 'medium',
    model: { id: model.id, display_name: model.display_name },
    workspace: {
      current_dir: BENCH_PROJECT_DIR,
      project_dir: BENCH_PROJECT_DIR,
      added_dirs: [`${BENCH_PROJECT_DIR}/added`],
      repo_host: 'github.com',
      repo_owner: 'bench',
      repo_name: 'bench-repo',
    },
    version: '2.1.280',
    output_style_name: 'default',
    cost: {
      total_cost_usd: Math.round(cost * 1e6) / 1e6,
      total_duration_ms: Math.floor(Math.random() * 30_000_000),
      total_api_duration_ms: Math.floor(Math.random() * 2_000_000),
      total_lines_added: Math.floor(Math.random() * 500),
      total_lines_removed: Math.floor(Math.random() * 200),
    },
    context_window: {
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      context_window_size: contextWindowSize,
      current_usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
      },
      used_percentage: usedPct,
      remaining_percentage: 100 - usedPct,
    },
    exceeds_200k_tokens: totalInput > 200000,
    prompt_cache: {
      warm: true,
      caching_observed: true,
      ttl: '1h',
      // Fixed per run (RUN_START_SEC), not nowSec per sample — an expires_at that moves every
      // tick has the same per-second cardinality problem already removed from resets_at (B3):
      // one real cache write has ONE expiry, not a fresh one on every statusline sample.
      expires_at: RUN_START_SEC + 3600,
      requests: Math.floor(Math.random() * 300),
      misses: Math.floor(Math.random() * 5),
      expected_rebuilds: 0,
      hit_ratio: 0.95 + Math.random() * 0.05,
      cache_write_tokens: cacheCreate,
      miss_recache_tokens: 0,
      last_miss_at: null,
      last_miss_cause: null,
      recache_tokens_if_cold: totalInput,
    },
    fast_mode: false,
    thinking_enabled: true,
    rate_limits: {
      five_hour: { used_percentage: Math.round(rateLimitState.fiveHour.usedPercentage), resets_at: rateLimitState.fiveHour.resetsAt },
      seven_day: { used_percentage: Math.round(rateLimitState.sevenDay.usedPercentage), resets_at: rateLimitState.sevenDay.resetsAt },
    },
    hook_event_name: isSubagent ? 'SubagentStatusLineSample' : 'StatusLineSample',
    statusline_stream: isSubagent ? 'subagent' : 'main',
  });
  statuslineBodyBytes.total += Buffer.byteLength(body);
  statuslineBodyBytes.count++;
  return body;
}

function post(agent, port, path, body) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', agent, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        // A destroy() on an in-flight response (our own timeout below, or the peer resetting the
        // socket after headers landed) emits 'error' on res, not just on req — uncaught, that
        // throws out of the Promise executor and kills the whole run with no result JSON.
        res.on('error', () => resolve(0));
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    // A wedged server otherwise hangs the whole run: sockets stay open with no response, workers
    // block forever on `await post`, and a `--seconds 20` bench runs past 500s. Measured on
    // 2026-08-29 — the run had to be killed (exit 144) and produced no output at all, so a real
    // finding (the server stalling under load) was nearly lost to a harness that could not report
    // it. A timed-out request resolves 0, which counts as nonOk and is excluded from the
    // percentiles, so a stall shows up as failures rather than as a flattering latency figure.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve(0);
    });
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

async function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
      // A destroy() on an in-flight response (our own setTimeout below, or the peer resetting the
      // socket after headers landed) emits 'error' on res, not just on req — uncaught, that
      // throws out of the Promise executor and kills the whole multi-minute run over one dropped GET.
      res.on('error', reject);
    }).on('error', reject);
    // B1: same wedge risk `post` already guards against (2026-08-29 hang, see its comment) — a
    // stats GET with no timeout can block a tick, the initial read, or the final read forever
    // near the 2GB guard, where a wedged target is plausible. Destroying with an Error fires the
    // 'error' handler above, which rejects — fetchSnapshot's catch turns that into a null.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
  });
}

function pick(mix) {
  if (mix === 'otlp') return 'otlp';
  if (mix === 'hooks') return 'hooks';
  if (mix === 'statusline') return 'statusline';
  if (mix === 'transcripts') return 'transcripts';
  return Math.random() < 0.5 ? 'otlp' : 'hooks';
}

/** Target spans/sec across the whole run, or 0 for flat-out. `--sessions N` models N Claude Code
 *  sessions each emitting `--spans-per-session` spans/sec (default 26, this machine's measured
 *  peak for ONE session). */
function targetSpansPerSec() {
  return args.sessions > 0 ? args.sessions * args.spansPerSession : 0;
}

// Target-down bookkeeping lives on `state` (shared across every worker, single-threaded JS so no
// lock needed): a run of consecutive failures ends the arm early rather than burning the full
// --seconds against a server that is provably not answering (TRDD-C19SUVPH item 6).
function noteRequestOutcome(state, ok) {
  if (ok) {
    state.failCount = 0;
    state.failStartMs = null;
    return;
  }
  if (state.failCount === 0) state.failStartMs = Date.now();
  state.failCount++;
  if (!state.stopped && state.failCount >= 20 && Date.now() - state.failStartMs >= 30_000) {
    state.stopped = true;
    state.targetDownAtSec = (state.failStartMs - state.started) / 1000;
  }
}

async function worker(i, agentOtlp, agentUi, state, mix, counters, paceMsPerReq) {
  // Stagger: worker i's FIRST request waits i*pace/concurrency ms, so `--rate` workers fan out
  // across one pacing period instead of firing a synchronized burst every period (TRDD-C19SUVPH
  // item 2) — a real fleet's sessions do not all call out on the same tick.
  // Capped at the remaining run time (state.deadline - now): an uncapped stagger/pacing sleep let
  // a --seconds 30 run with a slow --rate take minutes to finish, sending every request AFTER the
  // deadline had already passed — and setTimeout clamps any delay above 2^31-1 ms down to 1 ms,
  // turning an oversized wait into a hidden flat-out loop instead of a slow one.
  if (paceMsPerReq > 0 && args.concurrency > 1) {
    const stagger = Math.min((i * paceMsPerReq) / args.concurrency, state.deadline - Date.now());
    if (stagger > 0) await new Promise((r) => setTimeout(r, stagger));
  }
  // Start one pace-interval early: the stagger above already spreads workers across the pacing
  // period, so this only cancels the redundant extra sleep before the FIRST request that a plain
  // Date.now() start added on top of it. With the deadline cap in place, that extra sleep
  // cost each worker up to one request (e.g. --rate 1 --concurrency 32 --seconds 300 would
  // deliver ~268/300, about 11% short, by calculation) and could false-flag underRate.
  // No-op when paceMsPerReq is 0.
  let nextAt = Date.now() - paceMsPerReq;
  let transcriptLineNo = 0;
  while (Date.now() < state.deadline && !state.stopped) {
    if (paceMsPerReq > 0) {
      nextAt += paceMsPerReq;
      const wait = Math.min(nextAt - Date.now(), state.deadline - Date.now());
      // Behind schedule: do not try to catch up, or a stall becomes a burst that measures
      // something the fleet would never do.
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      // The first iteration always lands here (nextAt starts one pace early), which anchors the schedule at the first send - keep that if this branch ever gains catch-up logic.
      else nextAt = Date.now();
    }
    // Re-check after any sleep above: the deadline may have passed while we were waiting, and a
    // request sent past it would count against a window this run no longer owns.
    if (Date.now() >= state.deadline || state.stopped) break;
    const t0 = performance.now();
    if (mix === 'transcripts') {
      // TRDD-PQ40PZ9D: the append IS the request. No pacing loop of its own — the shared
      // loop above (stagger, deadline cap, behind-schedule guard) applies unchanged; this
      // branch only replaces the http post with the fs append.
      const { session, line } = makeTranscriptLine(i, ++transcriptLineNo);
      try {
        const p = ensureTranscriptFile(args.transcriptsHome, session);
        fs.appendFileSync(p, line + '\n');
        const elapsed = performance.now() - t0;
        counters.requests++;
        counters.ok++;
        counters.lat.transcripts.push(elapsed);
        // In transcripts mode an append failure is NOT a server-down signal (a local fs error
        // says nothing about alcore's health) — but the 20-fail/30s early-stop still guards
        // against a wedged fs target, which is the failure mode this mode can actually hit.
        noteRequestOutcome(state, true);
      } catch (e) {
        const elapsed = performance.now() - t0;
        counters.requests++;
        counters.bad++;
        counters.lat.transcripts.push(elapsed);
        noteRequestOutcome(state, false);
      }
      continue;
    }
    const kind = pick(mix);
    const status = kind === 'otlp'
      ? await post(agentOtlp, args.otlpPort, '/v1/traces', makeOtlpBody(args.spansPerRequest))
      : kind === 'hooks'
        ? await post(agentUi, args.uiPort, '/api/hook-events', makeHookBody())
        : await post(agentUi, args.uiPort, '/api/statusline-samples', makeStatuslinePayload());
    // Per-kind, because the question this bench answers is about ONE route:
    // hookHandlers.ts spools only when the POST fails, and its failure threshold is
    // the AGENTLENS_HOOK_TIMEOUT (1000 ms default). So "does the spool fill?" is
    // "does /api/hook-events p99 stay under 1 s?" — an aggregate percentile mixed
    // with /v1/traces would not answer it.
    const elapsed = performance.now() - t0;
    counters.requests++;
    const ok = status >= 200 && status < 300;
    if (ok) {
      counters.ok++;
      // ONLY successful requests enter the percentiles. `post` resolves 0 on a socket error,
      // and a connection refused returns in ~0.1 ms — so timing failures alongside successes
      // makes p99 IMPROVE as the server degrades, which is exactly backwards for a threshold
      // check. Failures are counted separately; a run with nonOk > 0 has no valid percentile.
      counters.lat[kind].push(elapsed);
    } else {
      counters.bad++;
    }
    // B2: target-down counts only status===0 (no response / socket error / timeout — `post`
    // resolves 0 for exactly those). A 4xx/5xx is the server ANSWERING, not down — counting it
    // toward the down-streak would fake targetDownAtSec on a flood that merely got throttled.
    noteRequestOutcome(state, status !== 0);
  }
}

// ponytail: retains every sample (~7 MB of doubles at 43k req/s × 20 s). The push is
// amortised O(1) and the sort happens after the timed window, so the throughput number
// beside it is unaffected — but the array is unbounded, so a multi-minute soak needs a
// streaming digest (t-digest / fixed reservoir) rather than this.
// Nearest-rank percentile on an already-sorted array.
function pct(sorted, p) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[i] * 1000) / 1000;
}

function latencySummary(samples) {
  if (samples.length === 0) return null;
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    max: pct(sorted, 100),
  };
}

// realpath(p), falling back to the resolved (non-symlinked) path when the target doesn't exist
// yet — a fresh scratch data dir has nothing on disk before the server creates it.
function realpathOrResolve(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}


// TRDD-PQ40PZ9D (2026-10-17): the transcripts guard used realpathOrResolve(), whose
// path.resolve() fallback for a nonexistent leaf never follows an ANCESTOR symlink — a link
// L -> <home>/.claude/projects with --transcripts-home L/zz passed the guard and the bootstrap
// wrote 16 files through it before the post-mkdir re-resolve refused. This resolves the path
// the way the OS will: component by component, left to right, following every existing symlink
// (fs.realpathSync.native) BEFORE applying a later `..` — path.resolve() collapses `L3/../zz` to
// `zz` lexically while the kernel resolves it as `<target of L3>/../zz`. Components past the
// deepest existing one are appended as a tail. Never creates anything. Returns
// { refused: <reason> } on any lstat error other than ENOENT (EACCES, ELOOP, ...) or when an
// existing component cannot be realpath'd (a dangling symlink) — the caller must exit 2.
function realpathOfDeepestAncestor(p) {
  let cur;
  try {
    cur = path.isAbsolute(p) ? path.parse(path.resolve(p)).root : fs.realpathSync.native(process.cwd());
  } catch (e) {
    return { refused: `cannot resolve the working directory: ${e.message}` };
  }
  const tail = [];
  for (const part of p.split(path.sep)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (tail.length > 0) tail.pop();
      else cur = path.dirname(cur);
      continue;
    }
    if (tail.length > 0) { tail.push(part); continue; }
    const candidate = path.join(cur, part);
    try {
      fs.lstatSync(candidate);
    } catch (e) {
      if (e && e.code === 'ENOENT') { tail.push(part); continue; }
      return { refused: `cannot stat ${candidate}: ${e && e.code ? e.code : e}` };
    }
    try {
      cur = fs.realpathSync.native(candidate);
    } catch (e) {
      return { refused: `cannot resolve ${candidate} (dangling symlink?): ${e && e.code ? e.code : e}` };
    }
  }
  return { path: path.join(cur, ...tail) };
}

// Is `p` equal to `root` or inside it? darwin compares lowercased: the default APFS/HFS+ volume is
// case-insensitive, so `/Users/X/.Claude` names the same directory as `/Users/x/.claude`.
function isUnderRoot(p, root) {
  const norm = (s) => (process.platform === 'darwin' ? s.toLowerCase() : s);
  const a = norm(p);
  const r = norm(root);
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

// The first protected root `p` falls under, '/' itself, or null when `p` is safe to write under.
function protectedHit(p, roots) {
  if (p === path.parse(p).root) return p;
  for (const root of roots) if (isUnderRoot(p, root)) return root;
  return null;
}

let lastFetchErrorMessage = null;

/** One combined read of /api/server-stats + /api/debug/log-scan-stats, reduced to the fields the
 *  result deltas need, plus the pid and dataDir used by the live/revived checks (TRDD-C19SUVPH
 *  items 5 and 7). Returns null on ANY failure — the caller falls back to the last good snapshot
 *  rather than crashing a multi-minute run over one dropped GET. N2: the caught error's message
 *  is stashed in `lastFetchErrorMessage` so the initial-read failure can report WHY, not just
 *  that it failed. */
async function fetchSnapshot(uiPort) {
  try {
    const reads = [getJson(uiPort, '/api/server-stats'), getJson(uiPort, '/api/debug/log-scan-stats')];
    // TRDD-PQ40PZ9D: transcripts mode is append-only — nothing in it reads /api/summary, so the
    // derived summary cache would never miss or rebuild on its own. Each snapshot tick therefore
    // ALSO GETs /api/summary (result discarded), acting as the reader that drives real
    // miss/rebuild cycles off the sweeper's data_version bumps; without this,
    // summaryMissesDelta would sit at 0 no matter how much the sweeper parsed.
    if (args.mix === 'transcripts') reads.push(getJson(uiPort, '/api/summary').then(() => null));
    const [server, logScan] = await Promise.all(reads);
    lastFetchErrorMessage = null;
    return {
      ts: Date.now(),
      pid: server.pid,
      dataDir: server.dataDir,
      spansTotal: server.spans.store.totalSpans,
      hookReceived: server.hookEvents.receivedSinceBoot,
      statuslineReceived: server.statusline.receivedSinceBoot,
      statuslinePersisted: server.persistence.statuslineSamples,
      summaryMisses: logScan.derivedCaches.summary.misses,
      // server_stats.rs:538 — the session-card count (cards.len()); ui.rs:1826 — the sweeper's
      // dataVersion, bumped by every put_log_session write.
      logSessions: server.logSessions,
      dataVersion: logScan.dataVersion,
    };
  } catch (e) {
    lastFetchErrorMessage = e && e.message ? e.message : String(e);
    return null;
  }
}

async function main() {
  // TRDD-PQ40PZ9D: transcripts-mode runtime guard — refuse to write anywhere the live corpus
  // could be polluted. Subtree checks, not just equality: --transcripts-home ~/.claude/projects
  // would pass an equality check yet its files match the live sweeper's
  // ~/.claude/projects/**/*.jsonl glob. os.userInfo().homedir (the passwd entry), NOT
  // os.homedir() (follows $HOME) — an isolated instance is routinely launched with
  // HOME=<scratch>, which would make os.homedir() compare against the wrong directory and let
  // the guard miss the hit. Runs BEFORE the first fetchSnapshot and before any worker starts.
  if (args.mix === 'transcripts') {
    const REAL_HOME = realpathOrResolve(os.userInfo().homedir);
    const realClaude = realpathOrResolve(path.join(REAL_HOME, '.claude'));
    const resolvedHome = realpathOrResolve(args.transcriptsHome);
    if (
      resolvedHome === realClaude || resolvedHome.startsWith(realClaude + path.sep)
      || resolvedHome === REAL_HOME || resolvedHome.startsWith(REAL_HOME + path.sep)
      || resolvedHome === '/'
    ) {
      console.error(`refusing: --transcripts-home ${args.transcriptsHome} is the real home (or its .claude); pass an isolated scratch home`);
      process.exit(2);
    }
    // Bootstrap the fixed bench project dir + one file per current session-window id; the
    // worker lazily ensures files for session ids the window grows into.
    for (const s of sessionWindow) ensureTranscriptFile(args.transcriptsHome, s);
    // Symlink ceiling: the lexical resolve() above passes on a nonexistent scratch leaf, but a
    // symlinked home could write through into the real tree — after the bootstrap mkdir,
    // re-resolve and refuse if it resolves into the real home or its .claude.
    const resolvedAfterMkdir = realpathOrResolve(args.transcriptsHome);
    if (resolvedAfterMkdir !== resolvedHome) {
      if (
        resolvedAfterMkdir === realClaude || resolvedAfterMkdir.startsWith(realClaude + path.sep)
        || resolvedAfterMkdir === REAL_HOME || resolvedAfterMkdir.startsWith(REAL_HOME + path.sep)
        || resolvedAfterMkdir === '/'
      ) {
        console.error(`refusing: --transcripts-home ${args.transcriptsHome} resolves (symlink) into the real home; pass an isolated scratch home`);
        process.exit(2);
      }
    }
  }
  // Item 5/7 read #1: the FIRST /api/server-stats read doubles as the live-dataDir check below —
  // no separate probe GET, so a refusal never needed to have sent one either.
  let before = await fetchSnapshot(args.uiPort);
  if (!before) {
    // N2: name WHY the read failed (connection refused, timeout, bad JSON), not just that it did.
    console.error(`tool error: initial /api/server-stats + /api/debug/log-scan-stats read failed: ${lastFetchErrorMessage}`);
    process.exit(1);
  }

  // LIVE-DATA-DIR REFUSAL (item 7, half 2) — a --ui-port/--otlp-port pair that is not the
  // canonical 3000/4318 can still have been pointed at the live collector's OWN data dir (it was
  // reconfigured, or the ports were typo'd past the half-1 check), so the real guard is on the
  // dataDir the server itself reports, not on the ports we dialled. absent dataDir → warn and
  // continue rather than refuse: an older alcore build that never shipped that field must not be
  // mistaken for "definitely live".
  if (!args.allowLive) {
    if (before.dataDir) {
      // os.userInfo().homedir (the passwd entry), not os.homedir() (follows $HOME) — an operator
      // launching an isolated instance routinely exports HOME to its own scratch dir, which would
      // make os.homedir() compare the live-dir guard against the wrong directory and miss the hit.
      const liveDir = realpathOrResolve(path.join(os.userInfo().homedir, '.agentlens'));
      if (realpathOrResolve(before.dataDir) === liveDir) {
        console.error(`refusing: target dataDir (${before.dataDir}) is the live collector's; pass --allow-live to override`);
        process.exit(2);
      }
    } else {
      console.error('warning: /api/server-stats reported no dataDir; cannot verify the target is not live, continuing');
    }
  }

  let lastGood = before;
  // N1: whether ANY progress tick's snapshot succeeded — if none did AND the final read also
  // fails, `after` never moves past `before` and every delta below must be null, not a false 0.
  let tickSucceeded = false;
  const agentOtlp = new http.Agent({ keepAlive: true, maxSockets: args.concurrency });
  const agentUi = new http.Agent({ keepAlive: true, maxSockets: args.concurrency });
  const counters = { requests: 0, ok: 0, bad: 0, lat: { otlp: [], hooks: [], statusline: [], transcripts: [] } };
  // lat.transcripts: append latency is fs-shaped, not http-shaped — its own bucket so the
  // percentiles of the http kinds stay meaningful (latencySummary handles any array).
  const started = Date.now();
  const state = { started, deadline: started + args.seconds * 1000, stopped: false, failCount: 0, failStartMs: null, targetDownAtSec: null };

  // --rate targets total requests/s directly (any mix, incl. statusline, which --sessions/
  // --spans-per-session cannot express — those only ever meant OTLP spans/s). --rate takes
  // precedence (rejected with --mix transcripts); the legacy --sessions lane is unchanged when
  // --rate is absent (item 2). TRDD-PQ40PZ9D: transcripts mode reuses this SAME machinery —
  // --lines-per-sec IS the total lines/s across all workers, paced exactly like --rate, so the
  // shared loop's stagger/deadline/behind-schedule logic applies unchanged. In this mode
  // reqPerSec/ok2xx count FILE APPENDS (not http posts); underRate means "appends under
  // target"; and targetDownAtSec means the append target (fs) went down.
  let targetReqPerSec = 0;
  let paceMsPerReq = 0;
  if (args.mix === 'transcripts') {
    targetReqPerSec = args.linesPerSec;
    paceMsPerReq = (1000 * args.concurrency) / args.linesPerSec;
  } else if (args.rate > 0) {
    targetReqPerSec = args.rate;
    paceMsPerReq = (1000 * args.concurrency) / args.rate;
  } else {
    const targetSpans = targetSpansPerSec();
    paceMsPerReq = targetSpans > 0 ? (1000 * args.spansPerRequest * args.concurrency) / targetSpans : 0;
  }

  // --new-session-every: grows the sliding session window on a timer, independent of request
  // pacing (item 4).
  const sessionTimer = args.newSessionEvery > 0
    ? setInterval(growSessionWindow, args.newSessionEvery * 1000)
    : null;

  // Progress ticks (item 5): one stderr line + a fresh stats snapshot every --progress-sec, so a
  // multi-minute soak's operator (and the after-the-fact log) sees it is still moving, and so a
  // snapshot survives even when the FINAL /api/server-stats read happens to fail.
  const progressTimer = setInterval(async () => {
    const snap = await fetchSnapshot(args.uiPort);
    if (snap) {
      lastGood = snap;
      tickSucceeded = true;
    }
    const elapsedSoFar = ((Date.now() - started) / 1000).toFixed(0);
    // N3: pid + the two counters this bench cares about most, straight from the fresh snapshot
    // (falling back to the last good one when this tick's own GET failed).
    const s = snap ?? lastGood;
    // stale=true when THIS tick's own GET failed and we fell back to lastGood — otherwise the
    // printed pid/counters look like a fresh read when they may be a whole progressSec old.
    const staleSuffix = snap ? '' : ' stale=true';
    console.error(`[progress] mix=${args.mix} elapsed=${elapsedSoFar}s requests=${counters.requests} ok=${counters.ok} bad=${counters.bad} pid=${s.pid} statuslineReceived=${s.statuslineReceived} spansTotal=${s.spansTotal}${staleSuffix}`);
  }, Math.max(1, args.progressSec) * 1000);

  const workers = Array.from(
    { length: args.concurrency },
    (_, i) => worker(i, agentOtlp, agentUi, state, args.mix, counters, paceMsPerReq),
  );
  await Promise.all(workers);

  clearInterval(progressTimer);
  if (sessionTimer) clearInterval(sessionTimer);

  const elapsedSec = (Date.now() - started) / 1000;
  // Item 5: the after-read may itself fail — fall back to the last good snapshot (a progress tick,
  // or `before` if the run was shorter than one tick) rather than crashing a run that otherwise
  // completed cleanly.
  const finalSnap = await fetchSnapshot(args.uiPort);
  // N1: deltaBasis names WHICH read the deltas below rest on, so a caller can tell "the run
  // genuinely produced these numbers" (final/tick) from "the target never answered again after
  // `before`, so every delta is a null, not a manufactured zero" (before).
  const deltaBasis = finalSnap ? 'final' : tickSucceeded ? 'tick' : 'before';
  const after = finalSnap ?? lastGood;

  // Item 5 remainder: a pid change between `before` and whichever snapshot the deltas are taken
  // against means the target was RESTARTED mid-run — every delta spanning that restart is
  // meaningless (the counters reset to 0 on the new process), so it is reported null, never a
  // negative or nonsensical number.
  const revived = before.pid !== after.pid;
  const delta = (field) => (revived || deltaBasis === 'before' ? null : after[field] - before[field]);

  const achievedReqPerSec = counters.requests / elapsedSec;
  // N4: attempts vs 2xx-only, so underRate is judged against what the server actually accepted,
  // not against a rate a 429/503 flood could satisfy while still failing every request.
  const achievedOkPerSec = counters.ok / elapsedSec;
  const result = {
    mix: args.mix,
    concurrency: args.concurrency,
    seconds: elapsedSec,
    requests: counters.requests,
    reqPerSec: counters.requests / elapsedSec,
    ok2xx: counters.ok,
    nonOk: counters.bad,
    targetReqPerSec,
    targetSpansPerSec: args.rate > 0 ? null : targetSpansPerSec(),
    paceMsPerReq,
    achievedReqPerSec,
    achievedOkPerSec,
    underRate: targetReqPerSec > 0 && achievedOkPerSec < 0.95 * targetReqPerSec,
    sessionsModelled: args.sessions || null,
    latencyMs: {
      otlp: latencySummary(counters.lat.otlp),
      hooks: latencySummary(counters.lat.hooks),
      transcripts: latencySummary(counters.lat.transcripts),
    },
    statuslineBodyBytesMean: statuslineBodyBytes.count > 0 ? statuslineBodyBytes.total / statuslineBodyBytes.count : null,
    spansAppendedDelta: delta('spansTotal'),
    hookEventsReceivedDelta: delta('hookReceived'),
    statuslineReceivedDelta: delta('statuslineReceived'),
    statuslinePersistedDelta: delta('statuslinePersisted'),
    summaryMissesDelta: delta('summaryMisses'),
    logSessionsDelta: delta('logSessions'),
    dataVersionDelta: delta('dataVersion'),
    revived,
    deltaBasis,
    targetDownAtSec: state.targetDownAtSec,
    deltasAsOfSec: (after.ts - started) / 1000,
  };
  console.log(JSON.stringify(result));
  agentOtlp.destroy();
  agentUi.destroy();
  // Exit 3 (not 0) when the arm ended early on target-down, so a caller scripting several arms
  // can tell "ran the full duration" from "the target went down mid-arm" without parsing JSON.
  process.exit(state.stopped ? 3 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
