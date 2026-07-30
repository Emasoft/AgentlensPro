#!/usr/bin/env python3
"""safe_config_edit.py — THE transactional editor for configuration files.

Every AgentLens write to a user configuration file (~/.claude/settings.json,
~/.codex/config.toml, VS Code settings.json, the telemetry marker, ...) MUST go
through this script. It exists because on 2026-07-07 a legacy writer responded
to a JSON parse failure by "starting fresh" and replaced a user's 57.8 KB
~/.claude/settings.json with a 620-byte file containing only AgentLens keys.
This editor makes that class of bug structurally impossible:

  1. SNAPSHOT   read the original bytes. An EXISTING file that fails to parse
                is REFUSED (exit 2) — never rebuilt, never "recovered".
  2. APPLY      declared ops (set / delete / append_unique) on a deep copy.
  3. VERIFY     structural diff original→new BEFORE any write: every leaf that
                existed before must be present and equal after unless its path
                is declared in an op; nothing changes outside the op paths.
                A bug in apply/serialize dies here, not on the user's disk.
  4. LINT       serialize → re-parse → round-trip equality.
  5. BACKUP     timestamped sibling copy, written atomically (tmp + rename).
  6. STAGE      write a temp sibling, fsync, RE-READ IT FROM DISK, re-verify;
                confirm the target was not concurrently modified meanwhile.
  7. COMMIT     os.replace (atomic on POSIX and Windows).
  8. AUDIT      re-read the committed file, verify it equals the new tree;
                on mismatch restore the backup and fail.
  9. LOCK+RETRY a sidecar lock file serializes writers across processes (the
                torn-write race source); transient failures retry with backoff
                up to --retries, then the transaction CANCELS with the original
                file untouched.

Stdlib only — must run on any python3 ≥ 3.8 (TOML mode needs 3.11's tomllib
and refuses loudly below that).

CLI:
  python3 safe_config_edit.py --file PATH --format json|toml [--retries 3]
                              [--no-backup] [--create-if-missing] < spec.json

Spec (stdin, JSON):
  { "ops": [
      {"op": "set",    "path": ["env", "OTEL_..."], "value": "..."},
      {"op": "delete", "path": ["env", "STALE"]},
      {"op": "append_unique", "path": ["hooks", "Stop"], "value": {...},
       "unique_by_substring": ".agentlens/pending-prompt.txt"},
      {"op": "remove_by_substring", "path": ["hooks", "Stop"],
       "substring": "my-hook.py", "nested_key": "hooks"},   // nested_key optional
      {"op": "ensure_line_in_section",              // TOML mode only
       "section": "otel", "key_prefix": "exporter", "line": "exporter = ..."}
  ] }

Stdout on success: {"changed": bool, "backupPath": str|null, "attempts": int}
Exit codes: 0 ok (changed or no-op) · 2 refused (existing file unparseable /
JSONC / missing without --create-if-missing) · 3 verify failed · 4 lock
timeout · 5 concurrent modification retries exhausted · 6 bad spec ·
7 unsupported (e.g. TOML without tomllib).
"""

import argparse
import copy
import errno
import json
import os
import sys
import time
from datetime import datetime


# ---------------------------------------------------------------------------
# Failure taxonomy — each maps to a distinct exit code so callers can react
# precisely (refuse ≠ retry-exhausted ≠ verify-bug).
# ---------------------------------------------------------------------------
class Refused(Exception):
    exit_code = 2


class VerifyFailed(Exception):
    exit_code = 3


class LockTimeout(Exception):
    exit_code = 4


class ConcurrentModification(Exception):
    exit_code = 5


class BadSpec(Exception):
    exit_code = 6


class Unsupported(Exception):
    exit_code = 7


# ---------------------------------------------------------------------------
# Leaf flattening — the basis of the verify-diff. A "leaf" is any non-dict
# value (lists are leaves: order matters and partial list edits are only
# expressible via append_unique, which is verified as a whole-list change).
# ---------------------------------------------------------------------------
def flatten(tree, prefix=()):
    out = {}
    if isinstance(tree, dict):
        if not tree:
            out[prefix + ("<empty-dict>",)] = "{}"
        for k, v in tree.items():
            out.update(flatten(v, prefix + (str(k),)))
    else:
        # json.dumps gives a canonical, comparable form for any leaf incl. lists
        out[prefix] = json.dumps(tree, sort_keys=True, ensure_ascii=False)
    return out


