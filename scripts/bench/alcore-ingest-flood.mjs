#!/usr/bin/env node
// Load generator for TRDD-HFV4AIT7: floods alcore's OTLP + hook-events endpoints at
// concurrency for a fixed duration, then reports request throughput and the
// server-side counter delta (spans_appended / hook receivedSinceBoot).
//
// No deps — plain Node http, keep-alive agents.
import http from 'node:http';

/** Per-request ceiling. Above this the server is not "slow", it is not answering — and the run
 *  must still terminate and report that. */
const REQUEST_TIMEOUT_MS = Number(process.env.BENCH_REQUEST_TIMEOUT_MS) || 10_000;

function parseArgs(argv) {
  const out = { otlpPort: 4901, uiPort: 3901, seconds: 30, concurrency: 32, mix: 'both', sessions: 0, spansPerSession: 26 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--otlp-port') out.otlpPort = Number(next());
    else if (a === '--ui-port') out.uiPort = Number(next());
    else if (a === '--seconds') out.seconds = Number(next());
    else if (a === '--concurrency') out.concurrency = Number(next());
    else if (a === '--mix') out.mix = next();
    // Sessions, not raw throughput. The USER's question is "many Claude Code sessions in
    // parallel", and a flat-out flood answers a different one: it runs ~6,250x this machine's
    // measured 26 spans/s peak, which manufactures allocator behaviour no fleet produces.
    else if (a === '--sessions') out.sessions = Number(next());
    else if (a === '--spans-per-session') out.spansPerSession = Number(next());
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SESSION_IDS = Array.from({ length: 16 }, (_, i) => `bench-session-${i.toString(16).padStart(4, '0')}`);
const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

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

function makeOtlpBody() {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const spans = [];
  for (let i = 0; i < 20; i++) {
    const session = SESSION_IDS[Math.floor(Math.random() * SESSION_IDS.length)];
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
  const session = SESSION_IDS[Math.floor(Math.random() * SESSION_IDS.length)];
  const evName = Math.random() < 0.5 ? 'PreToolUse' : 'PostToolUse';
  return JSON.stringify({
    hook_event_name: evName,
    session_id: session,
    tool_name: 'Bash',
    tool_input: { command: 'echo bench' },
    cwd: '/tmp/al-bench-data',
  });
}

function post(agent, port, path, body) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', agent, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
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
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function pick(mix) {
  if (mix === 'otlp') return 'otlp';
  if (mix === 'hooks') return 'hooks';
  return Math.random() < 0.5 ? 'otlp' : 'hooks';
}

/** Target spans/sec across the whole run, or 0 for flat-out. `--sessions N` models N Claude Code
 *  sessions each emitting `--spans-per-session` spans/sec (default 26, this machine's measured
 *  peak for ONE session). */
function targetSpansPerSec() {
  return args.sessions > 0 ? args.sessions * args.spansPerSession : 0;
}

async function worker(agentOtlp, agentUi, deadline, mix, counters, paceMsPerReq) {
  let nextAt = Date.now();
  while (Date.now() < deadline) {
    if (paceMsPerReq > 0) {
      nextAt += paceMsPerReq;
      const wait = nextAt - Date.now();
      // Behind schedule: do not try to catch up, or a stall becomes a burst that measures
      // something the fleet would never do.
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      else nextAt = Date.now();
    }
    const kind = pick(mix);
    const t0 = performance.now();
    const status = kind === 'otlp'
      ? await post(agentOtlp, args.otlpPort, '/v1/traces', makeOtlpBody())
      : await post(agentUi, args.uiPort, '/api/hook-events', makeHookBody());
    // Per-kind, because the question this bench answers is about ONE route:
    // hookHandlers.ts spools only when the POST fails, and its failure threshold is
    // the AGENTLENS_HOOK_TIMEOUT (1000 ms default). So "does the spool fill?" is
    // "does /api/hook-events p99 stay under 1 s?" — an aggregate percentile mixed
    // with /v1/traces would not answer it.
    const elapsed = performance.now() - t0;
    counters.requests++;
    if (status >= 200 && status < 300) {
      counters.ok++;
      // ONLY successful requests enter the percentiles. `post` resolves 0 on a socket error,
      // and a connection refused returns in ~0.1 ms — so timing failures alongside successes
      // makes p99 IMPROVE as the server degrades, which is exactly backwards for a threshold
      // check. Failures are counted separately; a run with nonOk > 0 has no valid percentile.
      counters.lat[kind].push(elapsed);
    } else {
      counters.bad++;
    }
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

async function main() {
  const statsBefore = await getJson(args.uiPort, '/api/server-stats');
  const agentOtlp = new http.Agent({ keepAlive: true, maxSockets: args.concurrency });
  const agentUi = new http.Agent({ keepAlive: true, maxSockets: args.concurrency });
  const counters = { requests: 0, ok: 0, bad: 0, lat: { otlp: [], hooks: [] } };
  const deadline = Date.now() + args.seconds * 1000;
  const started = Date.now();
  const target = targetSpansPerSec();
  // 20 spans per OTLP payload (makeOtlpBody), divided across the worker pool.
  const paceMsPerReq = target > 0 ? (1000 * 20 * args.concurrency) / target : 0;
  const workers = Array.from({ length: args.concurrency }, () => worker(agentOtlp, agentUi, deadline, args.mix, counters, paceMsPerReq));
  await Promise.all(workers);
  const elapsedSec = (Date.now() - started) / 1000;
  const statsAfter = await getJson(args.uiPort, '/api/server-stats');

  const result = {
    mix: args.mix,
    concurrency: args.concurrency,
    targetSpansPerSec: target,
    sessionsModelled: args.sessions || null,
    seconds: elapsedSec,
    requests: counters.requests,
    reqPerSec: counters.requests / elapsedSec,
    ok2xx: counters.ok,
    nonOk: counters.bad,
    latencyMs: {
      otlp: latencySummary(counters.lat.otlp),
      hooks: latencySummary(counters.lat.hooks),
    },
    spansAppendedDelta: statsAfter.spans.store.totalSpans - statsBefore.spans.store.totalSpans,
    hookEventsReceivedDelta: statsAfter.hookEvents.receivedSinceBoot - statsBefore.hookEvents.receivedSinceBoot,
  };
  console.log(JSON.stringify(result));
  agentOtlp.destroy();
  agentUi.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
