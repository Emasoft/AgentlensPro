#!/usr/bin/env bash
#
# cargo-target-retention.sh — report (default) or prune superseded cargo build generations.
#
# RULE: keep the newest N generations per crate (default N=2); every older generation is a removal
# candidate. A generation is the set of paths sharing one `<crate>-<16 hex>` metadata hash:
#   <profile>/.fingerprint/<crate>-<hash>   <profile>/build/<crate>-<hash>
#   <profile>/deps/<crate_underscored>-<hash>*  and  deps/lib<crate_underscored>-<hash>*
# Crates are ranked by their EXACT fingerprint name (foo-bar and foo_bar are different crates); the
# `-`/`_` normalisation is used only to attach a build/ or deps/ entry to its generation, together
# with the 16-hex hash. A generation's age is the NEWEST mtime of any file belonging to it, not a
# directory mtime (cargo can leave the live generation with an older directory mtime).
# incremental/ is NOT covered: its directory hash is a different hash and cannot be matched to a
# generation here. Plain file operations only (no cargo-sweep).
#
# WHY report-only by default: deleting build output is the owner's call (TRDD-ZSX34J8F); a sweep while
# a cargo job owns the tree corrupts the build, so --apply refuses while cargo/rustc is running.
#
# Tools relied on (all tested on this machine, GNU-shadowed and BSD alike): bash, find, perl 5
# (File::Find, lstat: one pass for the mtimes — macOS find has no -printf and stat flags differ
# between BSD and GNU), awk (POSIX), sort, du -sk, ps -eo pid,command, mktemp.
#
# Usage: scripts/cargo-target-retention.sh [--keep N] [--profile NAME] [--apply]
#                                          [--force-while-building] <path/to/target>
#   --apply                  actually remove (refused unless the path ends in /target and holds
#                            CACHEDIR.TAG or <profile>/.fingerprint); every path is printed
#                            before it is removed.
#   --force-while-building   with --apply: proceed even if a cargo or rustc process is running.
# Refuses (exit 2) when $TARGET, $TARGET/<profile>, <profile>/build or <profile>/deps is a symlink.
# Test knob: CARGO_RETENTION_PS_SNAPSHOT=<file in `ps -eo pid,command` format> replaces ps.

set -uo pipefail

KEEP=2
PROFILE=debug
APPLY=0
FORCE=0
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep)    KEEP="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --apply)   APPLY=1; shift ;;
    --force-while-building) FORCE=1; shift ;;
    -h|--help) sed -n '2,/^$/p' "$0"; exit 0 ;;
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
P="$TARGET/$PROFILE"
# Any symlinked level could redirect --apply (and the walk) outside the target.
for d in "$P" "$P/build" "$P/deps"; do
  [ ! -L "$d" ] || { echo "cargo-target-retention: REFUSED: '$d' is a symlink" >&2; exit 2; }
done
FP="$P/.fingerprint"
[ -d "$FP" ] && [ ! -L "$FP" ] || { echo "cargo-target-retention: no $PROFILE/.fingerprint under $TARGET" >&2; exit 2; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

if [ "$APPLY" -eq 1 ]; then
  case "$TARGET" in */target) ;; *) echo "cargo-target-retention: REFUSED --apply: path does not end in /target" >&2; exit 2 ;; esac
  # The guard follows --profile: a release-only tree has no debug/.fingerprint.
  if [ ! -f "$TARGET/CACHEDIR.TAG" ] && [ ! -d "$FP" ]; then
    echo "cargo-target-retention: REFUSED --apply: no CACHEDIR.TAG or $PROFILE/.fingerprint in $TARGET" >&2; exit 2
  fi
  # Snapshot first, then search the file (a live pipeline would match its own shell).
  if [ -n "${CARGO_RETENTION_PS_SNAPSHOT:-}" ]; then cp "$CARGO_RETENTION_PS_SNAPSHOT" "$WORK/ps"; else ps -eo pid,command > "$WORK/ps"; fi
  # Match the command's basename only, so this script's own name (it contains "cargo") never matches.
  if [ "$FORCE" -ne 1 ] && awk 'NR > 1 { c = $2; sub(/.*\//, "", c); if (c == "cargo" || c == "rustc") f = 1 } END { exit !f }' "$WORK/ps"; then
    echo "cargo-target-retention: REFUSED --apply: a cargo or rustc process is running (--force-while-building overrides)" >&2; exit 2
  fi
fi

kib() { du -sk "$1" 2>/dev/null | cut -f1; }