def path_covered(leaf_path, op_paths):
    """A leaf is covered when an op path equals it or is a prefix of it
    (setting env.X covers env.X and everything below it), or when the leaf is
    an ancestor's empty-dict marker created on the way to an op path."""
    for op_path in op_paths:
        op_t = tuple(op_path)
        if leaf_path[: len(op_t)] == op_t:
            return True
        # parent containers materialized for a deeper set: ("env","<empty-dict>")
        # is covered by op path ("env","KEY")
        if leaf_path and leaf_path[-1] == "<empty-dict>" and op_t[: len(leaf_path) - 1] == leaf_path[:-1]:
            return True
    return False


def verify_diff(original_tree, new_tree, ops):
    """THE guarantee: nothing outside the declared op paths changed.
    Raises VerifyFailed with the exact offending paths otherwise."""
    op_paths = [op["path"] for op in ops if "path" in op]
    before = flatten(original_tree)
    after = flatten(new_tree)

    lost = [p for p in before if p not in after and not path_covered(p, op_paths)]
    mutated = [
        p for p in before
        if p in after and before[p] != after[p] and not path_covered(p, op_paths)
    ]
    invented = [p for p in after if p not in before and not path_covered(p, op_paths)]

    if lost or mutated or invented:
        raise VerifyFailed(
            "verify-diff REJECTED the transaction: "
            + (f"leaves LOST outside op paths: {[list(p) for p in lost]}; " if lost else "")
            + (f"leaves CHANGED outside op paths: {[list(p) for p in mutated]}; " if mutated else "")
            + (f"leaves ADDED outside op paths: {[list(p) for p in invented]}" if invented else "")
        )

    # Each op must have done exactly what it declared.
    for op in ops:
        kind = op["op"]
        if kind == "set":
            node = new_tree
            for seg in op["path"]:
                if not isinstance(node, dict) or seg not in node:
                    raise VerifyFailed(f"set op path {op['path']} missing after apply")
                node = node[seg]
            if json.dumps(node, sort_keys=True) != json.dumps(op["value"], sort_keys=True):
                raise VerifyFailed(f"set op path {op['path']} holds a different value after apply")
        elif kind == "delete":
            node = new_tree
            present = True
            for seg in op["path"]:
                if not isinstance(node, dict) or seg not in node:
                    present = False
                    break
                node = node[seg]
            if present:
                raise VerifyFailed(f"delete op path {op['path']} still present after apply")
        elif kind == "remove_by_substring":
            node = new_tree
            for seg in op["path"]:
                if not isinstance(node, dict) or seg not in node:
                    node = None
                    break
                node = node[seg]
            if isinstance(node, list):
                needle = op["substring"]
                nested = op.get("nested_key")
                # Assert exactly what the op promised. With nested_key the promise
                # is scoped to the nested arrays -- an element that mentions the
                # needle OUTSIDE them (e.g. in a matcher string) is deliberately
                # kept, so asserting on the whole array would reject a correct run.
                if nested:
                    survivors = [
                        x for el in node if isinstance(el, dict) and isinstance(el.get(nested), list)
                        for x in el[nested]
                    ]
                else:
                    survivors = node
                if any(needle in json.dumps(el, ensure_ascii=False) for el in survivors):
                    raise VerifyFailed(
                        f"remove_by_substring at {op['path']}: "
                        f"{needle!r} still present after apply"
                    )


