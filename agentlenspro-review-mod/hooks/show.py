"""agentlenspro-review-mod Stop/SubagentStop command hook: print the mod's coloured user-only report as a systemMessage (TRDD-KZCSO0R2).

Why a command hook: a mod's classic.Stop handler cannot return systemMessage, and $.ui.log draws every row dim grey
with ESC turned into U+FFFD. A command hook's {"systemMessage": ...} is drawn with real ANSI colour and real newlines,
and the model never receives it (measured on Claude Code 2.1.325, 2026-11-14). On SubagentStop it is drawn in that
subagent's own view, in colour (measured, probe-060), not in the main view.

Handoff: the mod (hooks/register.js, writeDisplay) writes the finished, coloured text ONCE per main-thread Stop to
<cwd>/.claude/tmp/agentlenspro-review-mod/<session_id>.txt, and once per typed subagent's SubagentStop to
<session_id>__<agent_id>.txt (0.6.0), BEFORE it calls next(e); this hook runs inside that next(e)
(measured), so the file is complete when it is read. Both sides take cwd, session_id and agent_id from the same payload
(owner decision 0.5.1: no HOME, no USERPROFILE, no CLAUDE_PLUGIN_DATA). The mod writes the file on every main-thread
Stop, empty when there is nothing to show, so a leftover is overwritten before it could be shown.

The folder holds temp files only (owner: "once it is been printed on screen, it can be deleted"): this session's file
is deleted as soon as it is read; every other file older than STALE_SECONDS is deleted on every run (a crashed
session's leftover); a younger one is kept, because it may be another session in the same project between its mod
write and its own Stop hook. A `*` .gitignore keeps the folder out of git status. Nothing outside the folder is
touched, and a project where the mod never wrote has no folder and is left alone. Exactly one JSON object, or nothing,
goes to stdout, and the exit code is always 0 (non-zero takes the hook error path, not the display path).
"""
import json
import os
import re
import stat
import sys
import time

DISPLAY_DIR = (".claude", "tmp", "agentlenspro-review-mod")
SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
STALE_SECONDS = 120
KEEP = ".gitignore"
# Hook output is capped at 10,000 characters (hooks docs); past it the output is replaced by a preview and the colour is
# lost. The budget is measured on the SERIALIZED payload (json.dumps spends 6 characters per ESC), with a margin.
BUDGET = 9000
RESET = "\x1b[0m"
NOTE = RESET + "\n(truncated)"


def fit(text):
    """Drop whole trailing lines until the serialized payload, note included, fits BUDGET.

    Line-safe: an SGR escape never contains a newline, so a cut at a line boundary never splits one, and the mod
    closes every coloured span on its own line. The RESET in the note closes anything left open anyway. Nothing of the
    cut text is kept (owner: once printed, it can be deleted)."""
    lines = text.split("\n")
    while lines:
        candidate = "\n".join(lines) + NOTE
        if len(json.dumps({"systemMessage": candidate})) <= BUDGET:
            return candidate
        lines.pop()
    return NOTE.lstrip("\n")


def sweep(folder, now):
    """Delete every regular file in the folder older than STALE_SECONDS, except the .gitignore; never follow a link."""
    try:
        names = os.listdir(folder)
    except OSError:
        return
    for name in names:
        if name == KEEP:
            continue
        path = os.path.join(folder, name)
        try:
            st = os.lstat(path)
            if stat.S_ISREG(st.st_mode) and now - st.st_mtime > STALE_SECONDS:
                os.remove(path)
        except OSError:
            continue  # gone already (the other session's own hook) or not ours to remove: leave it


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    if not isinstance(payload, dict):
        return 0
    cwd, session_id = payload.get("cwd"), payload.get("session_id")
    if not isinstance(cwd, str) or not os.path.isabs(cwd) or not isinstance(session_id, str) or not SESSION_ID.match(session_id):
        return 0
    folder = os.path.join(cwd, *DISPLAY_DIR)
    if not os.path.isdir(folder):
        return 0
    gitignore = os.path.join(folder, KEEP)
    if not os.path.exists(gitignore):
        try:
            with open(gitignore, "w", encoding="utf-8") as fh:
                fh.write("*\n")
        except OSError:
            pass  # the report still prints; the mod writes the same file before each Stop
    now = time.time()
    # SubagentStop (0.6.0): the file is <session_id>__<agent_id>.txt, picked strictly by the payload's agent_id and NEVER
    # the main <session_id>.txt: every main-review $.model.fork fires a SubagentStop with the same session id, and falling
    # back would steal or delete the main display. The mod's scan copy of that agent's messages goes here too.
    if payload.get("hook_event_name") == "SubagentStop":
        agent_id = payload.get("agent_id")
        base = session_id + "__" + agent_id if isinstance(agent_id, str) and SESSION_ID.match(agent_id) else None
    else:
        base = session_id
    text = ""
    if base is not None:
        if base != session_id:
            try:
                os.remove(os.path.join(folder, base + ".scan.jsonl"))
            except OSError:
                pass  # this agent's stop was not reviewed (no copy), or the sweep removes it later
        path = os.path.join(folder, base + ".txt")
        try:
            age = now - os.stat(path).st_mtime
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            os.remove(path)
            if age > STALE_SECONDS:
                text = ""
        except OSError:  # no file this Stop (the usual case when the mod wrote nothing), or unreadable
            pass
    sweep(folder, now)
    text = text.rstrip("\n")
    if text.strip() == "":
        return 0
    if len(json.dumps({"systemMessage": text})) > BUDGET:
        text = fit(text)
    print(json.dumps({"systemMessage": text}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
