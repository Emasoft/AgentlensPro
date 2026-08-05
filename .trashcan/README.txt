# .trashcan/ — project-local recoverable trash

Anything in this directory was put here by the ai-maestro-janitor's
safe-delete skill (or its `safe-delete.sh` script) instead of being
permanently deleted. Each subfolder is one disposal batch:

    .trashcan/
      20260503_181523+0200/    ← mirrored contents of trashed paths
      20260503_181523+0200.txt ← manifest, one original path per line

To restore a batch (any platform):

    # Whole batch — overwrites if names collide at the destination:
    cp -R .trashcan/<timestamp>/. ./

    # Selective, manifest-driven:
    while IFS= read -r p; do
      [ -z "$p" ] || [ "${p#\#}" != "$p" ] && continue
      mv ".trashcan/<timestamp>/${p#./}" "$p"
    done < ".trashcan/<timestamp>.txt"

To purge a batch permanently:

    rm -rf .trashcan/<timestamp>/ .trashcan/<timestamp>.txt

DO NOT delete this directory itself. It is gitignored (so trash never
leaks into commits) but the directory must persist across `git clean -fdx`
sweeps and fresh clones. We achieve that by tracking two marker files
(.gitkeep and README.txt) — they are excluded from .gitignore so git keeps
them under version control, which in turn keeps the directory alive.

The first time safe-delete creates these markers, run:

    git add .trashcan/.gitkeep .trashcan/README.txt
    git commit -m "track .trashcan markers so the trashcan survives clones"

After that, the trashcan is permanent project infrastructure.
