#!/usr/bin/env node
// Load generator for TRDD-HFV4AIT7: floods alcore's OTLP + hook-events endpoints at
// concurrency for a fixed duration, then reports request throughput and the
// server-side counter delta (spans_appended / hook receivedSinceBoot).
//
// No deps — plain Node http, keep-alive agents.
import http from 'node:http';

function parseArgs(argv) {
  const out = { otlpPort: 4901, uiPort: 3901, seconds: 30, concurrency: 32, mix: 'both' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--otlp-port') out.otlpPort = Number(next());
    else if (a === '--ui-port') out.uiPort = Number(next());
    else if (a === '--seconds') out.seconds = Number(next());
    else if (a === '--concurrency') out.concurrency = Number(next());
    else if (a === '--mix') out.mix = next();
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

async function worker(agentOtlp, agentUi, deadline, mix, counters) {
  while (Date.now() < deadline) {
    const kind = pick(mix);
    const status = kind === 'otlp'
      ? await post(agentOtlp, args.otlpPort, '/v1/traces', makeOtlpBody())
      : await post(agentUi, args.uiPort, '/api/hook-events', makeHookBody());
    counters.requests++;
    if (status >= 200 && status < 300) counters.ok++;
    else counters.bad++;
  }
}

async function main() {
  const statsBefore = await getJson(args.uiPort, '/api/server-stats');
  const agentOtlp = new http.Agent({ keepAlive: true, maxSockets: args.concurrency });
  const agentUi = new http.Agent({ keepAlive: true, maxSockets: args.concurrency });
  const counters = { requests: 0, ok: 0, bad: 0 };
  const deadline = Date.now() + args.seconds * 1000;
  const started = Date.now();
  const workers = Array.from({ length: args.concurrency }, () => worker(agentOtlp, agentUi, deadline, args.mix, counters));
  await Promise.all(workers);
  const elapsedSec = (Date.now() - started) / 1000;
  const statsAfter = await getJson(args.uiPort, '/api/server-stats');

  const result = {
    mix: args.mix,
    concurrency: args.concurrency,
    seconds: elapsedSec,
    requests: counters.requests,
    reqPerSec: counters.requests / elapsedSec,
    ok2xx: counters.ok,
    nonOk: counters.bad,
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
