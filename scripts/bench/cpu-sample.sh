#!/usr/bin/env bash
# cpu-sample.sh PID SECONDS — samples `ps -o %cpu= -p PID` once/sec, prints mean/max %cpu
# (macOS: >100% means more than one core busy) plus hw.ncpu.
set -euo pipefail
PID="$1"
SECONDS_TO_SAMPLE="$2"

samples=()
for ((i = 0; i < SECONDS_TO_SAMPLE; i++)); do
  cpu=$(ps -o %cpu= -p "$PID" 2>/dev/null | tr -d ' ')
  [[ -n "$cpu" ]] && samples+=("$cpu")
  sleep 1
done

ncpu=$(sysctl -n hw.ncpu)

if [[ ${#samples[@]} -eq 0 ]]; then
  echo '{"error":"no samples — pid exited?","ncpu":'"$ncpu"'}'
  exit 1
fi

python3 - "$ncpu" "${samples[@]}" <<'EOF'
import sys
ncpu = sys.argv[1]
vals = [float(v) for v in sys.argv[2:]]
mean = sum(vals) / len(vals)
mx = max(vals)
print(f'{{"meanCpuPct":{mean:.1f},"maxCpuPct":{mx:.1f},"samples":{len(vals)},"ncpu":{ncpu}}}')
EOF
