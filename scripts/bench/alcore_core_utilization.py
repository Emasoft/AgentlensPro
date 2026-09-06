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
     with log-scan ON and measures cores-busy + wall time from launch until /api/summary
     answers (the boot sweep is synchronous and finishes before the listeners bind). It gets
     its OWN empty data dir (`<data-dir>-cold`): alcore replays the span store at boot, and the
     flood just wrote ~500 MB of spans into the first one — measured 2026-09-06, that replay
     alone ran >60 s on one core and would have been reported as "JSONL load time".

Cores-busy is Δcputime/Δwall per sampling interval, from `ps -o cputime=` (centisecond
resolution, process-wide so rayon/tokio threads are summed) — NOT `%cpu`, which is a decaying
average "over up to a minute" and under-reads a 30 s flood. `%cpu` is kept as a cross-check
column only. The pid is the Popen's own: alcore does not daemonise, so Popen IS the server.

This script only ORCHESTRATES and MEASURES. It does not interpret PASS/FAIL (that is boxes 2/3
of the card) and it never touches the live collector — pass --data-dir/--home/--*-port pointing
at throwaway locations. The report is written after EACH path, so a later failure never
discards an earlier measurement.
"""

import argparse
import json
import os
import subprocess
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FLOOD_SCRIPT = REPO_ROOT / "scripts" / "bench" / "alcore-ingest-flood.mjs"
DEFAULT_BINARY = REPO_ROOT / "rust-core" / "target" / "release" / "alcore"
DEFAULT_MEDIA_DIR = REPO_ROOT / "media"
# alcore's log discovery honours these OVER HOME (agentlens-logscan discovery.rs::Env), so an
# "isolated" --home would still read the real corpus if the invoking shell exports any of them.
DISCOVERY_ENV_OVERRIDES = ("CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_DATA_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME")


def parse_cputime(s: str) -> float:
    """`ps -o cputime=` → seconds. Shapes seen on macOS: `0:00.01`, `227:39.03`, `1-02:03:04`."""
    days = 0
    if "-" in s:
        d, s = s.split("-", 1)
        days = int(d)
    parts = [float(p) for p in s.split(":")]
    secs = 0.0
    for p in parts:
        secs = secs * 60 + p
    return days * 86400 + secs


def sample_pid_cores(pid: int, stop: threading.Event, max_seconds: float, interval_s: float, samples_file: Path) -> dict:
    """Samples `ps -o cputime=,%cpu=` for `pid` every `interval_s` until `stop` is set or
    `max_seconds` elapse, appending each raw reading to `samples_file`. Cores-busy is
    Δcputime/Δwall per interval; returns mean/max over intervals plus the %cpu cross-check.
    A vanished pid (ProcessLookupError) ends the loop as EXITED; any other `ps` failure raises."""
    ncpu = int(subprocess.run(["sysctl", "-n", "hw.ncpu"], capture_output=True, text=True, check=True).stdout.strip())
    readings: list[tuple[float, float, float]] = []  # (wall, cputime_s, pct)
    deadline = time.monotonic() + max_seconds
    exited = False
    with samples_file.open("w", encoding="utf-8") as fh:
        fh.write("# wall_epoch cputime_s pct_cpu\n")
        while True:
            out = subprocess.run(["ps", "-o", "cputime=,%cpu=", "-p", str(pid)], capture_output=True, text=True)
            raw = out.stdout.split()
            if not raw:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    fh.write(f"{time.time():.3f} EXITED\n")
                    exited = True
                    break
                raise RuntimeError(f"ps failed for live pid {pid} (rc={out.returncode}): {out.stderr.strip()}")
            wall, cpu, pct = time.monotonic(), parse_cputime(raw[0]), float(raw[1])
            readings.append((wall, cpu, pct))
            fh.write(f"{time.time():.3f} {cpu:.2f} {pct}\n")
            # The final reading is taken AFTER stop fires so the last interval is closed.
            if stop.is_set() or time.monotonic() >= deadline:
                break
            stop.wait(interval_s)
    intervals = [(c1 - c0) / (w1 - w0) for (w0, c0, _), (w1, c1, _) in zip(readings, readings[1:]) if w1 > w0]
    # A server that died mid-window would otherwise yield a "valid" cores number over the
    # seconds it lived; wait_http_ready covers boot, this covers the flood.
    if exited or not intervals:
        raise RuntimeError(f"pid {pid} exited={exited}, intervals={len(intervals)} — see {samples_file}")
    cpu_seconds = readings[-1][1] - readings[0][1]
    return {
        "meanCores": round(sum(intervals) / len(intervals), 3),
        "maxCores": round(max(intervals), 3),
        "intervals": len(intervals),
        "wallSeconds": round(readings[-1][0] - readings[0][0], 3),
        "cpuSeconds": round(cpu_seconds, 2),
        # cputime is centisecond-resolution: under 5 cs of CPU, or fewer than 3 intervals, the
        # cores figures are a rounding floor (an empty-corpus boot reads 0.0), not a measurement.
        "belowResolution": cpu_seconds < 0.05 or len(intervals) < 3,
        "meanPctCpuCrossCheck": round(sum(r[2] for r in readings) / len(readings), 1),
        "ncpu": ncpu,
    }


def wait_http_ready(proc: subprocess.Popen, stderr_file: Path, port: int, path: str, timeout_s: float) -> float:
    """Polls `GET 127.0.0.1:port/path` until 200, returning elapsed seconds. Raises — with
    alcore's own stderr — if the process exits first or the timeout lapses: a silent timeout
    hid a usage() refusal for a full 60 s in the first version of this harness."""
    deadline = time.monotonic() + timeout_s
    t0 = time.monotonic()
    url = f"http://127.0.0.1:{port}{path}"
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"alcore exited rc={proc.returncode} before answering {url}\n--- stderr ---\n{stderr_file.read_text(encoding='utf-8')}")
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    return time.monotonic() - t0
        except OSError:
            pass
        time.sleep(0.1)
    raise TimeoutError(f"{url} did not answer 200 within {timeout_s}s\n--- stderr ---\n{stderr_file.read_text(encoding='utf-8')}")


def start_server(binary: Path, data_dir: Path, media_dir: Path, home: Path, ports: dict, no_log_scan: bool, stderr_file: Path) -> subprocess.Popen:
    """Launches `alcore serve` against an isolated data/home dir with stderr captured to
    `stderr_file`. alcore does not daemonise, so the returned Popen's pid IS the server pid."""
    data_dir.mkdir(parents=True, exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    args = [str(binary), "serve", "--data-dir", str(data_dir), "--media-dir", str(media_dir),
            "--otlp-port", str(ports["otlp"]), "--ui-port", str(ports["ui"]), "--mcp-port", str(ports["mcp"]),
            "--bind", "127.0.0.1"]
    if no_log_scan:
        args.append("--no-log-scan")
    env = {k: v for k, v in os.environ.items() if k not in DISCOVERY_ENV_OVERRIDES}
    env.update({"HOME": str(home), "DATA_DIR": str(data_dir)})
    return subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL, stderr=stderr_file.open("w", encoding="utf-8"))


