---
name: log-scan-performance
description: "the boot scan of the jsonl corpus is slow / the cold scan only uses 3 of 14 cpu cores / why is RAYON_NUM_THREADS=4 faster than the default 14 / the scan spends most of its time in sys not user / how do I make the log scan use all cpu cores / adding more rayon threads does not speed up the scan / the profile says every thread is waiting on a mutex / sharding the listing cache did not help / is the allocator the bottleneck in the scan / mimalloc vs system allocator for the scanner / allogscan is much faster than cold_scan on the same files / why does parse-only beat parse-plus-cards / the scan does hundreds of thousands of stat syscalls / filesStatted is huge / wall clock timings for the scan are wildly inconsistent / how do I benchmark the scan on a busy machine"
ocd: 2026-08-29
lmd: 2026-08-29
publish-globally: false
metadata:
  node_type: memory
  type: project
  tier: component
---

# log-scan-performance


^ATOM-CLZH-GLU8 [desc: "The cold scan's 3.2-of-14-core ceiling is stat-syscall-bound (405k filesStatted), not lock- or allocator-bound; sharding the mutex with capacity held constant changed nothing.", keywords: the_scan_only_uses_3_of_14_cores more_rayon_threads_do_not_help RAYON_NUM_THREADS=4_faster_than_14 every_thread_parked_on_a_mutex_in_the_profile sharding_the_cache_did_not_help is_the_allocator_the_bottleneck allogscan_faster_than_cold_scan hundreds_of_thousands_of_stat_syscalls filesStatted_is_huge high_sys_time_low_user_time how_to_benchmark_a_scan_on_a_busy_machine wall_clock_timings_wildly_inconsistent, ocd: 2026-08-29, lmd: 2026-08-29]

The cold scan's ~3.2-of-14-cores ceiling is STAT-SYSCALL-BOUND, not lock-bound. Measured 2026-08-29 on the same ~8.78 GB corpus, same machine, same minute. Use CPU CORES = (user+sys)/real as the metric, NOT wall clock: two runs of the SAME binary gave 28.4 s and 103.0 s under background load, while the core count stays stable under exactly that load. allogscan (parse only, no card building) reached 5.27/7.29/8.67 cores; cold_scan (parse + cards) reached 3.05/3.13/3.47. THREE CAUSES ELIMINATED BY CONTROLLED EXPERIMENT: (a) the global LISTING mutex in generated_files.rs — sharding it 64 ways with capacity HELD CONSTANT gave 3.16/3.17/3.21, i.e. identical, which is what rules the lock out; (b) the allocator — adding mimalloc to the bench to match the shipped binary gave 2.17/2.58/3.03, no better; (c) rayon thread count — RAYON_NUM_THREADS=4 beats the default 14. THE ACTUAL LIMIT: 22-32 s SYS against 48-54 s USER, 405,436 filesStatted reported by the live server, and a listing cache already at an 88.3% hit rate (19,850 hits / 2,635 readdirs). generated_files.rs::index_scratch_tree stats EVERY directory entry (fs::metadata on the joined path) purely to classify dir-vs-file, while read_dir's DirEntry::file_type() carries that classification for free from d_type. The lever is FEWER stat calls — not more parallelism and not less locking. [^1] [^2]


## See also

- [[agentlenspro-ops-lessons]]

## Notes and lessons learned

[^1]: [id: ATOM-0DDM-BYER, status: valid, keywords: "the_profile_blames_a_mutex all_my_samples_are_under_one_lock is_the_lock_really_the_bottleneck sharding_the_lock_did_not_help psynch_mutexwait_dominates_the_profile threads_waiting_on_a_mutex_but_cores_flat why_did_removing_contention_change_nothing profile_says_lock_contention mutex_wait_samples_100_percent how_do_I_confirm_a_lock_is_the_cause", ocd: 2026-08-29, lmd: 2026-08-29] DO NOT conclude a lock is the bottleneck because the profile puts every mutex-wait sample under it, BECAUSE threads park on a lock as a SYMPTOM of being serialised elsewhere — 25,614 of 25,614 samples sat under list_dir_cached and sharding it 64 ways changed nothing. DO run the controlled experiment (remove that lock's contention, hold everything else constant) before believing the profile.
[^2]: [id: ATOM-3ZTH-JIY4, status: valid, keywords: "my_benchmark_says_worse_but_I_changed_two_things the_per-shard_cap_silently_shrank_the_cache sharding_measured_slower_than_baseline invalid_A/B_comparison why_did_my_optimization_make_it_worse cache_capacity_changed_by_accident benchmark_result_I_cannot_trust two_variables_in_one_experiment did_I_measure_what_I_think_I_measured per-shard_budget_vs_whole-cache_budget", ocd: 2026-08-29, lmd: 2026-08-29] DO NOT change two variables in one A/B, BECAUSE the first sharding test also cut effective cache capacity 5000 to 128 (LISTING_CACHE_MAX is a whole-cache budget, applied per shard) so its 'worse' result measured the capacity cut, not the sharding. DO hold every other knob constant and re-run before citing the number.
