# ── Rust builder stage ─────────────────────────────────────────────────────────
# alcore (rust-core/crates/agentlens-core, binary `alcore`) is the ONLY server: the TypeScript
# server was retired in commit 567fc5c2 and standalone/server.js no longer exists (TRDD-6MG5N1ZF).
# Built for the IMAGE's own platform (no --platform=$BUILDPLATFORM): DuckDB is statically
# compiled, and publish.yml's build-binaries job also builds natively per platform, never cross.
# Debian bookworm (glibc) on purpose, NOT alpine: the binary is linked against glibc, so the
# runtime stage must be glibc too (a musl runtime fails with "not found" at exec). The full
# image, not -slim: bundled DuckDB/SQLite/mimalloc compile C/C++ through `cc` and need g++.
# 1.97.0 is the toolchain the workspace was last built with locally; no rust-version is declared.
FROM rust:1.97.0-bookworm AS rust-builder
ARG TARGETARCH
WORKDIR /app

# Narrow COPYs, never `COPY rust-core/`: .dockerignore excludes rust-core/target/ (TRDD-6MG5N1ZF), and the narrow
# COPYs keep any other host build dir out of the context too. Every workspace member's manifest must be present
# for cargo to resolve the workspace, hence the whole crates/ tree.
# package.json sits ONE LEVEL ABOVE rust-core/ on purpose: server_stats.rs:79 does
# include_str!("../../../../package.json"), so the crate does not compile without it.
COPY package.json ./package.json
COPY rust-core/Cargo.toml rust-core/Cargo.lock ./rust-core/
COPY rust-core/crates/ ./rust-core/crates/

RUN cargo build --release --locked --manifest-path rust-core/Cargo.toml -p agentlens-core --bin alcore

# Stage the binary where src/rustBinResolve.ts (npmPlatformBin) looks for it:
# bin-native/<platform>-<arch>/alcore, with Node's arch names (amd64 -> x64, arm64 -> arm64).
# CMD cannot expand TARGETARCH, so a fixed-path symlink bin-native/alcore points at it.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) ARCH=x64 ;; \
      arm64) ARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    mkdir -p "/out/bin-native/linux-$ARCH"; \
    cp rust-core/target/release/alcore "/out/bin-native/linux-$ARCH/alcore"; \
    chmod +x "/out/bin-native/linux-$ARCH/alcore"; \
    ln -s "linux-$ARCH/alcore" /out/bin-native/alcore

# ── Node build stage ───────────────────────────────────────────────────────────
# Node 22 is REQUIRED in the builder: pnpm 11.9 imports node:sqlite (>= 22.13) —
# under node:20 `pnpm install` dies with ERR_UNKNOWN_BUILTIN_MODULE before
# resolving a single package (v1.0.0 docker workflow run 29121508405).
# esbuild output is plain JS, so this stage runs on the build host's platform.
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder
WORKDIR /app

# Keep pnpm in lockstep with package.json "packageManager"; pnpm 11 is required
# by the supply-chain policy in pnpm-workspace.yaml.
RUN npm install -g pnpm@11.9.0

# pnpm-workspace.yaml carries the supply-chain policy + build-script allowlist, so
# the image build enforces the same install-time guards as local/CI.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY esbuild.js tsconfig.json ./
COPY src/ ./src/
COPY standalone/ ./standalone/
COPY media/src/ ./media/src/
COPY media/tsconfig.json ./media/
# media/dashboard.css is NOT copied from the context: since v2.3.1 it is a gitignored
# esbuild build artifact (bundled from media/src/styles/*.css via the dashboard entry),
# so it is absent from the git build context. It is produced by the RUN below and copied
# into the runtime stage from the builder. Copying it here broke the Docker build for
# v2.3.1 and v2.4.0 ("/media/dashboard.css: not found").
# media/index.html is tracked source (the dashboard shell): alcore refuses to boot without
# <media-dir>/index.html (alcore.rs, --media-dir check), and the shell loads sidebar.js.
COPY media/index.html media/help-mascot.png media/mascot.png ./media/

