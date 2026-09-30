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
		// Everything the browser will need must be in the FIRST optimizer pass.
		// The scan starts from the route files, so a package that only a hooks file
		// imports (@sentry/sveltekit, from hooks.client.ts) is found on the first page
		// load instead, which re-optimizes and reloads the page: on a dev server with
		// an empty cache that aborts the first navigation and breaks hydration with a
		// second copy of Svelte's runtime (the first e2e test of a fresh server).
		include: ['chart.js/auto', '@sentry/sveltekit']
	}
});
