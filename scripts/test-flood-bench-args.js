#!/usr/bin/env node
// Regression test for the live-target refusals and the argument validation of
// scripts/bench/alcore-ingest-flood.mjs (TRDD-C19SUVPH). Pins three guards:
//  - the live-PORT refusal (--ui-port 3000 / --otlp-port 4318), checked before any http call;
//  - the live-DATADIR refusal: the dataDir the server itself reports (realpath on both sides)
//    must not be the passwd home's ~/.agentlens, checked before any POST;
//  - the bad-argument exits (exit 2, "bad arguments: ...", zero requests).
//
// FAKE SERVER: the stats endpoints below are answered by a stand-in http server in this process,
// not by alcore. That is deliberate: a real alcore cannot report the live ~/.agentlens as its data
// dir (its pid lock enforces one owner per data dir), so the dataDir refusal is untestable against
// it. D3/D4 check the bench gate only, not alcore; the end-to-end rate check is Part 2 of
// TRDD-C19SUVPH, against a real alcore.
//
// SAFETY: every case that names port 3000 or 4318 passes --mix statusline and points the OTHER
// port at the fake, so even a regressed guard can only reach the fake or do a read-only GET.
// The bench is spawned asynchronously: a spawnSync would block this event loop and the fake
// server could never answer.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const BENCH = path.join(__dirname, "bench", "alcore-ingest-flood.mjs");
const SPAWN_TIMEOUT_MS = 30_000;
const REAL_HOME = os.userInfo().homedir;
const LIVE_DIR = path.join(REAL_HOME, ".agentlens");
const PORT_REFUSAL = "--ui-port 3000 or --otlp-port 4318 targets the live collector";
const NO_DATADIR_WARNING = "warning: /api/server-stats reported no dataDir; cannot verify the target is not live, continuing";

// Fake stats server: the minimal response shape fetchSnapshot needs (measure report section 4).
// dataDir is set per case; undefined means the key is omitted (D4).
const fake = { dataDir: undefined, log: [] };
function serverStats() {
  const body = {
    pid: 1,
    spans: { store: { totalSpans: 0 } },
    hookEvents: { receivedSinceBoot: 0 },
    statusline: { receivedSinceBoot: 0 },
    persistence: { statuslineSamples: 0 },
    logSessions: 0,
  };
  if (fake.dataDir !== undefined) body.dataDir = fake.dataDir;
  return body;
}
function startFake() {
  const srv = http.createServer((req, res) => {
    fake.log.push({ method: req.method, url: req.url });
    req.resume();
    req.on("end", () => {
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && req.url === "/api/server-stats") send(200, serverStats());
      else if (req.method === "GET" && req.url === "/api/debug/log-scan-stats") send(200, { derivedCaches: { summary: { misses: 0 } }, dataVersion: 0 });
      else if (req.method === "POST" && req.url === "/api/statusline-samples") send(200, {});
      else send(404, {});
    });
  });
  return new Promise((resolve, reject) => {
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BENCH, ...args], {
      stdio: ["ignore", "pipe", "pipe"], timeout: SPAWN_TIMEOUT_MS, killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    let error;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { error = e; });
    child.on("close", (status) => resolve({ status, stdout, stderr, error }));
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    const done = (occupied) => { s.destroy(); resolve(occupied); };
    s.setTimeout(1000, () => done(true));
    s.on("connect", () => done(true));
    s.on("error", (e) => done(e.code !== "ECONNREFUSED"));
  });
}


function fetchDataDir(port) {
  return new Promise((resolve, reject) => {
    const fail = (e) => { clearTimeout(timer); reject(e); };
    const timer = setTimeout(() => req.destroy(new Error("hard timeout 3 s")), 3000);
    const req = http.get({ host: "127.0.0.1", port, path: "/api/server-stats", timeout: 2000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; });
      res.on("error", fail);
      res.on("aborted", () => fail(new Error("response aborted")));
      res.on("end", () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body).dataDir); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout after 2 s")));
    req.on("error", fail);
  });
}

// WHY: the gate must reach the same verdict as the bench realpathOrResolve, because `.native`
// case-canonicalizes on APFS while JS realpathSync keeps the given spelling, so each side is
// resolved independently with the JS call and falls back to path.resolve only for that side.
function sameDir(a, b) {
  const resolveDir = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return resolveDir(a) === resolveDir(b);
}