# Produces standalone/cli.js, media/dashboard.js|css and media/sidebar.js.
RUN node esbuild.js --production

# ── Runtime stage ─────────────────────────────────────────────────────────────
# Debian bookworm-slim (glibc), the same libc and release as the rust-builder stage, because
# alcore is a glibc binary. Node stays in the image only to run the CLI bundle
# (standalone/cli.js) and the HEALTHCHECK; the server itself is the alcore process.
FROM node:22-bookworm-slim
WORKDIR /app

RUN groupadd --system agentlens && useradd --system --create-home --gid agentlens agentlens

COPY --from=rust-builder --chown=agentlens:agentlens /out/bin-native ./bin-native
COPY --from=builder --chown=agentlens:agentlens /app/standalone/cli.js    ./standalone/cli.js
COPY --from=builder --chown=agentlens:agentlens /app/media/index.html     ./media/index.html
COPY --from=builder --chown=agentlens:agentlens /app/media/dashboard.js   ./media/dashboard.js
COPY --from=builder --chown=agentlens:agentlens /app/media/dashboard.css  ./media/dashboard.css
COPY --from=builder --chown=agentlens:agentlens /app/media/sidebar.js     ./media/sidebar.js
COPY --from=builder --chown=agentlens:agentlens /app/media/help-mascot.png ./media/help-mascot.png
COPY --from=builder --chown=agentlens:agentlens /app/media/mascot.png     ./media/mascot.png

# DATA_DIR=/data holds the span store, config, and the viewer-role embed-key
# (TRDD-1ZH1D5EG). In the default container no reverse proxy stamps X-Agentlens-Viewer, so the
# server runs in standalone mode and the key is simply unused. To use viewer-role embedding across
# the container boundary (a host proxy signing assertions), bind-mount /data to a host directory the
# proxy user can read — the embed contract is a shared file, same user, same host (WYC4KB50 #12).
RUN mkdir -p /data && chown agentlens:agentlens /data
VOLUME ["/data"]

USER agentlens

# MCP_PORT=4316 is the port the CLI passes (serverControl.ts alcoreServeArgs). alcore reads ports
# ONLY from flags, so CMD below turns these env vars into flags; BIND_HOST is likewise only read
# by that CMD (alcore has no env for it). AGENTLENS_STARTED_BY and MIMALLOC_PURGE_DELAY mirror
# the env the CLI gives every alcore it spawns (alcoreSpawnEnv).
ENV OTLP_PORT=4318 \
    UI_PORT=3000 \
    MCP_PORT=4316 \
    DATA_DIR=/data \
    BIND_HOST=0.0.0.0 \
    AGENTLENS_STARTED_BY=docker \
    MIMALLOC_PURGE_DELAY=0

EXPOSE 4318 3000

# 127.0.0.1, not localhost: --bind 0.0.0.0 listens on IPv4 only and localhost may resolve to ::1.
# No wget in the Debian slim image, so the probe is Node's own fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.UI_PORT+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# The foreground server, same argv as the CLI's alcoreServeArgs (serverControl.ts:202-210) plus
# --bind, which the CLI never passes (alcore defaults to 127.0.0.1, unreachable from outside the
# container). `cd` mirrors the CLI spawn (cwd = data dir); `exec` makes alcore PID 1 so SIGTERM
# from `docker stop` reaches it and the shutdown flush runs. A stale pidfile naming PID 1 after an
# unclean stop is reclaimed by alcore (pid_lock.rs claim: prior.pid == my_pid).
CMD ["sh", "-c", "cd \"$DATA_DIR\" && exec /app/bin-native/alcore serve --data-dir \"$DATA_DIR\" --media-dir /app/media --bind \"$BIND_HOST\" --otlp-port \"$OTLP_PORT\" --ui-port \"$UI_PORT\" --mcp-port \"$MCP_PORT\""]
