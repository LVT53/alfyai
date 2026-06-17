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
		include: ['chart.js/auto']
	}
});
