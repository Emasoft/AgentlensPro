import subprocess, shutil, sys

import os
HERE = os.path.dirname(os.path.abspath(__file__))
G = os.path.join(HERE, "deny-pkgmanager-symlink-purge.js")
T = os.path.join(HERE, "test-deny-pkgmanager-symlink-purge.js")
BAK = G + ".mutbak"
shutil.copy(G, BAK)
src = open(G).read()

# Each mutation reintroduces ONE fix's absence. The matrix must FAIL for every one; a mutation that
# leaves it green means that fix is pinned by nothing.
mutations = [
    ("launcher set",    "'npx', 'time', 'exec', 'command', 'nice', 'sudo'])", "])"),
    ("& / | reset",     "if (part === '||' || part === '&' || part === '|') { dir = sessionCwd; continue }",
                        "if (part === '||') { dir = sessionCwd; continue }"),
    ("pushd in cd re",  "(?:cd|pushd)", "(?:cd)"),
    ("subshell push",   "if (part === '(') { stack.push(dir); continue }",
                        "if (part === '(') { dir = sessionCwd; continue }"),
    ("pnpm-ws marker",  "if (fs.existsSync(path.join(cur, 'pnpm-workspace.yaml'))) return cur", "if (false) return cur"),
    ("git marker",      "if (fs.existsSync(path.join(cur, '.git'))) return cur", "if (false) return cur"),
    ("workspaces field","if (pkg && pkg.workspaces) return cur", "if (false) return cur"),
]

bad = 0
for name, old, new in mutations:
    if src.count(old) != 1:
        # A stale anchor is a HARD failure, never a skip. A partly-stale run still prints CAUGHT
        # rows for the mutations that did apply, which reads as success — and that is how a harness
        # silently stops testing what its name claims. Twice on 2026-09-03 this reported failures
        # that were its own staleness; both times the honest response was to refresh the anchor so
        # it probes the SAME semantic, not to substitute an easier mutation under the old row name.
        print(f"STALE ANCHOR  {name}: matched {src.count(old)} times, expected 1 — refresh it")
        bad += 1
        continue
    open(G, "w").write(src.replace(old, new, 1))
    r = subprocess.run(["node", T], capture_output=True, text=True)
    caught = r.returncode != 0
    if not caught:
        bad += 1
    fails = [l.split("  ")[-1] for l in r.stdout.splitlines() if l.startswith("FAIL") and "installed copy" not in l]
    print(f"{'CAUGHT' if caught else 'BLIND '}  {name:16s}  {fails[:2] if caught else 'suite stayed GREEN'}")
    open(G, "w").write(src)

shutil.copy(BAK, G)
os.remove(BAK)
r = subprocess.run(["node", T], capture_output=True, text=True)
print(f"\nrestored exit={r.returncode}")
print("ALL FIXES PINNED" if bad == 0 else f"{bad} FIX(ES) NOT PINNED")
sys.exit(bad)
