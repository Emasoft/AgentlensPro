#!/usr/bin/env node
// Regression test for the --mix transcripts write guard of scripts/bench/alcore-ingest-flood.mjs
// (TRDD-PQ40PZ9D). The bench appends synthetic JSONL under --transcripts-home; it must refuse,
// with NOTHING written, any home that lands inside the real home or its .claude. The bug this
// pins: the writer builds paths with path.join (".." collapsed by TEXT), while the old pre-write
// check fell back to path.resolve for a nonexistent leaf and never followed an ancestor symlink,
// so LINK/zz (LINK -> protected root) wrote 16 files before the post-mkdir check refused.
//
// The end-to-end cases never touch the real home: BENCH_TEST_EXTRA_PROTECTED_ROOT makes a
// scratch dir (SCR/PROXY) a protected root, and the cases write (or must not write) around it.
// The real-home cases all pass --guard-only, which exits right after the guard and writes nothing.
// No server is started: an accepted home reaches the first http read and fails ECONNREFUSED
// (exit 1), which is how a "the guard let it through" case is told apart from a refusal (exit 2).
//
// Why each case exists:
//  a  link into the protected root plus a nonexistent leaf: the original bug.
//  b  ".." after a link INSIDE the protected root: path.join writes PROXY/zz, so it must refuse.
//  c  ".." after a link pointing INTO the protected root: path.join writes SCR/zz, outside it, so
//     it must be accepted (refusing it would mean the guard judges a path the writer never uses).
//  d  dangling symlink ancestor: cannot be resolved, so it must refuse.
//  e  darwin only: case-variant spelling of the protected root on a case-insensitive volume.
//  f  positive control: a plain scratch home is written (16 files) and reaches ECONNREFUSED.
//  g  a missing BENCH_TEST_EXTRA_PROTECTED_ROOT must refuse, never silently drop the extra root.
//  h  --guard-only accepts a plain scratch home and creates nothing (the seam works).
//  i-o --guard-only against the REAL home, its .claude, a nonexistent child, "/", links to the
//     real home and its .claude, and a ".." spelling (regression check only): all refuse.
//  p  --guard-only without --mix transcripts is an argument error.
//  q  an EMPTY BENCH_TEST_EXTRA_PROTECTED_ROOT must refuse too, never be dropped as falsy.
"use strict";

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const BENCH = path.join(__dirname, "bench", "alcore-ingest-flood.mjs");
const SPAWN_TIMEOUT_MS = 30_000;
const BOOTSTRAP_FILES = 16;

// Both listeners stay open until both ports are read, so the kernel cannot hand out the same
// port twice (two sequential listen(0)+close calls could).
async function freePorts() {
  const open = () => new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const servers = [await open(), await open()];
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  return ports;
}

// Regular files under dir, found with lstat semantics (Dirent types never follow a symlink),
// the equivalent of `find -P dir -type f`: PROXY/toS -> S must not count S as PROXY.
function countFiles(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
  if (!st.isDirectory()) return st.isFile() ? 1 : 0;
  let n = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) n += countFiles(p);
    else if (ent.isFile()) n += 1;
  }
  return n;
}

function rand() {
  return `flood-guard-nonexistent-${crypto.randomBytes(6).toString("hex")}`;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  return ok;
}

