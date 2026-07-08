// Mocha bootstrap (referenced by .mocharc.cjs `require`).
// The VS Code extension was removed (TRDD-6E6416B8), and with it the runtime
// `require('vscode')` mock that used to be installed here — no test resolves
// 'vscode' at runtime any more (the retained persistence/collector modules are
// exercised with plain structural fakes). Kept as a no-op so the .mocharc
// `require` entry still resolves; new global test setup would go here.
