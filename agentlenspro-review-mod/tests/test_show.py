"""Tests of hooks/show.py, the Stop/SubagentStop command hook that prints the mod's display file (0.7.13).

Run: python3 -I tests/test_show.py -v   (standard library only; `claude plugin test` runs only *.test.ts files, not this one).

What is real: show.main() itself, a real display file under a temporary folder, its real mtime, the real json.dumps measure.
Nothing is stubbed but stdin, stdout and the environment. The displays are built here in the shape register.js writes
(usageTable rows painted with SGR spans, a HELD_END line after the held boxes); the register.js side of that contract is
tested in tests/held-interrupted.test.ts.
"""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("review_mod_show", os.path.join(HERE, "..", "hooks", "show.py"))
show = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(show)

SESSION = "test-session-1"
ESC = "\x1b"


def paint(code, text):
    return f"{ESC}[{code}m{text}{ESC}[0m"


def usage_box(title):
    """A usage box shaped like register.js usageTable (two sections, 80 cells wide, every span closed on its own row)."""
    rule = lambda left, right: paint("94", left + "─" * 78 + right)
    row = lambda text: paint("94", "╎") + " " + paint("93", text.ljust(76)) + " " + paint("94", "╎")
    bar = paint("94", "╎") + " " + paint("92", "█" * 50) + paint("91", "█" * 26) + " " + paint("94", "╎")
    lines = [rule("╭", "╮"), row(f"REVIEW-MOD USAGE | claude-opus-5 | {title}"), rule("├", "┤")]
    for section in ("TURN UNDER REVIEW (main):", "REVIEW TURN:"):
        lines += [row(section), bar, row("  hit 66.0% · miss 34.0%"), row("  in 2,807 · out 1,464 · cache read 120,000 · cache create 61,000"), row("  cost of this turn: $0.0203")]
        if section.startswith("TURN"):
            lines.append(rule("├", "┤"))
    lines.append(rule("╰", "╯"))
    return lines


def report(verdict, tag, findings):
    head = f"[AGENTLENSPRO-REVIEW-REPORT] (run by the harness{tag})"
    body = [f"VERDICT: {verdict}"] + [f"{i}. [{kind}] {claim} " + "x" * 160 + " — evidence — fix" for i, (kind, claim) in enumerate(findings, 1)]
    return [head] + body + ["NOT-DO: " + "n" * 120, "WRONG-IF: " + "w" * 120, "WEAKEST LINK: one sentence — SETTLE WITH: git diff"]


HELD_FINDINGS = [("SHOULD-FIX", "held finding one"), ("NIT", "held finding two"), ("NIT", "held finding three")]
CURRENT_FINDINGS = [("BLOCKER", "current blocker one"), ("BLOCKER", "current blocker two"), ("SHOULD-FIX", "current fix three"), ("NIT", "current nit four")]
HELD = ["interrupted turn 10:59"] + report("PASS", ", interrupted turn", HELD_FINDINGS) + usage_box("held")
CURRENT_REPORT = report("BLOCK", "", CURRENT_FINDINGS)
CURRENT = CURRENT_REPORT + usage_box("current")