# ---------------------------------------------------------------------------
# Op application (deep copy in, mutated copy out — original never touched)
# ---------------------------------------------------------------------------
def apply_ops(tree, ops):
    new_tree = copy.deepcopy(tree)
    changed = False
    for op in ops:
        kind = op.get("op")
        if kind == "set":
            node = new_tree
            for seg in op["path"][:-1]:
                nxt = node.get(seg)
                if nxt is None:
                    nxt = {}
                    node[seg] = nxt
                if not isinstance(nxt, dict):
                    raise Refused(
                        f"cannot set {op['path']}: '{seg}' exists but is not an object — refusing to overwrite it"
                    )
                node = nxt
            leaf = op["path"][-1]
            if json.dumps(node.get(leaf), sort_keys=True) != json.dumps(op["value"], sort_keys=True):
                node[leaf] = op["value"]
                changed = True
        elif kind == "delete":
            node = new_tree
            ok = True
            for seg in op["path"][:-1]:
                node = node.get(seg) if isinstance(node, dict) else None
                if node is None:
                    ok = False
                    break
            if ok and isinstance(node, dict) and op["path"][-1] in node:
                del node[op["path"][-1]]
                changed = True
        elif kind == "append_unique":
            node = new_tree
            for seg in op["path"][:-1]:
                nxt = node.get(seg)
                if nxt is None:
                    nxt = {}
                    node[seg] = nxt
                if not isinstance(nxt, dict):
                    raise Refused(f"cannot append at {op['path']}: '{seg}' is not an object")
                node = nxt
            leaf = op["path"][-1]
            arr = node.get(leaf)
            if arr is None:
                arr = []
                node[leaf] = arr
            if not isinstance(arr, list):
                raise Refused(f"append_unique at {op['path']}: target is not an array")
            needle = op["unique_by_substring"]
            if not any(needle in json.dumps(el, ensure_ascii=False) for el in arr):
                arr.append(op["value"])
                changed = True
        elif kind == "remove_by_substring":
            # The symmetric counterpart of append_unique, and it exists for the same
            # reason (S3-F5): a caller that removes entries by computing the surviving
            # array and sending `set` computes it from a read taken BEFORE the lock, so
            # a foreign entry another tool appends in between is clobbered. Evaluated
            # here, the filter runs on the fresh tree inside the lock instead.
            needle = op.get("substring")
            if not isinstance(needle, str) or not needle:
                raise BadSpec("remove_by_substring requires a non-empty 'substring'")
            nested = op.get("nested_key")
            if nested is not None and not isinstance(nested, str):
                raise BadSpec("remove_by_substring 'nested_key' must be a string")

            container = new_tree
            for seg in op["path"][:-1]:
                container = container.get(seg) if isinstance(container, dict) else None
                if container is None:
                    break
            if not isinstance(container, dict):
                continue  # the path does not exist -- a no-op, not an error
            leaf = op["path"][-1]
            arr = container.get(leaf)
            if arr is None:
                continue  # nothing there to remove -- a no-op, not an error
            if not isinstance(arr, list):
                raise Refused(f"remove_by_substring at {op['path']}: target is not an array")

            def hit(element):
                return needle in json.dumps(element, ensure_ascii=False)

            kept = []
            for el in arr:
                if nested and isinstance(el, dict) and isinstance(el.get(nested), list):
                    inner = [x for x in el[nested] if not hit(x)]
                    if not inner:
                        continue  # the element held only ours -- drop the husk
                    kept.append({**el, nested: inner} if len(inner) != len(el[nested]) else el)
                elif hit(el):
                    continue
                else:
                    kept.append(el)
            if json.dumps(kept, ensure_ascii=False) != json.dumps(arr, ensure_ascii=False):
                container[leaf] = kept
                changed = True
        else:
            raise BadSpec(f"unknown op kind: {kind!r}")
    return new_tree, changed


