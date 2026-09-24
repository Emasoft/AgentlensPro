---
name: ts-dead-code-vs-rust-parity-oracles
description: "is this TypeScript file dead / safe to delete a TS module / unused TS file / not in the bundle / dead code detection false positive / reachability pass over esbuild bundles / which TS modules are actually live / rust-core parity oracle depends on this file / gen-*.mjs fixture generator imports this module / a file no bundle contains is still required / do not delete this TypeScript file / metafile-based reachability misses test-only imports / how do I know a src file is truly unused / out/test compiled parity generator / why did deleting this TS file break rust-core tests"
ocd: 2026-09-24
lmd: 2026-09-24
publish-globally: false
metadata:
  node_type: memory
  type: reference
  tier: component
---

# ts-dead-code-vs-rust-parity-oracles


^ATOM-1PX5-NXV9 [desc: "a TS file with no bundle entry can still be a live rust-core parity oracle, imported by gen-*.mjs fixture generators", keywords: dead_code unused_TS_file safe_to_delete not_in_bundle esbuild_metafile reachability_pass rust-core_parity_oracle gen-*.mjs fixture_generator import_closure import_type bundle-only_reachability dead_module_set parity_suite rust_port_pin, trdd: TRDD-4BZPAQWM, ocd: 2026-09-24, lmd: 2026-09-24]

A TS module absent from every esbuild bundle metafile is NOT necessarily dead code. 46 of the modules a bundle-only reachability pass flagged as dead were actually required by rust-core/**/tests/fixtures/gen-*.mjs (via out/test/<module>.js) — these generators are the parity oracles that pin the Rust port's output against the TypeScript original. A pass keyed on the three esbuild bundles alone (standalone/cli.js, media/dashboard.js, media/sidebar.js) called 89 files dead; the real dead count was 33, once the gen-*.mjs import closure (including `import type`) was unioned with the bundle metafiles. Evidence: reports/4BZPAQWM/20260924_104703+0200-dead-module-set.md. [^1]

## Notes and lessons learned

[^1]: [id: ATOM-8YS8-VO6Z, status: valid, keywords: "dead_code_false_positive unused_TS_file safe_to_delete not_in_bundle esbuild_metafile reachability_pass rust-core_parity_oracle gen-*.mjs_fixture_generator import_closure import_type bundle-only_reachability_wrong dead_module_set", ocd: 2026-09-24, lmd: 2026-09-24] DO NOT delete a TS module because no bundle contains it, BECAUSE rust-core fixture generators require it as a parity oracle. DO union the bundle metafiles with every file gen-*.mjs requires (and its import closure, incl. import type) first.
