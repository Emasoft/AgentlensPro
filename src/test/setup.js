// Mocha bootstrap (referenced by .mocharc.cjs `require`).
// The VS Code extension was removed (TRDD-6E6416B8), and with it the runtime
// VS Code module mock that used to be installed here — no test resolves the
// editor module at runtime any more (the retained persistence/collector modules
// are exercised with plain structural fakes). Kept as a no-op so the .mocharc
// `require` entry still resolves; new global test setup would go here.

// TRDD-66IXMIGN: the parser strips timelines from sessions idle longer than the hot-age window
// (default 24h). Fixture transcripts across the suite carry FIXED past timestamps, so without
// this pin every one of them would parse as "cold" and lose the timeline its assertions read.
// 10 years keeps every fixture hot; the strip mechanics have their own unit tests
// (timelineRetention.test.ts), and the age gate itself was verified by the live OOM repro.
if (!process.env.AGENTLENS_TIMELINE_HOT_AGE_HOURS) {
  process.env.AGENTLENS_TIMELINE_HOT_AGE_HOURS = '87600'
}
