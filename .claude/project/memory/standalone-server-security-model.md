---
name: standalone-server-security-model
description: "can a website read my local agentlens data / is the dashboard server exposed / cross-origin CORS localhost security / why does a POST from another origin get 403 / drive-by localhost exfiltration / ACAO wildcard vs scoped / how is the standalone server protected against a browsed page / CSRF on the local server / who may iframe the dashboard / 403 unverifiable viewer assertion / settings gear missing in embed / bad embed-key refuses to boot fail-closed / why won't the server start with a corrupt or wide-perms embed-key / EX_CONFIG 78 refuse to boot / embed-key wider than 0600 exposed shared secret / (earlier the bad key disabled the feature and kept running — now reversed) / restrict settings panel per user"
ocd: 2026-07-11
lmd: 2026-07-30
metadata:
  node_type: memory
  tier: component
  type: project
  globs: ["standalone/server.ts"]
---

The standalone server exposes a UI/API server (`UI_PORT`, default 3000) and an OTLP
receiver (`OTLP_PORT`, default 4318). Its threat model is NOT a remote attacker (it binds
`127.0.0.1` by default, unreachable from the network) but a **web page the user is
browsing**, which can reach `localhost` from the user's own browser. Three layers defend
the local data (all in `standalone/server.ts`, `uiServer`):

1. **Loopback bind** (`BIND_HOST`, default `127.0.0.1`) — no network exposure unless the
   user opts into `0.0.0.0` for LAN.
2. **CSRF write gate** (`isDisallowedCrossOrigin`, guards non-GET/HEAD) — several handlers
   turn request fields into filesystem writes (`/api/instructions/apply`,
   `/api/bodies/export`, `/action`), so a cross-origin browser POST was an arbitrary-file-
   write → RCE vector. The gate refuses any state-changing request whose `Origin` is
   present and neither same-origin nor loopback. CLI/hook Node clients send no Origin →
   allowed.
