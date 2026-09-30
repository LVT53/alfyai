import { sentrySvelteKit } from '@sentry/sveltekit';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const shouldUploadSentrySourceMaps = Boolean(
	process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
);

const sentryPlugins = await sentrySvelteKit({
	adapter: 'node',
	autoUploadSourceMaps: shouldUploadSentrySourceMaps,
	org: process.env.SENTRY_ORG,
	project: process.env.SENTRY_PROJECT,
	authToken: process.env.SENTRY_AUTH_TOKEN,
	telemetry: false
});

export default defineConfig({
	plugins: [...sentryPlugins, sveltekit()],
	build: {
		// Lazy-loaded Shiki grammars compress well but can exceed Vite's default 500 kB warning threshold.
		chunkSizeWarningLimit: 1300,
		rolldownOptions: {
			checks: {
				pluginTimings: false
			}
		}
	},
	ssr: {
		external: ['@sveltejs/adapter-node']
	},
	optimizeDeps: {
		// Everything the browser will need must be in the FIRST optimizer pass. The
		// scan starts from the route files, and does not follow an import() written
		// inside a .svelte file or look at the hooks: a package found only by the first
		// page (or panel) that needs it re-optimizes and reloads the page, which on a
		// dev server with an empty cache aborts the first navigation and breaks
		// hydration with a second copy of Svelte's runtime. So the scan is also
		// started from the two places that hide packages that way: the client hooks
		// (@sentry/sveltekit) and the Document editor, which DocumentBody.svelte
		// loads with import() (all of TipTap).
		entries: [
			'src/hooks.client.ts',
			'src/lib/components/artifacts/document/document-editor.ts'
		],
		// html-to-image is imported only by the board's picture parts, which the Canvas
		// editor loads with import() from a .svelte file, so the scan never sees it.
		include: ['chart.js/auto', 'html-to-image']
	}
});