async function main() {
  const [uiPort, otlpPort] = await freePorts();
  const baseEnv = { ...process.env };
  delete baseEnv.BENCH_TEST_EXTRA_PROTECTED_ROOT;

  function run(extraArgs, env) {
    const r = spawnSync(process.execPath, [BENCH, ...extraArgs], {
      env, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS,
    });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error };
  }
  function transcripts(home, env, more = []) {
    return run([
      "--mix", "transcripts", "--seconds", "1", "--new-session-every", "0",
      "--ui-port", String(uiPort), "--otlp-port", String(otlpPort),
      "--transcripts-home", home, ...more,
    ], env);
  }
  function brief(r) {
    return `exit=${r.status}${r.error ? ` spawnError=${r.error.message}` : ""} stderr=${JSON.stringify(r.stderr.slice(0, 400))} stdout=${JSON.stringify(r.stdout.slice(0, 200))}`;
  }
  function isRefusal(r, part) {
    return r.status === 2 && r.stderr.includes("refusing:") && r.stderr.includes(part);
  }
  function isConnRefused(r) {
    return r.status === 1 && r.stderr.includes("ECONNREFUSED");
  }

  const SCR = fs.mkdtempSync(path.join(os.tmpdir(), "flood-guard-"));
  const PROXY = path.join(SCR, "PROXY");
  const S = path.join(SCR, "S");
  const linkHome = path.join(SCR, "linkHome");
  const linkClaude = path.join(SCR, "linkClaude");
  try {
    fs.mkdirSync(PROXY);
    fs.mkdirSync(path.join(PROXY, "sub"));
    fs.mkdirSync(S);
    fs.symlinkSync(PROXY, path.join(SCR, "linkP"));
    fs.symlinkSync(S, path.join(PROXY, "toS"));
    fs.symlinkSync(path.join(PROXY, "sub"), path.join(SCR, "linkSub"));
    fs.symlinkSync(path.join(SCR, "nowhere"), path.join(SCR, "dang"));
    const proxyEnv = { ...baseEnv, BENCH_TEST_EXTRA_PROTECTED_ROOT: PROXY };
    // a, b and e must name PROXY itself as the hit root, not just "protected root": a TMPDIR under
    // the real home would otherwise pass them because of REAL_HOME, proving nothing about PROXY.
    const PROXY_HIT = `protected root ${fs.realpathSync.native(PROXY)};`;

    // A refusal case: exit 2 with the expected message, and zero new files under PROXY.
    function refusedNoWrite(name, home, part) {
      const before = countFiles(PROXY);
      const r = transcripts(home, proxyEnv);
      const after = countFiles(PROXY);
      return record(name, isRefusal(r, part) && after === before,
        `${brief(r)} proxyFiles ${before}->${after}`);
    }

    let e2eOk = true;
    e2eOk = refusedNoWrite("a  link into protected root + nonexistent leaf", path.join(SCR, "linkP", "zz"), PROXY_HIT) && e2eOk;
    e2eOk = refusedNoWrite("b  link inside protected root, then ..", `${PROXY}/toS/../zz`, PROXY_HIT) && e2eOk;
    {
      const before = countFiles(PROXY);
      const r = transcripts(`${SCR}/linkSub/../zz`, proxyEnv);
      const after = countFiles(PROXY);
      const zz = countFiles(path.join(SCR, "zz"));
      e2eOk = record("c  link into protected root, then .. (lands outside)", isConnRefused(r) && after === before && zz === BOOTSTRAP_FILES,
        `${brief(r)} proxyFiles ${before}->${after} scrZzFiles=${zz}`) && e2eOk;
    }
    e2eOk = refusedNoWrite("d  dangling symlink ancestor", path.join(SCR, "dang", "zz"), "dangling") && e2eOk;
    if (process.platform === "darwin") {
      e2eOk = refusedNoWrite("e  case-variant spelling of protected root (darwin)", `${PROXY.toUpperCase()}/zz`, PROXY_HIT) && e2eOk;
    } else {
      console.log("SKIP  e  case-variant spelling of protected root (darwin only)");
    }
    {
      const h1 = path.join(SCR, "h1");
      const r = transcripts(h1, proxyEnv);
      const n = countFiles(h1);
      e2eOk = record("f  positive control: plain scratch home is written", isConnRefused(r) && n === BOOTSTRAP_FILES,
        `${brief(r)} h1Files=${n}`) && e2eOk;
    }
    {
      const h3 = path.join(SCR, "h3");
      const r = transcripts(h3, { ...baseEnv, BENCH_TEST_EXTRA_PROTECTED_ROOT: path.join(SCR, "missing") });
      e2eOk = record("g  missing BENCH_TEST_EXTRA_PROTECTED_ROOT refuses",
        isRefusal(r, "BENCH_TEST_EXTRA_PROTECTED_ROOT") && r.stderr.includes("does not exist") && !fs.existsSync(h3),
        `${brief(r)} h3Exists=${fs.existsSync(h3)}`) && e2eOk;
    }
    {
      const h4 = path.join(SCR, "h4");
      const r = transcripts(h4, { ...baseEnv, BENCH_TEST_EXTRA_PROTECTED_ROOT: "" });
      e2eOk = record("q  empty BENCH_TEST_EXTRA_PROTECTED_ROOT refuses",
        isRefusal(r, "BENCH_TEST_EXTRA_PROTECTED_ROOT") && r.stderr.includes("does not exist") && !fs.existsSync(h4),
        `${brief(r)} h4Exists=${fs.existsSync(h4)}`) && e2eOk;
    }
    if (!e2eOk) {
      console.log("end-to-end proxy cases failed; NOT running the real-home cases");
      process.exitCode = 1;
      return;
    }

    {
      const h2 = path.join(SCR, "h2");
      const r = transcripts(h2, baseEnv, ["--guard-only"]);
      const ok = record("h  --guard-only accepts a plain scratch home, writes nothing",
        r.status === 0 && r.stdout.includes("guard-only:") && !fs.existsSync(h2),
        `${brief(r)} h2Exists=${fs.existsSync(h2)}`);
      if (!ok) {
        console.log("--guard-only seam failed; NOT running the real-home cases");
        process.exitCode = 1;
        return;
      }
    }

    const realHome = os.userInfo().homedir;
    fs.symlinkSync(realHome, linkHome);
    fs.symlinkSync(path.join(realHome, ".claude"), linkClaude);
    const realCases = [
      ["i  real home", realHome],
      ["j  real home/.claude", path.join(realHome, ".claude")],
      ["k  real home/<nonexistent>", path.join(realHome, rand())],
      ["l  /", "/"],
      ["m  link -> real home", linkHome],
      ["n  link -> real home/.claude", linkClaude],
      ["o  real home/<rand1>/../<rand2>", `${realHome}/${rand()}/../${rand()}`],
    ];
    for (const [name, home] of realCases) {
      const r = transcripts(home, baseEnv, ["--guard-only"]);
      record(name, isRefusal(r, "protected root"), brief(r));
    }
    {
      const r = run(["--guard-only", "--ui-port", String(uiPort), "--otlp-port", String(otlpPort)], baseEnv);
      record("p  --guard-only without --mix transcripts is an argument error",
        r.status === 2 && r.stderr.includes("--guard-only is only valid with --mix transcripts"), brief(r));
    }
  } finally {
    // SAFETY: the two links into the real home are unlinked FIRST, by name, so the recursive
    // removal below can never reach the real home through them. rmSync never follows a symlink.
    for (const l of [linkHome, linkClaude]) {
      try {
        if (fs.lstatSync(l).isSymbolicLink()) fs.unlinkSync(l);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    fs.rmSync(SCR, { recursive: true, force: true });
  }

  const failed = results.filter((x) => !x.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