# ---------------------------------------------------------------------------
# Atomic IO helpers
# ---------------------------------------------------------------------------
def fsync_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, data.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_backup(target, raw):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S") + f"{datetime.now().microsecond // 1000:03d}"
    backup = f"{target}.agentlens-bak-{ts}"
    tmp = f"{backup}.{os.getpid()}.tmp"
    fsync_write(tmp, raw)
    os.replace(tmp, backup)
    return backup


class FileLock:
    """O_EXCL sidecar lock. Serializes ALL safe_config_edit writers to one file
    across processes — the torn-write race (two servers writing settings.json
    simultaneously) is what corrupted the JSON that the old writer then 'fixed'
    by wiping. Stale locks (>30s, e.g. a killed process) are broken with a note."""

    def __init__(self, target, timeout=20.0):
        self.lock_path = target + ".agentlens-lock"
        self.timeout = timeout
        self.acquired = False

    def __enter__(self):
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.write(fd, f"{os.getpid()} {time.time()}\n".encode())
                os.close(fd)
                self.acquired = True
                return self
            except OSError as e:
                if e.errno != errno.EEXIST:
                    raise
                try:
                    age = time.time() - os.stat(self.lock_path).st_mtime
                    if age > 30.0:
                        os.unlink(self.lock_path)  # stale: owner died mid-transaction
                        continue
                except FileNotFoundError:
                    continue
                if time.monotonic() > deadline:
                    raise LockTimeout(f"could not acquire {self.lock_path} within {self.timeout}s")
                time.sleep(0.15)

    def __exit__(self, *_exc):
        if self.acquired:
            try:
                os.unlink(self.lock_path)
            except FileNotFoundError:
                pass


# ---------------------------------------------------------------------------
# JSON transaction
# ---------------------------------------------------------------------------
def read_json_or_refuse(target, create_if_missing):
    try:
        with open(target, "r", encoding="utf-8") as f:
            raw = f.read()
    except FileNotFoundError:
        if create_if_missing:
            return None, {}
        raise Refused(f"{target} does not exist (pass --create-if-missing to allow creation)")
    try:
        tree = json.loads(raw)
    except json.JSONDecodeError as e:
        # THE rule this whole file exists for: an existing-but-unparseable config
        # is NEVER rebuilt. (Also catches JSONC — VS Code settings with comments.)
        raise Refused(
            f"{target} exists but is not valid strict JSON ({e}). REFUSING to touch it. "
            "Fix the file (or its JSONC comments) manually, then retry."
        )
    if not isinstance(tree, dict):
        raise Refused(f"{target}: top-level JSON is not an object — refusing.")
    return raw, tree


def transact_json(target, ops, create_if_missing, do_backup):
    raw, tree = read_json_or_refuse(target, create_if_missing)
    new_tree, changed = apply_ops(tree, ops)
    if not changed:
        return {"changed": False, "backupPath": None}

    verify_diff(tree, new_tree, ops)  # gate 1: intent verification (in memory)

    serialized = json.dumps(new_tree, indent=2, ensure_ascii=False) + "\n"
    reparsed = json.loads(serialized)  # gate 2: lint + round-trip
    if json.dumps(reparsed, sort_keys=True) != json.dumps(new_tree, sort_keys=True):
        raise VerifyFailed("serialize→parse round-trip mismatch")

    backup = atomic_backup(target, raw) if (do_backup and raw is not None) else None

    tmp = f"{target}.{os.getpid()}.safeedit.tmp"
    try:
        fsync_write(tmp, serialized)
        with open(tmp, "r", encoding="utf-8") as f:  # gate 3: what actually hit disk
            staged = json.loads(f.read())
        verify_diff(tree, staged, ops)

        # gate 4: the target must not have changed under us since the snapshot
        try:
            with open(target, "r", encoding="utf-8") as f:
                current = f.read()
            if raw is not None and current != raw:
                raise ConcurrentModification(f"{target} was modified during the transaction")
            if raw is None:
                raise ConcurrentModification(f"{target} appeared during the transaction")
        except FileNotFoundError:
            if raw is not None:
                raise ConcurrentModification(f"{target} vanished during the transaction")

        os.replace(tmp, target)  # COMMIT (atomic)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass

    with open(target, "r", encoding="utf-8") as f:  # gate 5: post-commit audit
        committed = json.loads(f.read())
    try:
        verify_diff(tree, committed, ops)
    except VerifyFailed:
        if backup:
            os.replace(backup, target)  # roll back — leave the user whole
        raise

    return {"changed": True, "backupPath": backup}


# ---------------------------------------------------------------------------
# TOML transaction (line-preserving edits, tomllib-verified)
# ---------------------------------------------------------------------------
def transact_toml(target, ops, create_if_missing, do_backup):
    try:
        import tomllib  # py3.11+
    except ImportError:
        raise Unsupported("TOML mode needs python ≥ 3.11 (tomllib) — refusing to edit without structural verification")

    for op in ops:
        if op.get("op") != "ensure_line_in_section":
            raise BadSpec("TOML mode supports only ensure_line_in_section ops")

    try:
        with open(target, "r", encoding="utf-8") as f:
            raw = f.read()
    except FileNotFoundError:
        if not create_if_missing:
            raise Refused(f"{target} does not exist (pass --create-if-missing to allow creation)")
        raw = None

    try:
        original_tree = tomllib.loads(raw) if raw is not None else {}
    except tomllib.TOMLDecodeError as e:
        raise Refused(f"{target} exists but is not valid TOML ({e}). REFUSING to touch it.")

    lines = raw.split("\n") if raw is not None else []
    changed = False
    for op in ops:
        section, prefix, line = op["section"], op["key_prefix"], op["line"]
        header = f"[{section}]"
        idx = next((i for i, l in enumerate(lines) if l.strip() == header), -1)
        if idx == -1:
            if lines and lines[-1].strip():
                lines.append("")
            lines.extend([header, line])
            changed = True
            continue
        end = next(
            (i for i in range(idx + 1, len(lines))
             if lines[i].strip().startswith("[") and not lines[i].strip().startswith("#")),
            len(lines),
        )
        existing = next(
            (i for i in range(idx + 1, end) if lines[i].strip().startswith(prefix)), -1
        )
        if existing != -1:
            if lines[existing] != line:
                lines[existing] = line
                changed = True
        else:
            lines.insert(idx + 1, line)
            changed = True

    if not changed:
        return {"changed": False, "backupPath": None}

    serialized = "\n".join(lines)
    if raw is not None and not serialized.endswith("\n") and raw.endswith("\n"):
        serialized += "\n"

    try:
        new_tree = tomllib.loads(serialized)  # lint gate
    except tomllib.TOMLDecodeError as e:
        raise VerifyFailed(f"edited TOML no longer parses: {e}")

    # verify-diff on the PARSED trees: only keys under the declared
    # (section, key_prefix) pairs may differ; everything else must survive.
    allowed = [(op["section"], op["key_prefix"]) for op in ops]

    def toml_leaves(tree, prefix=()):
        out = {}
        if isinstance(tree, dict):
            for k, v in tree.items():
                out.update(toml_leaves(v, prefix + (k,)))
        else:
            out[prefix] = json.dumps(tree, sort_keys=True, default=str)
        return out

    before, after = toml_leaves(original_tree), toml_leaves(new_tree)

    def toml_covered(path):
        return any(len(path) >= 2 and path[0] == s and path[1].startswith(p) for s, p in allowed)

    bad = (
        [p for p in before if p not in after and not toml_covered(p)]
        + [p for p in before if p in after and before[p] != after[p] and not toml_covered(p)]
        + [p for p in after if p not in before and not toml_covered(p)]
    )
    if bad:
        raise VerifyFailed(f"TOML verify-diff rejected: unexpected changes at {[list(p) for p in bad]}")

    backup = atomic_backup(target, raw) if (do_backup and raw is not None) else None
    tmp = f"{target}.{os.getpid()}.safeedit.tmp"
    try:
        fsync_write(tmp, serialized)
        try:
            with open(target, "r", encoding="utf-8") as f:
                if raw is not None and f.read() != raw:
                    raise ConcurrentModification(f"{target} was modified during the transaction")
        except FileNotFoundError:
            if raw is not None:
                raise ConcurrentModification(f"{target} vanished during the transaction")
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        os.replace(tmp, target)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
    return {"changed": True, "backupPath": backup}


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--format", choices=["json", "toml"], default="json")
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--no-backup", action="store_true")
    ap.add_argument("--create-if-missing", action="store_true")
    args = ap.parse_args()

    try:
        spec = json.load(sys.stdin)
        ops = spec["ops"]
        if not isinstance(ops, list) or not ops:
            raise KeyError("ops")
    except (json.JSONDecodeError, KeyError) as e:
        print(json.dumps({"error": f"bad spec on stdin: {e}"}), file=sys.stderr)
        sys.exit(BadSpec.exit_code)

    target = os.path.expanduser(args.file)
    if args.create_if_missing:
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)

    attempts = 0
    last_error = None
    while attempts < max(1, args.retries):
        attempts += 1
        try:
            with FileLock(target):
                fn = transact_json if args.format == "json" else transact_toml
                result = fn(target, ops, args.create_if_missing, not args.no_backup)
            result["attempts"] = attempts
            print(json.dumps(result))
            return
        except ConcurrentModification as e:
            last_error = e  # someone else won the race — re-snapshot and retry
            time.sleep(0.2 * attempts)
        except (Refused, VerifyFailed, LockTimeout, BadSpec, Unsupported) as e:
            print(json.dumps({"error": str(e), "attempts": attempts}), file=sys.stderr)
            sys.exit(e.exit_code)

    print(json.dumps({"error": f"cancelled after {attempts} attempts: {last_error}", "attempts": attempts}), file=sys.stderr)
    sys.exit(ConcurrentModification.exit_code)


if __name__ == "__main__":
    main()
