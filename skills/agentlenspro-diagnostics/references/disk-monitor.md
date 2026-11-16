# Disk-space monitor — what the disk did, minute by minute

A permanent sampler records every real volume once a minute into its own DuckDB file, `<dataDir>/disk.duckdb` (never `cards.duckdb`). Questions about disk trends, history, "when exactly did free space drop", or what a folder weighs are answered from it, off disk, with the server down and even while agentlenspro is DISABLED (`disk`, `disk-sample`, `disk-watch` and `disk-monitor status` are exempt from the brake by owner decision: the disk filling up is when everything else is off; `disk-monitor install|uninstall` stay gated and exit 69 while DISABLED).

## Commands

```bash
agentlenspro disk-monitor install|uninstall|status   # the launchd job (macOS): disk-sample every 60 s, no Claude session needed. Opt-in; setup only prints the command.
agentlenspro disk-sample [--quiet]                   # one sample, then exit (what the job runs)
agentlenspro disk now                                # latest row per volume: used, free, avail, trash, used-minus-trash
agentlenspro disk history [--volume V] [--since 6h] [--every 1m|1h|1d]
agentlenspro disk changes [--volume V] [--since 6h] [--min 1G]   # every minute-to-minute change: exact sample time, signed delta, gap since the previous sample
agentlenspro disk top-change [--since 6h] [--top 10] # the biggest single moves
agentlenspro disk trees [--folder PATH] [--since 7d] [--progress]  # folder sizes (apparent/allocated, with/without symlinks); --progress = walks in flight
agentlenspro disk sql "select ... from disk_volume ..."            # ONE SELECT/WITH, READ_ONLY, no file access; add --json
agentlenspro disk-watch add <path> [--kind folder|trash] | remove <path> | list
```

`--json` gives raw bytes; the tables humanize `_b` columns. Run `agentlenspro disk` with no argument for the view list.

## Tables

- `disk_volume(ts, mount, device, fs_type, container, volume_uuid, total_b, used_b, free_b, avail_b, vol_used_b, container_free_b, purgeable_b, important_avail_b, trash_b, used_minus_trash_b, error)` — one row per volume per minute. `used_b`/`free_b` are statfs: on APFS they are CONTAINER-wide (all volumes of the container share the free space), `vol_used_b` is the volume's own bytes. `avail_b` is what an unprivileged process may use. `trash_b` is the latest finished walk of the trash folders on that volume (NULL until one finished); `used_minus_trash_b` = `used_b - trash_b`. Volume rows have NO symlink split — statfs cannot give one; the with/without-symlink view is `disk_tree`. `purgeable_b` and `important_avail_b` are filled only from a key `diskutil info -plist` really returns; on current macOS it returns none, so they are NULL. A failed or timed-out probe is NULL plus `error`, never 0.
- `disk_tree(ts_start, ts_end, path, kind, apparent_b, allocated_b, apparent_follow_b, allocated_follow_b, files, partial, elapsed_ms, error)` — one row per FINISHED walk of a watch-list folder. `apparent` = bytes as files report them; `allocated` = blocks on disk. `*_follow` = the plain totals plus each DISTINCT symlink target outside the folder, counted once (a link into the folder itself, a repeated link, a link into an already-followed tree, a loop, a link to a dir that contains the folder, a hardlink twin: nothing added; a link to another volume is not followed and shows in `error`). Judge sizes against `allocated`: `apparent` counts sparse files at their full logical size and can exceed the disk. `partial` = the walk was closed after 24 h without finishing. Permission-denied folders are counted in `error`, their bytes are missing (grant Full Disk Access to the launchd job's node to see them).
- `disk_watch(path, kind)` — the folders measured. Defaults: `~/Code`, the data dir, `~/Library/Caches`, `~/.Trash`, `.trashcan/` dirs under `~/Code` (depth 3, found when the file is created); every `/Volumes/*/.Trashes/<uid>` is added automatically (`disk-watch list` shows `source=auto`). `~` is not a default: it was measured not to finish in ~27 runs (its *_follow totals counted about twice its plain totals; add it yourself with `disk-watch add ~` if you accept the cost). Roots may overlap.
- `disk_walk_state`, `disk_walk_pending`, `disk_walk_followed` — the cursor of walks in flight; `disk_walk_followed` holds the symlink targets already counted, so a resumed walk never counts one twice. All three are emptied when the walk completes.

## Cost and limits

- Volume rows: about 4 volumes x 1440 rows/day, ~2.1M rows/year, tens of MB. Nothing is deleted.
- Walks are RESUMABLE: measured, `~` and `~/Code` do not finish in 40 s (about 19k files/s), so each run walks within a 40 s budget and the next run continues from the saved stack. A finished folder is walked again after max(15 min, 4 x what its walk cost). Hardlink de-duplication is per run, so a hardlink met in two different runs counts twice.
- The DuckDB file lock is held only while inserting (twice per run); readers retry for 5 s.
