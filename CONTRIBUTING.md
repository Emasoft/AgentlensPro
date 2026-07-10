# Contributing to AgentlensPro

Thank you for your interest in contributing.

## Reporting bugs

Open an issue at <https://github.com/Emasoft/AgentlensPro/issues> and use the bug report template. Include:

- The agent you were using (Copilot, Claude Code, Codex)
- The AgentlensPro version (visible in the dashboard footer)
- Relevant server output (`~/.agentlens/server.log`)

## Development setup

```bash
git clone https://github.com/Emasoft/AgentlensPro
cd AgentlensPro
pnpm install
```

**Run standalone:** `pnpm run local` — starts the OTLP collector on port `4318` and the dashboard UI on port `3000`.

**Build:**

```bash
pnpm run check-types   # TypeScript type check
pnpm run lint          # ESLint
pnpm run test:unit     # Unit tests (Mocha)
node esbuild.js        # Bundle — outputs to dist/ and media/
```

## Project structure

| Path | Purpose |
| --- | --- |
| `src/` | Core logic (Node.js, no DOM) |
| `media/src/` | Dashboard webview (Preact, browser) |
| `standalone/server.ts` | Standalone HTTP server |
| `src/summarizers/` | Per-agent span → session summarizers |
| `src/otlpCollector.ts` | OTLP/HTTP ingestion |

## Branching and commit conventions

**Branch naming:** `feat/<slug>` for new features, `fix/<slug>` for bug fixes. Branch from `main`; delete after merge.

**Commit format:** [Conventional Commits](https://www.conventionalcommits.org/) — `type(scope): imperative subject`. Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`. Keep each commit a single logical unit.

**Merging:** merges into `main` are `--no-ff`, NEVER squash — history is the audit trail.

**Releases:** bump `version` in `package.json` and add a `CHANGELOG.md` entry in the same PR. After merge, tag `main` with `vX.Y.Z`.

## Submitting a pull request

1. Fork the repo and create a branch (`feat/<slug>` or `fix/<slug>`)
2. Make your changes and verify `pnpm run check-types && pnpm run lint` pass
3. Bump the version and update `CHANGELOG.md` if your change is user-facing
4. Open a PR with a clear description of what changed and why; the PR title should follow Conventional Commits format

Please keep PRs focused on a single change. Large refactors should be discussed in an issue first.

## Fixture data

If you need to test against real telemetry, use `pnpm run capture` to record a local session. Run `node scripts/redact-spans.js` before committing any fixture files — fixture JSON files are gitignored by default to prevent accidental PII exposure.
