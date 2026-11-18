#!/usr/bin/env bash
# capped-copy.sh SRC DEST — the only sanctioned way to copy data for a measurement.
# Owner orders 2026-11-16, verbatim:
#   "add a permanent cap to tests to limit to 4 GB any generated fake data for tests!"
#   "no, the cap is 4GB. i don't care about testing full data size."
# A measurement uses a <=4 GB sample, never a full-size data clone. On 2026-11-16 measurement
# scripts cloned a 43 GB folder 29 times.
# Exit codes: 0 copied; 1 du or cp failed (set -e aborts; the failing tool prints its own message); 2 usage error, unsupported platform, or DEST already exists; 3 SRC or the finished copy is over 4 GB.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: capped-copy.sh SRC DEST" >&2
  exit 2
fi
# 4 GiB in `du -sk` blocks. A constant with no override: the cap is the owner rule, not a setting.
CAP_KB=4194304
SRC=$1
DEST=$2

# Never merge into an existing tree; -L also catches a dangling symlink at DEST.
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  echo "capped-copy: $DEST already exists, refusing to merge into it" >&2
  exit 2
fi

# du -sk reports allocated size. An APFS clone counts in full there even though its blocks are
# shared on disk, so the cap applies to a clone exactly as to a full copy: the 2026-11-16 incident
# was 29 clones of a 43 GB folder.
# du -sk: GNU du (this machine) and BSD du both print KB, a TAB, then the path, so the PATH du is used.
SIZE_KB=$(du -sk "$SRC" | cut -f1)
if [ "$SIZE_KB" -gt "$CAP_KB" ]; then
  echo "capped-copy: $SRC is $((SIZE_KB / 1024)) MB, over the 4 GB test-data cap, copy refused" >&2
  exit 3
fi

# The BSD /bin/cp is named explicitly: the PATH cp is GNU coreutils on this machine, where -c is
# not the APFS clone flag. On Darwin -c asks for an APFS clone; on Linux --reflink=auto clones
# where the filesystem supports it and copies otherwise.
case "$(uname -s)" in
  Darwin) /bin/cp -cpR "$SRC" "$DEST" ;;
  Linux) cp -a --reflink=auto "$SRC" "$DEST" ;;
  *) echo "capped-copy: unsupported platform $(uname -s)" >&2; exit 2 ;;
esac

# Re-measure: the source may have grown since the first check. An over-cap copy is left in place;
# deleting it is the caller's decision.
COPY_KB=$(du -sk "$DEST" | cut -f1)
if [ "$COPY_KB" -gt "$CAP_KB" ]; then
  echo "capped-copy: $DEST is $((COPY_KB / 1024)) MB after copying, over the 4 GB test-data cap, left in place" >&2
  exit 3
fi
exit 0
