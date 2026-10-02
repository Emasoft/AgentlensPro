const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

// AGENTLENS_BUNDLE_OUT=<path>: build ONLY the CLI bundle to that file and touch nothing else. /opt/homebrew/bin/agentlenspro
// is an npm link to this repo, so a plain `node esbuild.js` rewrites standalone/cli.js and media/*.js under every live
// caller at once; this builds a scratch copy for testing first. The path must sit inside the repo (e.g.
// builds_dev/<name>/cli.js, two levels down) because the bundle resolves scripts/safe_config_edit.py and the package
// root (skills/, agents/) relative to its own location.
const bundleOut = process.env.AGENTLENS_BUNDLE_OUT;

async function main() {
	const mediaCtx = bundleOut ? null : await esbuild.context({
		entryPoints: ['media/src/dashboard.tsx'],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'media/dashboard.js',
		jsx: 'automatic',
		jsxImportSource: 'preact',
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	const sidebarCtx = bundleOut ? null : await esbuild.context({
		entryPoints: ['media/src/sidebarWebview.ts'],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		outfile: 'media/sidebar.js',
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	const cliCtx = await esbuild.context({
		entryPoints: ['standalone/cli.ts'],
		bundle: true,
		format: 'cjs',
		minify: false,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: bundleOut || 'standalone/cli.js',
		logLevel: 'silent',
		// sql.js resolves from node_modules at runtime — inlining its WASM loader would bloat the
		// CLI for a path only `setup` touches. @duckdb/node-api loads prebuilt platform-specific
		// .node binaries via optionalDependencies — native addons CANNOT be bundled, so both must
		// resolve from node_modules at runtime (declared runtime dependencies).
		external: ['sql.js', '@duckdb/node-api'],
		plugins: [esbuildProblemMatcherPlugin],
	});

	if (watch) {
		if (bundleOut) throw new Error('AGENTLENS_BUNDLE_OUT is a one-shot scratch build; --watch is not supported with it');
		await mediaCtx.watch();
		await sidebarCtx.watch();
		await cliCtx.watch();
	} else {
		if (mediaCtx && sidebarCtx) {
			await mediaCtx.rebuild();
			await mediaCtx.dispose();
			await sidebarCtx.rebuild();
			await sidebarCtx.dispose();
		}
		await cliCtx.rebuild();
		await cliCtx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