def stop_server(proc: subprocess.Popen, timeout_s: float = 10.0) -> bool:
    """SIGTERMs the server (the path that actually flushes — see the card's F1 fix) and waits.
    Returns True when it had to escalate to SIGKILL — a wedged shutdown is a finding, and the
    first real run hid one (server.pid survived, nothing said why)."""
    proc.terminate()
    try:
        proc.wait(timeout=timeout_s)
        return False
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5.0)
        return True


def run_flood(mix: str, ports: dict, seconds: int, concurrency: int) -> dict:
    """Runs scripts/bench/alcore-ingest-flood.mjs --mix {mix} and returns its final JSON line."""
    cmd = ["node", str(FLOOD_SCRIPT), "--mix", mix, "--otlp-port", str(ports["otlp"]), "--ui-port", str(ports["ui"]),
           "--seconds", str(seconds), "--concurrency", str(concurrency)]
    out = subprocess.run(cmd, capture_output=True, text=True)
    lines = out.stdout.strip().splitlines()
    if out.returncode != 0 or not lines:
        raise RuntimeError(f"flood --mix {mix} failed rc={out.returncode}\n--- stdout ---\n{out.stdout}\n--- stderr ---\n{out.stderr}")
    return json.loads(lines[-1])


def build_plan(args: argparse.Namespace) -> list[dict]:
    """Describes, without executing anything, the steps a real run performs — this IS the
    --dry-run output, so it must stay in lockstep with run_all()."""
    ports = {"otlp": args.otlp_port, "ui": args.ui_port, "mcp": args.mcp_port}
    return [
        {"step": "start_server", "no_log_scan": True, "data_dir": args.data_dir, "media_dir": args.media_dir, "home": args.home, "ports": ports},
        {"step": "wait_http_ready", "path": "/api/summary", "timeout_s": args.boot_timeout},
        {"step": "sample+flood", "path": "otlp", "seconds": args.seconds, "concurrency": args.concurrency},
        {"step": "sample+flood", "path": "hooks", "seconds": args.seconds, "concurrency": args.concurrency},
        {"step": "stop_server"},
        {"step": "start_server", "no_log_scan": False, "data_dir": args.data_dir + "-cold", "note": "cold JSONL boot scan against --home's corpus, EMPTY store"},
        {"step": "sample_until_ready", "path": "/api/summary", "timeout_s": args.boot_timeout},
        {"step": "stop_server"},
        {"step": "write_report", "out": args.out, "samples_dir": str(samples_dir_for(Path(args.out)))},
    ]