class ShowTest(unittest.TestCase):
    def setUp(self):
        self.cwd = tempfile.mkdtemp(prefix="review-mod-show-test-")
        self.folder = os.path.join(self.cwd, *show.DISPLAY_DIR)
        os.makedirs(self.folder)

    def tearDown(self):
        shutil.rmtree(self.cwd)  # the temporary folder this test made, nothing else

    def run_hook(self, text, age=0.0, env=None):
        """Write the display file (aged `age` seconds), run show.main(), return the printed systemMessage or None."""
        path = os.path.join(self.folder, SESSION + ".txt")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        if age:
            then = time.time() - age
            os.utime(path, (then, then))
        payload = json.dumps({"cwd": self.cwd, "session_id": SESSION, "hook_event_name": "Stop"})
        out = io.StringIO()
        with mock.patch.object(show.sys, "stdin", io.StringIO(payload)), mock.patch.dict(os.environ, env or {"TERM": "xterm-256color"}, clear=True), contextlib.redirect_stdout(out):
            self.assertEqual(show.main(), 0)
        printed = out.getvalue()
        if printed == "":
            return None
        self.assertLessEqual(len(printed.rstrip("\n")), show.BUDGET, "the printed payload is over the budget")
        return json.loads(printed)["systemMessage"]

    def test_preconditions_of_the_over_budget_display(self):
        """The display used below is over the budget whole, and this turn's part alone is within it."""
        self.assertFalse(show.fits("\n".join(HELD + CURRENT)))
        self.assertTrue(show.fits("\n".join(CURRENT)))

    def test_held_box_over_budget_keeps_the_current_block_verdict_and_findings(self):
        """IT5KUORN: with one held box and a BLOCK report of this turn over the budget, the BLOCK verdict, every finding and the box of this turn are shown."""
        message = self.run_hook("\n".join(HELD + [show.HELD_END] + CURRENT) + "\n")
        lines = message.split("\n")
        for line in CURRENT_REPORT:
            self.assertIn(line, lines)
        self.assertEqual(lines[-len(usage_box("current")):], usage_box("current"))
        self.assertIn(show.HELD_TRUNCATED, lines)
        self.assertNotIn(show.HELD_END, message)
        # The held part goes first: its usage box is gone, its heading is still there.
        self.assertNotIn(paint("93", "REVIEW-MOD USAGE | claude-opus-5 | held".ljust(76)), message)
        self.assertEqual(lines[0], "interrupted turn 10:59")

    def test_the_held_usage_box_goes_before_the_held_report(self):
        """IT5KUORN: when dropping the held usage box is enough, the held report stays whole."""
        small_current = report("BLOCK", "", CURRENT_FINDINGS[:1]) + usage_box("current")
        text = "\n".join(HELD + [show.HELD_END] + small_current)
        self.assertFalse(show.fits(text))
        held_report = HELD[: HELD.index(usage_box("held")[0])]
        self.assertTrue(show.fits("\n".join(held_report + [show.HELD_TRUNCATED] + small_current)))
        message = self.run_hook(text + "\n")
        self.assertEqual(message.split("\n"), held_report + [show.HELD_TRUNCATED] + small_current)

    def test_within_budget_the_held_end_line_is_never_printed(self):
        """IT5KUORN: a display within the budget prints held and current rows as written, without the HELD_END line."""
        held = ["interrupted turn 11:02", "VERDICT: PASS"]
        current = ["[AGENTLENSPRO-REVIEW-REPORT] (run by the harness)", "VERDICT: BLOCK", "1. [BLOCKER] a — b — c"]
        message = self.run_hook("\n".join(held + [show.HELD_END] + current) + "\n")
        self.assertEqual(message.split("\n"), held + current)

    def test_a_current_report_too_big_alone_still_keeps_its_verdict_and_box(self):
        """IT5KUORN: when even this turn's part is over the budget, its first lines and its whole usage box are kept."""
        big = report("BLOCK", "", CURRENT_FINDINGS * 8)
        message = self.run_hook("\n".join(HELD + [show.HELD_END] + big + usage_box("current")) + "\n")
        lines = message.split("\n")
        self.assertIn("VERDICT: BLOCK", lines)
        self.assertEqual(lines[-len(usage_box("current")):], usage_box("current"))
        self.assertIn(show.TRUNCATED, lines)
        self.assertNotIn("interrupted turn 10:59", lines)

    def test_colour_off_still_puts_the_current_report_first(self):
        """IT5KUORN: with NO_COLOR the cut works on the monochrome text and no escape code is printed."""
        message = self.run_hook("\n".join(HELD + [show.HELD_END] + CURRENT) + "\n", env={"NO_COLOR": "1"})
        self.assertNotIn(ESC, message)
        self.assertIn("VERDICT: BLOCK", message.split("\n"))
        for line in CURRENT_REPORT:
            self.assertIn(line, message.split("\n"))

    def test_without_held_boxes_the_last_box_is_kept_as_before(self):
        """Control: a display with no HELD_END line is cut by fit() as in 0.7.12 (report lines from the end, box kept)."""
        big = report("BLOCK", "", CURRENT_FINDINGS * 8)
        message = self.run_hook("\n".join(big + usage_box("current")) + "\n")
        lines = message.split("\n")
        self.assertEqual(lines[0], big[0])
        self.assertEqual(lines[-len(usage_box("current")):], usage_box("current"))
        self.assertIn(show.TRUNCATED, lines)

    def test_a_stale_display_with_text_is_dropped_with_one_line(self):
        """0IFG1B11 case e: a display file older than STALE_SECONDS is not shown, and one line says it was dropped and why."""
        message = self.run_hook("\n".join(CURRENT_REPORT) + "\n", age=show.STALE_SECONDS + 180)
        self.assertEqual(message.split("\n"), [show.STALE.format(age=show.STALE_SECONDS + 180, limit=show.STALE_SECONDS)])
        self.assertFalse(os.path.exists(os.path.join(self.folder, SESSION + ".txt")))

    def test_a_stale_empty_display_prints_nothing(self):
        """0IFG1B11 case e: the empty file a quiet Stop leaves says nothing, however old."""
        self.assertIsNone(self.run_hook("", age=show.STALE_SECONDS + 180))

    def test_a_fresh_display_is_shown(self):
        """Control for case e: a display file younger than STALE_SECONDS is shown as written."""
        self.assertEqual(self.run_hook("one\ntwo\n", age=5).split("\n"), ["one", "two"])


if __name__ == "__main__":
    unittest.main()