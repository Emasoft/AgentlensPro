#!/bin/bash
# alcore-footprint-sampler.sh — periodically samples an alcore instance's
# phys_footprint plus its /api/server-stats and /api/debug/log-scan-stats
# counters into a TSV, one row per interval.
#
# WHY (TRDD-Z0A777XW): the original scripts_dev/alcore-heap/sample.sh was
# gitignored, hardcoded the LIVE ui port (3000), the LIVE ~/.agentlens
# server.pid path and a fixed /tmp output — running it against the live
# collector by accident was one missed edit away. --ui-port and --pidfile
# have NO default and are both mandatory, so the script can never silently
# target the live collector; every target is named explicitly on the
# command line.
#
# Usage:
#   alcore-footprint-sampler.sh --ui-port PORT --pidfile PATH \
#       [--out FILE] [--seconds N] [--interval N]
#
#   --ui-port   REQUIRED. Port the target alcore's HTTP API listens on.
#   --pidfile   REQUIRED. Path to that instance's server.pid (JSON {"pid": N}).
#   --out       Output TSV path (default: ratchet-correlation-samples.tsv
#               in the current directory).
#   --seconds   Total run duration in seconds (default: 3600).
#   --interval  Seconds between samples (default: 30).
#
# Output columns (tab-separated, header row always written first):
#   ts pid phys_footprint_mb summary_misses spans_inmem statusline_recv
#   hook_recv admitted_total otlp_traces otlp_logs otlp_metrics otlp_parse_errors
#
# Any field the server does not report (e.g. otlp.* on a pre-deploy build,
# TRDD-9SOYXKNE) is written as the literal string NA — never 0, which would
# be a false "zero events" reading, and the script never crashes on a
# missing field.
set -euo pipefail

UI_PORT=""
PIDFILE=""
OUT="ratchet-correlation-samples.tsv"
SECONDS_TOTAL=3600
INTERVAL=30

usage() {
  echo "Usage: $0 --ui-port PORT --pidfile PATH [--out FILE] [--seconds N] [--interval N]" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ui-port) UI_PORT="$2"; shift 2 ;;
    --pidfile) PIDFILE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --seconds) SECONDS_TOTAL="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

# Both must be explicit — no default may point at the live collector.
[ -n "$UI_PORT" ] || { echo "error: --ui-port is required" >&2; usage; }
[ -n "$PIDFILE" ] || { echo "error: --pidfile is required" >&2; usage; }

# json_get FIELD_PATH DEFAULT — reads a dotted field out of stdin JSON,
# printing DEFAULT (normally "NA") when the field, or the whole payload,
# is absent/unparseable. Never raises: a down endpoint or a pre-deploy
# server without otlp.* must not crash the sampler (TRDD-Z0A777XW).
json_get() {
  python3 -c "
import json, sys
path = sys.argv[1].split('.')
default = sys.argv[2]
try:
    d = json.load(sys.stdin)
    for k in path:
        d = d[k]
    print(d if d is not None else default)
except Exception:
    print(default)
" "$1" "$2"
}

[ -f "$OUT" ] || printf 'ts\tpid\tphys_footprint_mb\tsummary_misses\tspans_inmem\tstatusline_recv\thook_recv\tadmitted_total\totlp_traces\totlp_logs\totlp_metrics\totlp_parse_errors\n' > "$OUT"

END=$(( $(date +%s) + SECONDS_TOTAL ))
while [ "$(date +%s)" -lt "$END" ]; do
  TS=$(date +%Y-%m-%dT%H:%M:%S%z)
  PID=$(python3 -c "import json;print(json.load(open('$PIDFILE'))['pid'])" 2>/dev/null || echo NA)
  FP=$(/usr/bin/footprint "$PID" 2>/dev/null | grep -m1 'Footprint:' | grep -oE '[0-9]+ MB' | grep -oE '[0-9]+' || true)
  [ -n "$FP" ] || FP=NA
  MISS=$(curl -s -m 5 "http://localhost:$UI_PORT/api/debug/log-scan-stats" 2>/dev/null | json_get derivedCaches.summary.misses NA || true)
  STATS=$(curl -s -m 5 "http://localhost:$UI_PORT/api/server-stats" 2>/dev/null) || true
  SPANS=$(printf '%s' "$STATS" | json_get spans.inMemory NA || true)
  SLRECV=$(printf '%s' "$STATS" | json_get statusline.receivedSinceBoot NA || true)
  HERECV=$(printf '%s' "$STATS" | json_get hookEvents.receivedSinceBoot NA || true)
  ADM=$(printf '%s' "$STATS" | json_get admission.admittedTotal NA || true)
  OTLP_TRACES=$(printf '%s' "$STATS" | json_get otlp.tracesPayloads NA || true)
  OTLP_LOGS=$(printf '%s' "$STATS" | json_get otlp.logsPayloads NA || true)
  OTLP_METRICS=$(printf '%s' "$STATS" | json_get otlp.metricsPayloads NA || true)
  OTLP_PARSE_ERRORS=$(printf '%s' "$STATS" | json_get otlp.parseErrors NA || true)
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$TS" "$PID" "$FP" "$MISS" "$SPANS" "$SLRECV" "$HERECV" "$ADM" \
    "$OTLP_TRACES" "$OTLP_LOGS" "$OTLP_METRICS" "$OTLP_PARSE_ERRORS" >> "$OUT"
  sleep "$INTERVAL"
done
