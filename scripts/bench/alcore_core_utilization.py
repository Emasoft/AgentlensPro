#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Box-1 harness for TRDD-HFV4AIT7 (see design/tasks/TRDD-*-HFV4AIT7-*.md "Acceptance").

Drives the three load paths against an ISOLATED alcore instance (own --data-dir/--home/ports,
never the live :3000) and reports per-core utilisation + throughput for each:

  1. OTLP ingest       — reuses scripts/bench/alcore-ingest-flood.mjs --mix otlp
  2. Hook events        — reuses scripts/bench/alcore-ingest-flood.mjs --mix hooks
  3. Cold JSONL boot scan — boots a fresh alcore against --home (its .claude/projects corpus)
     with log-scan ON and measures cores-busy + wall time from launch to first-ready.

Per-core sampling is `ps -o %cpu=` snapshots (never `ps | grep` — the pid comes from the
data-dir's own server.pid, per pid_lock.rs's format). On macOS `%cpu` sums across threads, so
cores-busy == %cpu / 100 (the same convention scripts/bench/cpu-sample.sh already uses).

This script only ORCHESTRATES and MEASURES. It does not interpret PASS/FAIL (that is boxes 2/3
of the card) and it never touches the live collector — pass --data-dir/--home/--*-port pointing
at throwaway locations.
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FLOOD_SCRIPT = REPO_ROOT / "scripts" / "bench" / "alcore-ingest-flood.mjs"
DEFAULT_BINARY = REPO_ROOT / "rust-core" / "target" / "release" / "alcore"


def read_pidfile(data_dir: Path) -> int:
    """Reads the server pid from `<data_dir>/server.pid`, understanding both the legacy bare
    integer shape and the JSON `{"pid":N,"start":...}` shape (pid_lock.rs::parse_pid_lock)."""
    content = (data_dir / "server.pid").read_text(encoding="utf-8").strip()
    if not content:
        raise ValueError(f"empty pidfile: {data_dir / 'server.pid'}")
    try:
        return int(content)
    except ValueError:
        pid = json.loads(content)["pid"]
        return int(pid)


def sample_pid_cores(pid: int, duration_s: float, interval_s: float, samples_file: Path) -> dict:
    """Samples `ps -o %cpu=` for `pid` every `interval_s` over `duration_s`, appending each raw
    reading to `samples_file` (never dropped — the caller can always re-derive the summary), and
    returns {meanCores, maxCores, samples, ncpu}. An exited pid ends the loop early (recorded)."""
    ncpu = int(subprocess.run(["sysctl", "-n", "hw.ncpu"], capture_output=True, text=True, check=True).stdout.strip())
    pct_readings: list[float] = []
    deadline = time.monotonic() + duration_s
    with samples_file.open("a", encoding="utf-8") as fh:
        while time.monotonic() < deadline:
            out = subprocess.run(["ps", "-o", "%cpu=", "-p", str(pid)], capture_output=True, text=True)
            raw = out.stdout.strip()
            if not raw:
                fh.write(f"{time.time():.3f} EXITED\n")
                break
            pct = float(raw)
            pct_readings.append(pct)
            fh.write(f"{time.time():.3f} {pct}\n")
            time.sleep(interval_s)
    if not pct_readings:
        return {"meanCores": 0.0, "maxCores": 0.0, "samples": 0, "ncpu": ncpu, "note": "pid exited before first sample"}
    return {
        "meanCores": round(sum(pct_readings) / len(pct_readings) / 100.0, 3),
        "maxCores": round(max(pct_readings) / 100.0, 3),
        "samples": len(pct_readings),
        "ncpu": ncpu,
    }


def wait_http_ready(port: int, path: str, timeout_s: float) -> float:
    """Polls `GET 127.0.0.1:port/path` until it answers 200, returning elapsed seconds. Raises on
    timeout — a harness that silently treats a dead server as ready would report a fake pass."""
    deadline = time.monotonic() + timeout_s
    t0 = time.monotonic()
    url = f"http://127.0.0.1:{port}{path}"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    return time.monotonic() - t0
        except OSError:
            pass
        time.sleep(0.2)
    raise TimeoutError(f"{url} did not answer 200 within {timeout_s}s")


def start_server(binary: Path, data_dir: Path, media_dir: Path, home: Path, otlp_port: int, ui_port: int, mcp_port: int, no_log_scan: bool) -> subprocess.Popen:
    """Launches `alcore serve` against an isolated data/media/home dir; the caller must
    `stop_server` it and must read the authoritative pid from the pidfile, not from this Popen."""
    data_dir.mkdir(parents=True, exist_ok=True)
    media_dir.mkdir(parents=True, exist_ok=True)
    args = [str(binary), "serve", "--data-dir", str(data_dir), "--media-dir", str(media_dir),
            "--otlp-port", str(otlp_port), "--ui-port", str(ui_port), "--mcp-port", str(mcp_port),
            "--bind", "127.0.0.1"]
    if no_log_scan:
        args.append("--no-log-scan")
    env = {**os.environ, "HOME": str(home), "DATA_DIR": str(data_dir)}
    return subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def stop_server(proc: subprocess.Popen, timeout_s: float = 10.0) -> None:
    """SIGTERMs the server (the path that actually flushes — see the card's F1 fix) and waits."""
    proc.terminate()
    try:
        proc.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5.0)


def run_flood(mix: str, otlp_port: int, ui_port: int, seconds: int, concurrency: int) -> dict:
    """Runs scripts/bench/alcore-ingest-flood.mjs --mix {mix} and returns its final JSON line."""
    out = subprocess.run(
        ["node", str(FLOOD_SCRIPT), "--mix", mix, "--otlp-port", str(otlp_port), "--ui-port", str(ui_port),
         "--seconds", str(seconds), "--concurrency", str(concurrency)],
        capture_output=True, text=True, check=True,
    )
    last_line = out.stdout.strip().splitlines()[-1]
    return json.loads(last_line)


