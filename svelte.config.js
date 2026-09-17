import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		csrf: {
			trustedOrigins: ['*']
		},
		// Content Security Policy for rendered pages.
		//
		// SvelteKit builds and emits this header itself, which is why it lives
		// here rather than being hand-rolled in hooks.server.ts: `mode: 'nonce'`
		// makes it mint a per-request nonce, attach it to every script tag it
		// injects for hydration, and substitute it into the `%sveltekit.nonce%`
		// placeholders on the two hand-written inline scripts in src/app.html.
		// Hand-rolling that would mean re-implementing hydration script tagging.
		//
		// What ships to the browser is decided at RUNTIME by CSP_MODE, not here:
		// src/hooks.server.ts takes the header SvelteKit sets and either drops
		// it (off), moves it to Content-Security-Policy-Report-Only (the
		// default), or leaves it enforcing. The default is report-only, so this
		// policy cannot break the app before anyone has watched it on staging.
		//
		// Not configured via SvelteKit's own `reportOnly` option because that
		// one refuses to emit without a `report-to`/`report-uri` directive, and
		// there is no report collector here — the browser console on staging is
		// the collector.
		//
		// Only pages get this. Endpoint responses (the file previews in
		// particular) build their own Response objects and are untouched; see
		// src/lib/server/services/file-serving-response-policy.ts, whose exact
		// CSP string is load-bearing for the preview runtime's trust check.
		csp: {
			mode: 'nonce',
			directives: {
				'default-src': ['self'],
				// Nonce is added here automatically by `mode: 'nonce'`.
				'script-src': ['self'],
				// 'unsafe-inline' is unavoidable today and deliberate: Shiki emits
				// inline style attributes on every highlighted token, and mermaid
				// puts <style> elements inside the sanitized SVG that gets
				// {@html}-injected. Its presence also stops SvelteKit adding a
				// style nonce, which would silently *disable* 'unsafe-inline'.
				'style-src': ['self', 'unsafe-inline'],
				'style-src-attr': ['unsafe-inline'],
				// data: for inline SVG/preview URIs, blob: for the image preview
				// and the settings image pickers, https: because chat markdown
				// embeds arbitrary remote images from model and search output.
				'img-src': ['self', 'data:', 'blob:', 'https:'],
				// Every font is self-hosted woff2 under static/fonts. No Google Fonts.
				'font-src': ['self'],
				// Same-origin only: the browser never talks to a model provider,
				// a tile server or a favicon host directly — those are all proxied.
				// hooks.server.ts appends the Sentry DSN origin at runtime when
				// one is configured, so the DSN does not have to be known at build
				// time.
				'connect-src': ['self'],
				// pdf.js and MapLibre workers are same-origin; Sentry's replay
				// compression worker is built from a blob.
				'worker-src': ['self', 'blob:'],
				'child-src': ['self', 'blob:'],
				'media-src': ['self', 'data:', 'blob:'],
				'manifest-src': ['self'],
				// The document-workspace preview iframe is `srcdoc` + sandbox, so
				// it is an opaque origin rather than a framed URL, but keep this
				// tight anyway.
				'frame-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'frame-ancestors': ['self']
			}
		},
		adapter: adapter({
			out: 'build',
			precompress: false,
			envPrefix: ''
		}),
		version: {
			pollInterval: 60000
		},
		alias: {
			'$lib': 'src/lib'
		}
	}
};

export default config;
