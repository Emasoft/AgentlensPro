#!/bin/sh
# Triage the kanban's WORK columns without the two blind spots that produced
# three wrong claims on TRDD-KBK9J59Y.
#
# BLIND SPOT 1 — `open=0` means two different things. `grep -c '- [ ]'` returns 0
# both for a card whose every box is ticked (a close-out candidate) and for a card
# that never had a box (cannot be assessed at all). Printing `ticked` beside `open`
# is the whole fix, and it costs one extra grep.
#
# BLIND SPOT 2 — a card can carry criteria in PROSE under a heading, which no
# checkbox count can see. The heading pattern here is deliberately WIDE: an earlier
# version matched `verification` and therefore missed `## Verify`, which is the
# heading two of the cards actually use. Prefer a false "has" over a false "none" —
# the cost of the first is one card opened for nothing, the cost of the second is a
# defect report against a card that was fine.
#
# `criteria=prose` therefore means "a heading in the criteria POSITION exists", NOT
# "criteria were written". Measured false positives: TRDD-Q9WD3K5R matches on a
# `### Measured … VERIFIED` heading that is evidence, and TRDD-YBJGIYI1's FIRST
# match is `## The defect (VERIFIED at file:line…)`, which is about the defect. Both
# are the accepted cost of erring wide. The column is a prompt to open the card; it
# is never itself an answer.
#
# Usage: scripts/board-boxes.sh [column ...]   (default: the four WORK columns)

set -eu
cd "$(dirname "$0")/.."

cols="${*:-todo dev testing ai_review}"

for f in design/tasks/*.md; do
  # An unmatched glob is passed through literally by POSIX sh; without this the
  # loop would run once on a filename that does not exist and print a garbage row.
  [ -e "$f" ] || continue

  col=$(sed -n 's/^column: *//p' "$f" | head -1)

  # A card with no parseable `column:` is REPORTED, not skipped. Silently dropping
  # an unparseable card is the wrong default for a script whose whole purpose is
  # "the board cannot see X" — it would reproduce that failure in a new place.
  if [ -z "$col" ]; then
    printf '%-10s %-10s %s\n' "$(sed -n 's/^trdd-id: *//p' "$f" | head -1)" '?' \
      "NO PARSEABLE column: — $(basename "$f")"
    continue
  fi

  case " $cols " in *" $col "*) ;; *) continue ;; esac

  id=$(sed -n 's/^trdd-id: *//p' "$f" | head -1)
  open=$(grep -c '^ *- \[ \]' "$f" || true)
  tick=$(grep -c '^ *- \[x\]' "$f" || true)

  if grep -qiE '^#{1,3} .*(accept|verif|done|criteri|proof|pass|check)' "$f"; then
    head='prose'
  else
    head='-'
  fi

  # The interesting state: no boxes at all. Say which kind it is.
  if [ "$open" = 0 ] && [ "$tick" = 0 ]; then
    note="NO BOXES ($([ "$head" = prose ] && echo 'prose criteria — assessable, just uncountable' || echo 'and no criteria heading — REVIEW'))"
  elif [ "$open" = 0 ]; then
    # NOT "close-out candidate" — that is a verdict this script has no evidence for.
    # `ticked=N` says every box that was WRITTEN is ticked; it says nothing about
    # criteria that should have been written and were not. A card with two shallow
    # boxes prints the same as one with nine thorough ones. Calling it a close-out
    # candidate would rebuild, one column over, the exact conflation this script
    # exists to break.
    note='all WRITTEN boxes ticked — read the card before closing'
  else
    note=''
  fi

  printf '%-10s %-10s open=%-3s ticked=%-3s criteria=%-6s %s\n' \
    "$id" "$col" "$open" "$tick" "$head" "$note"
done
