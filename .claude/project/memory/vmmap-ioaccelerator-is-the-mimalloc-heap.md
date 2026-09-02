---
name: vmmap-ioaccelerator-is-the-mimalloc-heap
description: "vmmap says IOAccelerator dominates alcore's memory / footprint shows gigabytes of IOAccelerator for a headless server / why does a Rust server hold GPU memory / is alcore using Metal / IOAccelerator 8.8 GB resident on macOS / vmmap region type IOAccelerator for a process with no GPU code / mimalloc memory does not show up as MALLOC in vmmap / where did the Rust heap go in vmmap / MALLOC_SMALL shows only kilobytes allocated but RSS is gigabytes / how to read vmmap and footprint output for a mimalloc process / VM_MEMORY_IOACCELERATOR tag 100 / mimalloc os_tag default 100 / DuckDB allocations vs Rust allocations in vmmap / which vmmap category is the Rust heap / decomposing alcore resident set by allocator"
ocd: 2026-09-02
lmd: 2026-09-02
publish-globally: false
metadata:
  node_type: memory
  type: project
  tier: component
---

# vmmap-ioaccelerator-is-the-mimalloc-heap


^ATOM-WA0C-AO6Q [desc: "On macOS vmmap and footprint label every mimalloc region IOAccelerator because mimalloc tags its mmaps with VM tag 100; it is the Rust heap, not GPU memory", keywords: vmmap_IOAccelerator footprint_IOAccelerator alcore_GPU_memory Metal_in_a_headless_server mimalloc_vmmap_category VM_MAKE_TAG_100 VM_MEMORY_IOACCELERATOR mimalloc_os_tag Rust_heap_missing_from_MALLOC_zones MALLOC_SMALL_fragmentation_100_percent DuckDB_vs_Rust_heap_split decompose_alcore_RSS MIMALLOC_SHOW_STATS, trdd: TRDD-768NEX6E, ocd: 2026-09-02, lmd: 2026-09-02]

`agentlens-core` sets `mimalloc` as the global allocator, and mimalloc tags every region it `mmap`s with VM tag 100 (`c_src/mimalloc/v2/src/options.c` default `os_tag = 100`; `prim/unix/prim.c` returns `VM_MAKE_TAG(os_tag)`). macOS names tag 100 `VM_MEMORY_IOACCELERATOR` (`mach/vm_statistics.h`), so `vmmap` and `footprint` print the **entire Rust heap** under the label "IOAccelerator". Measured 2026-09-02 on alcore: 8.8 GB resident / 6.5 GB dirty "IOAccelerator" (74 × 128 MB arenas + one 8 GB arena) vs ~2.5 GB in the system MALLOC zones.

**Why:** a first read of that output concludes "a headless server is holding GPU buffers" and refutes the real hypothesis. The Metal/MPS frameworks mapped into the process are transitive dyld loads (the binary links none of them) and are a red herring.

**How to apply:** treat `IOAccelerator` = Rust-side heap and `MALLOC_*` = C/C++ side (DuckDB, which does not route through Rust's global allocator). To attribute the Rust heap by structure, restart with `MIMALLOC_SHOW_STATS=1` or expose a debug endpoint with per-structure byte estimates; do not chase Metal. Set `MIMALLOC_OS_TAG` (100–255) to relabel if a clearer vmmap category is wanted.

## Notes and lessons learned