// WHY: P2 sends real requests to whatever listens on 3000. Its dataDir gate is the only backstop
// if the port guard regresses, and that backstop covers only a server whose reported dataDir is
// the live ~/.agentlens. So P2 runs only when nothing listens on 3000 or the server there reports
// the live dataDir; otherwise the caller prints a skip carrying the returned reason.
async function p2Gate() {
  if (!(await probePort(3000))) return null;
  let reported;
  try {
    reported = await fetchDataDir(3000);
  } catch (e) {
    return `server on 3000 did not answer /api/server-stats: ${e.message}; the dataDir backstop cannot be checked`;
  }
  if (typeof reported !== "string") return "server on 3000 reports no dataDir; the dataDir backstop cannot be checked";
  if (sameDir(reported, LIVE_DIR)) return null;
  return `server on 3000 reports dataDir ${reported}, not ~/.agentlens; the dataDir backstop would not cover it`;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  return ok;
}
function skip(line) {
  results.push({ name: line, skipped: true });
  console.log(`SKIP  ${line}`);
}
function brief(r) {
  // Bounded: a regressed flood can log thousands of requests; the first few plus the count suffice.
  const reqs = `${fake.log.length} requests ${JSON.stringify(fake.log.slice(0, 4))}${fake.log.length > 4 ? "..." : ""}`;
  return `exit=${r.status}${r.error ? ` spawnError=${r.error.message}` : ""} stderr=${JSON.stringify(r.stderr.slice(0, 400))} ${reqs}`;
}
const posts = () => fake.log.filter((x) => x.method === "POST").length;
const statuslinePosts = () => fake.log.filter((x) => x.method === "POST" && x.url === "/api/statusline-samples").length;
const isDataDirRefusal = (r) => r.status === 2 && r.stderr.includes("refusing: target dataDir (") && r.stderr.includes("is the live collector");