def samples_dir_for(out: Path) -> Path:
    """Raw per-interval samples live beside the report, keyed by its timestamped name, so two
    runs never concatenate into one file."""
    return out.parent / f"{out.stem}-samples"


def run_all(args: argparse.Namespace) -> dict:
    """Executes the full three-path measurement plan against a real (isolated) alcore instance,
    rewriting the report after every path."""
    binary, media_dir = Path(args.binary), Path(args.media_dir)
    if not binary.exists():
        raise FileNotFoundError(f"alcore binary not found: {binary} — build it first (cargo build --release -p agentlens-core --bin alcore)")
    if not (media_dir / "index.html").is_file():
        raise FileNotFoundError(f"--media-dir {media_dir} has no index.html — alcore refuses to boot without it")
    data_dir, home = Path(args.data_dir), Path(args.home)
    cold_data_dir = data_dir.with_name(data_dir.name + "-cold")
    for d in (data_dir, cold_data_dir):
        if (d / "spans").exists():
            raise FileExistsError(f"{d}/spans already exists — a prior run's store would be replayed at boot and counted as boot time; use a fresh --data-dir")
    out = Path(args.out)
    samples_dir = samples_dir_for(out)
    samples_dir.mkdir(parents=True, exist_ok=True)
    ports = {"otlp": args.otlp_port, "ui": args.ui_port, "mcp": args.mcp_port}

    result: dict = {
        "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(),
        "binary": str(binary), "dataDir": str(data_dir), "coldDataDir": str(cold_data_dir), "home": str(home), "ports": ports,
        "seconds": args.seconds, "concurrency": args.concurrency, "paths": {},
    }

    def write_report() -> None:
        out.write_text(json.dumps(result, indent=2), encoding="utf-8")

    stderr_file = samples_dir / "alcore-flood.stderr.log"
    proc = start_server(binary, data_dir, media_dir, home, ports, no_log_scan=True, stderr_file=stderr_file)
    try:
        wait_http_ready(proc, stderr_file, ports["ui"], "/api/summary", args.boot_timeout)
        for mix in ("otlp", "hooks"):
            stop = threading.Event()
            with ThreadPoolExecutor(max_workers=1) as pool:
                cores_future = pool.submit(sample_pid_cores, proc.pid, stop, args.seconds + 30, 1.0, samples_dir / f"{mix}.samples.txt")
                try:
                    flood_result = run_flood(mix, ports, args.seconds, args.concurrency)
                finally:
                    stop.set()
                cores = cores_future.result()
            result["paths"][mix] = {"cores": cores, "throughput": flood_result}
            write_report()
    finally:
        result["floodInstanceForcedKill"] = stop_server(proc)
        write_report()

    stderr_file = samples_dir / "alcore-cold.stderr.log"
    cold_proc = start_server(binary, cold_data_dir, media_dir, home, ports, no_log_scan=False, stderr_file=stderr_file)
    try:
        stop = threading.Event()
        with ThreadPoolExecutor(max_workers=1) as pool:
            cores_future = pool.submit(sample_pid_cores, cold_proc.pid, stop, args.boot_timeout, 0.2, samples_dir / "cold_jsonl.samples.txt")
            try:
                boot_seconds = wait_http_ready(cold_proc, stderr_file, ports["ui"], "/api/summary", args.boot_timeout)
            finally:
                stop.set()
            cores = cores_future.result()
        result["paths"]["cold_jsonl_load"] = {"cores": cores, "bootSeconds": round(boot_seconds, 3)}
        write_report()
    finally:
        result["coldInstanceForcedKill"] = stop_server(cold_proc)
        write_report()
    return result


