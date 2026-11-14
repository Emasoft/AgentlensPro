"""agentlenspro-review-mod Stop command hook: print the mod's coloured user-only report as a systemMessage (TRDD-KZCSO0R2).

Why a command hook: a mod's classic.Stop handler cannot return systemMessage, and $.ui.log draws every row dim grey
with ESC turned into U+FFFD. A command hook's {"systemMessage": ...} is drawn with real ANSI colour and real newlines,
and the model never receives it (measured on Claude Code 2.1.325, 2026-11-14).

Handoff: the mod (hooks/register.js, writeDisplay) writes the finished, coloured text ONCE per main-thread Stop to
$HOME/.claude/plugins/data/agentlenspro-review-mod/display/<session_id>.txt BEFORE it calls next(e); this hook runs
inside that next(e) (measured), so the file is complete when it is read. The path is computed from HOME on both sides:
CLAUDE_PLUGIN_DATA is not used because the mod process cannot see it. The mod writes the file on every main-thread
Stop, empty when there is nothing to show, so a leftover is overwritten before it could be shown; as a second guard a
file older than STALE_SECONDS is deleted unread. The file is always deleted here (the mod cannot delete: $.fs has no
remove). Exactly one JSON object, or nothing, goes to stdout, and the exit code is always 0 (non-zero takes the hook
error path, not the display path).
"""
import json
import os
import re
import sys
import time

SUBDIR = (".claude", "plugins", "data", "agentlenspro-review-mod", "display")
SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
STALE_SECONDS = 120
# Hook output is capped at 10,000 characters (hooks docs); past it the output is replaced by a preview and the colour is
# lost. The budget is measured on the SERIALIZED payload (json.dumps spends 6 characters per ESC), with a margin.
BUDGET = 9000
RESET = "\x1b[0m"


def fit(text, full_name):
    """Drop whole trailing lines until the serialized payload, note included, fits BUDGET.

    Line-safe: an SGR escape never contains a newline, so a cut at a line boundary never splits one, and the mod
    closes every coloured span on its own line. The RESET in the note closes anything left open anyway."""
    lines = text.split("\n")
    note = f"{RESET}\n[review-mod: report cut to fit the 10,000-character hook limit; full text in ~/{'/'.join(SUBDIR)}/{full_name}]"
    while lines:
        candidate = "\n".join(lines) + note
        if len(json.dumps({"systemMessage": candidate})) <= BUDGET:
            return candidate
        lines.pop()
    return note.lstrip("\n")


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    session_id = payload.get("session_id") if isinstance(payload, dict) else None
    home = os.environ.get("HOME")
    if not home or not isinstance(session_id, str) or not SESSION_ID.match(session_id):
        return 0
    folder = os.path.join(home, *SUBDIR)
    path = os.path.join(folder, session_id + ".txt")
    try:
        age = time.time() - os.stat(path).st_mtime
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except FileNotFoundError:
        return 0
    if age > STALE_SECONDS or text.strip() == "":
        os.remove(path)
        return 0
    text = text.rstrip("\n")
    if len(json.dumps({"systemMessage": text})) > BUDGET:
        # Keep the whole report under a name this hook never reads as current, so the cut is not a loss.
        full_name = "full-" + time.strftime("%Y%m%d_%H%M%S") + ".txt"
        os.replace(path, os.path.join(folder, full_name))
        text = fit(text, full_name)
    else:
        os.remove(path)
    print(json.dumps({"systemMessage": text}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