def build_plan(args: argparse.Namespace) -> list[dict]:
    """Describes, without executing anything, the steps a real run performs — this IS the
    --dry-run output, so it must stay in lockstep with run_all()."""
    return [
        {"step": "start_server", "no_log_scan": True, "data_dir": args.data_dir, "home": args.home,
         "ports": {"otlp": args.otlp_port, "ui": args.ui_port, "mcp": args.mcp_port}},
        {"step": "wait_http_ready", "path": "/api/summary", "timeout_s": args.boot_timeout},
        {"step": "sample+flood", "path": "otlp", "seconds": args.seconds, "concurrency": args.concurrency},
        {"step": "sample+flood", "path": "hooks", "seconds": args.seconds, "concurrency": args.concurrency},
        {"step": "stop_server"},
        {"step": "start_server", "no_log_scan": False, "note": "cold JSONL boot scan against --home's corpus"},
        {"step": "sample_until_ready", "path": "/api/summary", "timeout_s": args.boot_timeout},
        {"step": "stop_server"},
        {"step": "write_report", "out": args.out},
    ]


def run_all(args: argparse.Namespace) -> dict:
    """Executes the full three-path measurement plan against a real (isolated) alcore instance."""
    binary = Path(args.binary)
    if not binary.exists():
        raise FileNotFoundError(f"alcore binary not found: {binary} — build it first (cargo build --release -p agentlens-core --bin alcore)")
    data_dir, media_dir, home = Path(args.data_dir), Path(args.media_dir), Path(args.home)
    samples_dir = Path(args.out).with_suffix("").parent / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)

    result: dict = {"generatedAt": datetime.now(timezone.utc).astimezone().isoformat(), "paths": {}}

    proc = start_server(binary, data_dir, media_dir, home, args.otlp_port, args.ui_port, args.mcp_port, no_log_scan=True)
    try:
        wait_http_ready(args.ui_port, "/api/summary", args.boot_timeout)
        pid = read_pidfile(data_dir)
        for mix in ("otlp", "hooks"):
            samples_file = samples_dir / f"{mix}.samples.txt"
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=1) as pool:
                cores_future = pool.submit(sample_pid_cores, pid, args.seconds + 2, 1.0, samples_file)
                flood_result = run_flood(mix, args.otlp_port, args.ui_port, args.seconds, args.concurrency)
                cores = cores_future.result()
            result["paths"][mix] = {"cores": cores, "throughput": flood_result}
    finally:
        stop_server(proc)

    cold_proc = start_server(binary, data_dir, media_dir, home, args.otlp_port, args.ui_port, args.mcp_port, no_log_scan=False)
    samples_file = samples_dir / "cold_jsonl.samples.txt"
    try:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=1) as pool:
            pid = read_pidfile(data_dir)
            cores_future = pool.submit(sample_pid_cores, pid, args.boot_timeout, 0.5, samples_file)
            boot_seconds = wait_http_ready(args.ui_port, "/api/summary", args.boot_timeout)
            cores = cores_future.result()
        result["paths"]["cold_jsonl_load"] = {"cores": cores, "bootSeconds": boot_seconds}
    finally:
        stop_server(cold_proc)

    return result


def self_test() -> None:
    """Exercises sample_pid_cores against the current process for 1s — proves the sampler works
    without needing a live alcore instance."""
    tmp = Path("/tmp") / "alcore_core_utilization_selftest.samples.txt"
    tmp.unlink(missing_ok=True)
    result = sample_pid_cores(os.getpid(), duration_s=1.0, interval_s=0.2, samples_file=tmp)
    assert result["samples"] >= 1, f"sampler produced no readings: {result}"
    assert result["ncpu"] > 0, f"could not read hw.ncpu: {result}"
    print(json.dumps({"selfTest": "pass", **result}))
    tmp.unlink(missing_ok=True)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--binary", default=str(DEFAULT_BINARY), help="path to the alcore binary")
    p.add_argument("--data-dir", default="/tmp/alcore-core-util-data", help="isolated --data-dir")
    p.add_argument("--media-dir", default="/tmp/alcore-core-util-media", help="isolated --media-dir")
    p.add_argument("--home", default="/tmp/alcore-core-util-home", help="isolated HOME (its .claude/projects is the cold-load corpus)")
    p.add_argument("--otlp-port", type=int, default=4901)
    p.add_argument("--ui-port", type=int, default=3901)
    p.add_argument("--mcp-port", type=int, default=4902)
    p.add_argument("--seconds", type=int, default=30, help="flood duration per path (otlp/hooks)")
    p.add_argument("--concurrency", type=int, default=32)
    p.add_argument("--boot-timeout", type=float, default=60.0, help="seconds to wait for a boot/cold-scan to answer ready")
    p.add_argument("--out", default=None, help="report JSON path (default: reports/bench/<ts>-alcore-core-utilization.json)")
    p.add_argument("--dry-run", action="store_true", help="print the execution plan and exit — touches nothing")
    p.add_argument("--self-test", action="store_true", help="exercise the CPU sampler on this process for 1s and exit")
    args = p.parse_args()

    if args.out is None:
        ts = datetime.now().astimezone().strftime("%Y%m%d_%H%M%S%z")
        args.out = str(REPO_ROOT / "reports" / "bench" / f"{ts}-alcore-core-utilization.json")

    if args.self_test:
        self_test()
        return

    if args.dry_run:
        print(json.dumps({"plan": build_plan(args)}, indent=2))
        return

    result = run_all(args)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"wrote": str(out_path), "paths": list(result["paths"].keys())}))


if __name__ == "__main__":
    main()