def self_test() -> None:
    """Plumbing smoke only: proves the sampler + cputime parser run against this process. It
    says NOTHING about the alcore measurement path — only a real run does."""
    assert parse_cputime("0:00.01") == 0.01
    assert parse_cputime("227:39.03") == 227 * 60 + 39.03
    assert parse_cputime("1-02:03:04") == 86400 + 2 * 3600 + 3 * 60 + 4
    tmp = Path("/tmp") / "alcore_core_utilization_selftest.samples.txt"
    stop = threading.Event()
    t = threading.Timer(1.0, stop.set)
    t.start()
    result = sample_pid_cores(os.getpid(), stop, max_seconds=5.0, interval_s=0.2, samples_file=tmp)
    assert result["intervals"] >= 1, result
    print(json.dumps({"selfTest": "pass", **result}))
    tmp.unlink(missing_ok=True)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--binary", default=str(DEFAULT_BINARY), help="path to the alcore binary")
    p.add_argument("--data-dir", default=None, help="isolated --data-dir (default: /tmp/alcore-core-util-<ts>/data; must not hold a prior run's spans/)")
    p.add_argument("--media-dir", default=str(DEFAULT_MEDIA_DIR), help="dashboard dir; MUST contain index.html or alcore refuses to boot")
    p.add_argument("--home", default=None, help="isolated HOME whose .claude/projects is the cold-load corpus (default: /tmp/alcore-core-util-<ts>/home, EMPTY — the cold path then measures only the pipeline, not a real corpus)")
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

    ts = datetime.now().astimezone().strftime("%Y%m%d_%H%M%S%z")
    if args.out is None:
        args.out = str(REPO_ROOT / "reports" / "bench" / f"{ts}-alcore-core-utilization.json")
    if args.data_dir is None:
        args.data_dir = f"/tmp/alcore-core-util-{ts}/data"
    if args.home is None:
        args.home = f"/tmp/alcore-core-util-{ts}/home"

    if args.self_test:
        self_test()
        return

    if args.dry_run:
        print(json.dumps({"plan": build_plan(args)}, indent=2))
        return

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    result = run_all(args)
    print(json.dumps({"wrote": args.out, "paths": {k: v["cores"] for k, v in result["paths"].items()}}))


if __name__ == "__main__":
    main()
