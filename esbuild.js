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

async function main() {
	const mediaCtx = await esbuild.context({
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

	const sidebarCtx = await esbuild.context({
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

	const standaloneCtx = await esbuild.context({
		entryPoints: ['standalone/server.ts'],
		bundle: true,
		format: 'cjs',
		minify: false,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'standalone/server.js',
		logLevel: 'silent',
		// @duckdb/node-api loads prebuilt platform-specific .node binaries via optionalDependencies —
		// native addons CANNOT be bundled, so it must resolve from node_modules at runtime (it is a
		// declared runtime dependency, same stance as sql.js's dynamic require). Without this the
		// whole build fails on the .node loader, which is how the store code silently never shipped.
		external: ['@duckdb/node-api'],
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
		outfile: 'standalone/cli.js',
		logLevel: 'silent',
		// sql.js resolves from node_modules at runtime (same stance as the server bundle) —
		// inlining its WASM loader would bloat the CLI for a path only `setup` touches.
		// @duckdb/node-api: native .node addon, unbundlable — see the server target above.
		external: ['sql.js', '@duckdb/node-api'],
		plugins: [
			esbuildProblemMatcherPlugin,
			{
				// cli.ts lazily imports ./server on the bare no-args path. Left to esbuild, that
				// dynamic import would INLINE the entire server into cli.js (a second full copy of
				// the collector). Marking it external keeps cli.js the thin dispatcher: at runtime
				// require('./server') resolves the sibling standalone/server.js bundle instead.
				name: 'external-sibling-server',
				setup(build) {
					build.onResolve({ filter: /^\.\/server$/ }, () => ({ path: './server', external: true }));
				},
			},
		],
	});

	if (watch) {
		await mediaCtx.watch();
		await sidebarCtx.watch();
		await standaloneCtx.watch();
		await cliCtx.watch();
	} else {
		await mediaCtx.rebuild();
		await mediaCtx.dispose();
		await sidebarCtx.rebuild();
		await sidebarCtx.dispose();
		await standaloneCtx.rebuild();
		await standaloneCtx.dispose();
		await cliCtx.rebuild();
		await cliCtx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