3. **CORS read scope** (`setAllowedOriginCors`, TRDD-F6BM1BDI, shipped v2.4.0) — the read
   endpoints (`/api/summary`, `/api/sessions`, `/api/session/*`, `/api/debug/*`) return
   session data (prompts, costs, file paths). The server now echoes
   `Access-Control-Allow-Origin` ONLY for same-origin/loopback origins (+ `Vary: Origin`),
   never the wildcard — so a cross-origin page gets no CORS header and the browser blocks
   it from reading the response. Reuses the layer-2 predicate (one place decides "allowed
   origin").
4. **Framing contract** (TRDD-FMIZO8Y4, v2.9.0) — the dashboard HTML carries
   `Content-Security-Policy: frame-ancestors 'self' + any loopback port`, so a LOCAL app
   (the ai-maestro UI) may iframe it as a guaranteed contract while a remote page cannot
   frame the local dashboard (clickjack counterpart of layer 3). The iframe's `/api` calls
   are same-origin inside the frame — layer 3 never blocks embedding. `?embed=1` /
   `?tab=<id>` parse in `src/shared/embedParams.ts`.
5. **Viewer-role gate** (TRDD-1ZH1D5EG, post-2.9.0, contract on AgentlensPro#4) — a trusted
   reverse proxy (ai-maestro) stamps an HMAC-signed `X-Agentlens-Viewer` header per request
   ({v:1, role maestro|user, iat, exp, nonce}, signed over the b64url payload with
   `~/.agentlens/embed-key`, 0600, boot-created; verifier `src/embedAuth.ts`). No header =
   standalone = full access (hooks/CLI/solo browsers untouched). role user = restricted:
   ONE blanket method allowlist (GET/HEAD/OPTIONS) + 403 on the config read
   `GET /api/hook-config`, and the served HTML gets a meta tag that hides the settings
   panel/gear/Import tab. ANY unverifiable header (bad sig, expired, unknown v/role,
   duplicated header) = 403 the whole request — never a downgrade to standalone. The #4
   cross-repo test vector is pinned byte-for-byte in `embedAuth.test.ts`; key rotation
   requires a server restart (key is read once at boot). An UNUSABLE key at boot (corrupt hex,
   or wider than 0600 on POSIX — a shared secret other local accounts could read to mint 'maestro'
   assertions) makes the server REFUSE TO BOOT, fail-closed: it exits EX_CONFIG (78) with a
   `chmod 600`/delete remediation message rather than run on with an undecidable or leaked signing
   key (TRDD-F1VX3M7C, owner directive [^4]). The supervisor treats exit 78 as TERMINAL so this
   cannot respawn-loop (`isTerminalExit`, `src/cli/serverControl.ts`). On Windows the 0600 mode check
   is skipped (Node reports 0600 as 0666 there).

The OTLP receiver (`otlpServer`) sets NO CORS header — it is reached server-to-server by
agent SDK exporters, never a browser.

## Notes and lessons learned
[^1]: [id:ATOM-CSRF-WRITE-VS-CORS-READ-SEPARATE, status:valid, keywords:"acao_wildcard_left_on_read_endpoints cross_origin_read_exfil_hole csrf_write_gate_and_cors_read_are_separate_controls scope_acao_explicitly", ocd:2026-07-11, lmd:2026-07-11] The round-1 review added the CSRF WRITE gate but
  left `Access-Control-Allow-Origin: *` on responses with the comment "read endpoints are
  non-sensitive" — false: they carry the user's prompts/costs/paths, so `*` was a
  cross-origin READ-exfil hole (the read counterpart to the write vector). Lesson: a CSRF
  write gate and a CORS read policy are SEPARATE controls — closing writes does not close
  reads; scope ACAO explicitly. GET being CSRF-ungated is justified by "no write side
  effect", NOT by "the data is non-sensitive".
[^2]: [id:ATOM-FAIL-CLOSED-NOT-DOWNGRADE, status:valid, keywords:"invalid_header_fallback garbage_header_full_access downgrade_attack fail_open_verifier restricted_vs_invalid", ocd:2026-07-17, lmd:2026-07-17] DO NOT map an
  UNVERIFIABLE credential/assertion to the unauthenticated-default path (layer 5's first
  draft mapped bad-signature → 'restricted' viewer; absent → full-access standalone),
  BECAUSE when the default path has MORE access than the authenticated-restricted one,
  sending deliberately broken credentials becomes the attack (strip your own header →
  full access). DO make every verification failure strictly MORE restrictive than every
  verification success (invalid = 403 everything, per AgentlensPro#4 §B5).
[^3]: [id:ATOM-OPTIONAL-FEATURE-SOFT-FAIL, status:superseded, superseded-by:ATOM-EMBED-KEY-FAIL-CLOSED-BOOT, keywords:"opt_in_feature_crashes_whole_server ensureEmbedKey_throws_at_module_load self_inflicted_DoS fail_fast_vs_fail_closed embed_key_refuse_boot", ocd:2026-07-17, lmd:2026-07-17] (SUPERSEDED — the owner later reversed this to fail-closed refuse-to-boot; see [^4].) DO NOT let an OPT-IN feature's
  boot-time dependency THROW at module load (v2.10.0 `const EMBED_KEY = ensureEmbedKey(DATA_DIR)`
  threw on a corrupt/wide key), BECAUSE the throw crashed the WHOLE server — OTLP ingestion, hook
  capture, and the CLI, none of which use embedding — and hook-revive then respawned a crash loop:
  a self-inflicted DoS from a feature nobody in that deployment even used. DO wrap the optional
  dependency, log loudly, and DISABLE only that feature (here: `EMBED_KEY=null` ⇒ present header
  403 = fail-CLOSED for the feature, absent header = standalone unchanged) so the product keeps
  running. Fail-fast is for a dependency the WHOLE product needs; fail-closed-and-disable is for an
  opt-in one. (WYC4KB50 #1; supersedes the earlier "server refuses to boot on a bad embed-key" —
  that was stricter than the #4 §B5 contract, which specifies present-header-reject + keep running.)
[^4]: [id:ATOM-EMBED-KEY-FAIL-CLOSED-BOOT, status:valid, keywords:"embed_key_refuse_boot fail_closed_vs_soft_fail exposed_shared_secret_wider_than_0600 supervisor_terminal_exit_78 EX_CONFIG_no_respawn security_over_availability owner_directive", ocd:2026-07-17, lmd:2026-07-17] DO NOT
  soft-fail-and-run when the failed dependency is an EXPOSED SHARED SECRET — an embed-key wider than
  0600 is readable by other local accounts that could mint 'maestro' assertions — BECAUSE running on
  leaves the exposure unremediated, and the owner ruled security > availability here ("go with the
  more secure version"). DO refuse to boot fail-closed (exit EX_CONFIG 78, forcing chmod 600 / delete)
  AND make the supervisor treat 78 as TERMINAL (`isTerminalExit`) so the refusal cannot respawn-loop —
  the exact crash-loop [^3] warned of, now MITIGATED instead of avoided. The security delta is the
  forcing-function: BOTH versions discard a bad key at runtime, but fail-closed won't serve until the
  operator protects the secret. (TRDD-F1VX3M7C reverses [^3]/WYC4KB50 #1; the public AgentlensPro#4
  thread already documents refuse-to-boot, so this also removes the need for a #4 correction post.)