echo "target: $TARGET (profile $PROFILE, keep newest $KEEP per crate)"
echo "du -sk target: $(kib "$TARGET") KiB; du -sk $PROFILE: $(kib "$P") KiB"
echo ".fingerprint entries: $(find -P "$FP" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"

# ONE pass for every mtime: "<newest file mtime>\t<top-level entry>" for each entry of
# .fingerprint, build and deps (lstat, symlinks skipped, directories contribute only their files;
# an entry with no file falls back to its own mtime).
perl -MFile::Find -e '
  for my $d (@ARGV) {
    opendir(my $dh, $d) or next;
    for my $e (grep { $_ ne "." && $_ ne ".." } readdir $dh) {
      my $p = "$d/$e"; my @s = lstat $p; next if -l _;
      my $m = 0;
      if (-d _) { find({ no_chdir => 1, wanted => sub { my @t = lstat $_; $m = $t[9] if !-d _ && !-l _ && $t[9] > $m } }, $p); }
      $m ||= $s[9];
      print "$m\t$p\n";
    }
  }' "$P/.fingerprint" "$P/build" "$P/deps" > "$WORK/ents"

# ONE pass for every size (real entries only, symlinks skipped). A du/find per generation was
# measured to be unusable on the real 36 GiB tree (load average 80+), so grouping is done in awk.
find -P "$P/.fingerprint" "$P/build" "$P/deps" -mindepth 1 -maxdepth 1 ! -type l -exec du -sk {} + \
  > "$WORK/sizes" 2>/dev/null

# Attach entries to generations. A generation is keyed by its EXACT fingerprint crate name + hash;
# a build/deps entry joins it by (normalised name, hash). Outputs: map "<path>\t<crate>\t<hash>" and
# gensraw "<crate>\t<newest mtime>\t<hash>".
awk -F'\t' -v fpre="$FP/" -v map="$WORK/map" '
  function norm(s) { gsub(/-/, "_", s); return s }
  {
    path = $2; n = path; sub(/.*\//, "", n)
    if (index(path, fpre) == 1) {
      if (match(n, /-[0-9a-f]{16}$/)) {
        c = substr(n, 1, RSTART - 1); h = substr(n, RSTART + 1)
        exact[norm(c) SUBSEP h] = c
        nf++; fpP[nf] = path; fpC[nf] = c; fpH[nf] = h; fpM[nf] = $1 + 0
      }
    } else { np++; pP[np] = path; pN[np] = n; pM[np] = $1 + 0 }
  }
  function bump(c, h, m) { k = c SUBSEP h; if (!(k in gm) || m > gm[k]) gm[k] = m }
  END {
    for (i = 1; i <= nf; i++) { bump(fpC[i], fpH[i], fpM[i]); print fpP[i] "\t" fpC[i] "\t" fpH[i] > map }
    for (i = 1; i <= np; i++) {
      n = pN[i]
      if (!match(n, /-[0-9a-f]{16}(\.|$)/)) continue
      h = substr(n, RSTART + 1, 16); c = norm(substr(n, 1, RSTART - 1)); nk = c SUBSEP h
      if (!(nk in exact) && c ~ /^lib/) { c = substr(c, 4); nk = c SUBSEP h }
      if (!(nk in exact)) continue
      bump(exact[nk], h, pM[i]); print pP[i] "\t" exact[nk] "\t" h > map
    }
    for (k in gm) { split(k, a, SUBSEP); print a[1] "\t" gm[k] "\t" a[2] }
  }' "$WORK/ents" > "$WORK/gensraw"

# Newest first within each exact crate; "<crate>\t<hash>\t<rank>". Ties broken by hash for determinism.
TAB="$(printf '\t')"
LC_ALL=C sort -t "$TAB" -k1,1 -k2,2nr -k3,3r "$WORK/gensraw" \
  | awk -F'\t' '{ n[$1]++; print $1 "\t" $3 "\t" n[$1] }' > "$WORK/gens"

# removable entries: "<KiB>\t<crate>\t<hash>\t<rank>\t<path>"
awk -F'\t' -v keep="$KEEP" '
  FILENAME == ARGV[1] { rank[$1 SUBSEP $2] = $3; next }
  FILENAME == ARGV[2] { mc[$1] = $2; mh[$1] = $3; next }
  {
    path = $2
    if (!(path in mc)) next
    r = rank[mc[path] SUBSEP mh[path]]
    if (r <= keep) next
    print $1 "\t" mc[path] "\t" mh[path] "\t" r "\t" path
  }' "$WORK/gens" "$WORK/map" "$WORK/sizes" > "$WORK/removed"

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
