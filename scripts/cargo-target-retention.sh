#!/usr/bin/env bash
#
# cargo-target-retention.sh — report (default) or prune superseded cargo build generations.
#
# RULE: keep the newest N generations per crate (default N=2; newest = mtime of its
# .fingerprint/<crate>-<hash> directory); every older generation is a removal candidate.
# A generation is the set of paths sharing one `<crate>-<16 hex>` metadata hash:
#   <profile>/.fingerprint/<crate>-<hash>   <profile>/build/<crate>-<hash>
#   <profile>/deps/<crate_underscored>-<hash>*  and  deps/lib<crate_underscored>-<hash>*
# incremental/ is NOT covered: its directory hash is a different hash and cannot be matched to a
# generation here. Plain file operations only (no cargo-sweep).
#
# WHY report-only by default: deleting build output is the owner's call (TRDD-ZSX34J8F); a sweep while
# a cargo job owns the tree corrupts the build, so run it only when no cargo/rust-analyzer is running.
#
# Usage: scripts/cargo-target-retention.sh [--keep N] [--profile NAME] [--apply] <path/to/target>
#   --apply   actually remove (refused unless the path ends in /target and holds CACHEDIR.TAG
#             or <profile>/.fingerprint); every path is printed before it is removed.

set -uo pipefail

KEEP=2
PROFILE=debug
APPLY=0
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep)    KEEP="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --apply)   APPLY=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    -*)        echo "cargo-target-retention: unknown option '$1'" >&2; exit 2 ;;
    *)         TARGET="$1"; shift ;;
  esac
done

case "$KEEP" in ""|*[!0-9]*) echo "cargo-target-retention: --keep needs a number" >&2; exit 2 ;; esac
# A profile is one path segment: anything with a slash or dots could point --apply outside the target.
case "$PROFILE" in ""|*[!A-Za-z0-9_-]*) echo "cargo-target-retention: --profile must be a plain name" >&2; exit 2 ;; esac
[ -n "$TARGET" ] || { echo "cargo-target-retention: target path required" >&2; exit 2; }
TARGET="${TARGET%/}"
[ -d "$TARGET" ] && [ ! -L "$TARGET" ] || { echo "cargo-target-retention: '$TARGET' is not a real directory" >&2; exit 2; }
FP="$TARGET/$PROFILE/.fingerprint"
[ -d "$FP" ] && [ ! -L "$FP" ] || { echo "cargo-target-retention: no $PROFILE/.fingerprint under $TARGET" >&2; exit 2; }

if [ "$APPLY" -eq 1 ]; then
  case "$TARGET" in */target) ;; *) echo "cargo-target-retention: REFUSED --apply: path does not end in /target" >&2; exit 2 ;; esac
  if [ ! -f "$TARGET/CACHEDIR.TAG" ] && [ ! -d "$TARGET/debug/.fingerprint" ]; then
    echo "cargo-target-retention: REFUSED --apply: no CACHEDIR.TAG or debug/.fingerprint in $TARGET" >&2; exit 2
  fi
fi

kib() { du -sk "$1" 2>/dev/null | cut -f1; }

echo "target: $TARGET (profile $PROFILE, keep newest $KEEP per crate)"
echo "du -sk target: $(kib "$TARGET") KiB; du -sk $PROFILE: $(kib "$TARGET/$PROFILE") KiB"
echo ".fingerprint entries: $(find -P "$FP" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
P="$TARGET/$PROFILE"

# Newest first, numbered per crate: "<crate_> <hash> <rank>" (tab separated). One ls, no per-entry work.
ls -1t "$FP" | sed -nE 's/^(.+)-([0-9a-f]{16})$/\1 \2/p' \
  | awk '{ c=$1; gsub(/-/, "_", c); n[c]++; print c "\t" $2 "\t" n[c] }' > "$WORK/gens"

# ONE pass for every size (real entries only, symlinks skipped). A du/find per generation was
# measured to be unusable on the real 36 GiB tree (load average 80+), so grouping is done in awk.
find -P "$P/.fingerprint" "$P/build" "$P/deps" -mindepth 1 -maxdepth 1 ! -type l -exec du -sk {} + \
  > "$WORK/sizes" 2>/dev/null

# removable entries: "<KiB> <crate> <hash> <rank> <path>" — an entry belongs to a generation by its
# trailing `-<16 hex>` metadata hash; deps/ files carry a `lib` prefix and underscores.
awk -F'\t' -v keep="$KEEP" '
  NR == FNR { rank[$1 SUBSEP $2] = $3; next }
  {
    path = $2; n = path; sub(/.*\//, "", n)
    if (!match(n, /-[0-9a-f]{16}(\.|$)/)) next
    h = substr(n, RSTART + 1, 16); c = substr(n, 1, RSTART - 1); gsub(/-/, "_", c)
    k = c SUBSEP h
    if (!(k in rank) && c ~ /^lib/) { c = substr(c, 4); k = c SUBSEP h }
    if (!(k in rank) || rank[k] <= keep) next
    print $1 "\t" c "\t" h "\t" rank[k] "\t" path
  }' "$WORK/gens" "$WORK/sizes" > "$WORK/removed"

total_gens=$(wc -l < "$WORK/gens" | tr -d ' ')
echo ""
echo "generations per crate (total / would-remove), crates with removable generations only:"
awk -F'\t' '
  NR == FNR { tot[$1]++; next }
  { g[$2 SUBSEP $3] = 1; gc[$2 SUBSEP $3] = $2 }
  END { for (k in g) rm[gc[k]]++; for (c in rm) print "  " c ": " tot[c] " / " rm[c] }' \
  "$WORK/gens" "$WORK/removed" | sort
echo ""
echo "removal candidates (crate hash rank KiB):"
awk -F'\t' '{ k = $2 " " $3 " rank=" $4; s[k] += $1 } END { for (k in s) print "  " k " " s[k] "KiB" }' "$WORK/removed" | sort
removed_gens=$(cut -f2,3 "$WORK/removed" | sort -u | wc -l | tr -d ' ')
removed_kib=$(awk -F'\t' '{ s += $1 } END { print s + 0 }' "$WORK/removed")
echo ""
echo "totals: $total_gens generations, $removed_gens removable, ${removed_kib} KiB reclaimable"

if [ "$APPLY" -ne 1 ]; then
  echo "REPORT ONLY — nothing removed. Re-run with --apply to remove the candidates above."
  exit 0
fi

cut -f5 "$WORK/removed" | while read -r p; do
  [ -L "$p" ] && continue   # never follow or remove a symlink
  echo "removing: $p"
  rm -rf -- "$p"
done
echo "du -sk $PROFILE after: $(kib "$P") KiB"