async function main() {
  const srv = await startFake();
  const F = String(srv.address().port);
  const SCR = fs.mkdtempSync(path.join(os.tmpdir(), "flood-bench-args-"));
  const agl = path.join(SCR, "agl");
  async function rcase(dataDir, args) {
    fake.dataDir = dataDir;
    fake.log = [];
    return run(args);
  }
  const statusline = ["--mix", "statusline", "--rate", "1", "--seconds", "1"];
  try {
    // D1: the server reports the literal passwd-home ~/.agentlens.
    const d1 = await rcase(LIVE_DIR, [...statusline, "--ui-port", F, "--otlp-port", F]);
    const d1ok = record("D1  server-reported dataDir = ~/.agentlens refuses, 0 POST",
      isDataDirRefusal(d1) && posts() === 0, brief(d1));

    // P1: --otlp-port 4318 refused before any http call (dataDir = live as a second backstop).
    const p1 = await rcase(LIVE_DIR, [...statusline, "--ui-port", F, "--otlp-port", "4318"]);
    record("P1  --otlp-port 4318 refuses, 0 requests",
      p1.status === 2 && p1.stderr.includes(PORT_REFUSAL) && fake.log.length === 0 && !p1.stderr.includes("read failed"), brief(p1));

    // P2: --ui-port 3000. Only after D1 proved the dataDir backstop holds, since a regressed port
    // guard would GET the live collector stats (read-only) and rely on that backstop. Also only when
    // p2Gate finds nothing on 3000 or a server there reporting the live dataDir (see p2Gate).
    if (!d1ok) {
      record("P2  --ui-port 3000 refuses", false, "not run: D1 failed, the dataDir backstop is unproven");
    } else {
      const gate = await p2Gate();
      if (gate) {
        skip(`P2 (${gate})`);
      } else {
        const p2 = await rcase(LIVE_DIR, [...statusline, "--ui-port", "3000", "--otlp-port", F]);
        record("P2  --ui-port 3000 refuses, 0 requests",
          p2.status === 2 && p2.stderr.includes(PORT_REFUSAL) && fake.log.length === 0 && !p2.stderr.includes("read failed"), brief(p2));
      }
    }

    // P3: --allow-live lifts the port refusal; with nothing on 3000 the first read fails ECONNREFUSED.
    // CI only: --allow-live bypasses BOTH gates, so a collector binding 3000 between the probe and
    // the run would receive POSTs. On a developer machine that window is real; on a CI runner no
    // collector runs.
    if (!d1ok) {
      record("P3  --allow-live passes the port guard", false, "not run: D1 failed, the dataDir backstop is unproven");
    } else if (!process.env.CI) {
      skip("P3 (CI only: --allow-live bypasses both gates; runs on CI)");
    } else if (await probePort(3000)) {
      skip("P3 (port 3000 occupied by a live server; runs on CI)");
    } else {
      const p3 = await rcase(LIVE_DIR, ["--allow-live", ...statusline, "--ui-port", "3000", "--otlp-port", F]);
      record("P3  --allow-live passes the port guard (ECONNREFUSED on free 3000)",
        p3.status === 1 && p3.stderr.includes("ECONNREFUSED"), brief(p3));
    }

    // D2: a symlink spelling of ~/.agentlens must still refuse (realpath on the server side).
    if (fs.existsSync(LIVE_DIR)) {
      fs.symlinkSync(LIVE_DIR, agl);
      const d2 = await rcase(agl, [...statusline, "--ui-port", F, "--otlp-port", F]);
      record("D2  symlink to ~/.agentlens refuses, 0 POST", isDataDirRefusal(d2) && posts() === 0, brief(d2));
    } else {
      skip("D2 (no ~/.agentlens on this machine to link to)");
    }

    // D3: positive control, a scratch dataDir is not refused and the flood posts.
    const dd = path.join(SCR, "dd");
    fs.mkdirSync(dd);
    const d3 = await rcase(dd, [...statusline, "--ui-port", F, "--otlp-port", F]);
    record("D3  scratch dataDir is accepted and posts",
      !d3.stderr.includes("refusing:") && statuslinePosts() >= 1, brief(d3));

    // D4: no dataDir reported warns and continues.
    const d4 = await rcase(undefined, [...statusline, "--ui-port", F, "--otlp-port", F]);
    record("D4  absent dataDir warns and continues",
      d4.stderr.includes(NO_DATADIR_WARNING) && !d4.stderr.includes("refusing:") && statuslinePosts() >= 1, brief(d4));

    // B1..B10: bad flags (measure report section 8). The base args come first so each case flag
    // overrides them; --seconds 1 bounds the run if a mutation removes a validation.
    const bad = [
      ["B1  --rate \"\"", ["--rate", ""], "bad arguments: invalid value for --rate: \"\""],
      ["B2  --rate 0", ["--rate", "0"], "bad arguments: --rate must be > 0 when given"],
      ["B3  --spans-per-request 0", ["--spans-per-request", "0"], "bad arguments: --spans-per-request must be an integer >= 1"],
      ["B4  --concurrency 2.5", ["--concurrency", "2.5"], "bad arguments: --concurrency must be an integer"],
      ["B5  constructor 1", ["constructor", "1"], "bad arguments: unknown flag: constructor; unknown flag: 1"],
      ["B6  --bogus", ["--bogus"], "bad arguments: unknown flag: --bogus"],
      ["B7  --mix bogus", ["--mix", "bogus"], "bad arguments: --mix must be one of otlp,hooks,both,statusline,transcripts, got \"bogus\""],
      ["B8  --subagent-share 2", ["--subagent-share", "2"], "bad arguments: --subagent-share must be within [0,1]"],
      ["B9  --sessions -1", ["--sessions", "-1"], "bad arguments: invalid value for --sessions: \"-1\""],
      ["B10 --ui-port 70000", ["--ui-port", "70000"], "bad arguments: --ui-port must be an integer in 1-65535"],
    ];
    for (const [name, flags, line] of bad) {
      const r = await rcase(path.join(SCR, "dd"), ["--mix", "statusline", "--seconds", "1", "--ui-port", F, "--otlp-port", F, ...flags]);
      record(name, r.status === 2 && r.stderr.includes("bad arguments") && r.stderr.includes(line) && fake.log.length === 0, brief(r));
    }
  } finally {
    // SAFETY: the link into the real ~/.agentlens is unlinked FIRST, by name, so the recursive
    // removal below can never reach the live data through it. rmSync never follows a symlink.
    try {
      if (fs.lstatSync(agl).isSymbolicLink()) fs.unlinkSync(agl);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    fs.rmSync(SCR, { recursive: true, force: true });
    // Close any keep-alive sockets the bench left open first, so close() cannot wait on them.
    srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve));
  }

  const skipped = results.filter((x) => x.skipped).length;
  const failed = results.filter((x) => !x.skipped && !x.ok).length;
  console.log(`${results.length - skipped - failed} passed, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
