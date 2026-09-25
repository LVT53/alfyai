// The served App's response headers, as one exported constant so a test
// asserts the exact same object the route sends (Feature 2 · Artifacts,
// Slice 2). Split out of the route file itself: SvelteKit's build validates
// that a `+server.ts` exports ONLY recognised names (GET/POST/…), so a named
// export like this one — needed for the CSP/header exact-string assertion —
// cannot live there (`npm run build` fails outright otherwise; see the App
// route's own test for the assertion this constant exists to support).
//
// `sandbox allow-scripts` here is defence in depth for the direct-open case —
// a user who pastes this URL into a tab gets the same opaque-origin document
// the iframe gets (no cookie, no localStorage), not a same-origin page
// running model-authored script with their session. It is belt to the
// frame's `sandbox="allow-scripts"` attribute (the brace); either one alone
// already stops the classic escape, `allow-same-origin` must never join
// either of them.
//
// `'unsafe-inline'` for script/style is required because the App contract
// mandates inline `<style>`/`<script>` and a nonce cannot be applied to
// model-authored markup — it is safe BECAUSE the frame is opaque-origin,
// `connect-src 'none'` and `default-src 'none'`: the app cannot fetch, cannot
// read a cookie, cannot load a font or a remote image, and cannot reach
// another origin. `frame-ancestors 'self'` keeps the served document
// embeddable in this app and nowhere else — it is not what makes the frame
// opaque-origin (the iframe's `sandbox` attribute is), just an extra lock.
export const APP_SANDBOX_CSP = [
	"sandbox allow-scripts",
	"default-src 'none'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline'",
	"img-src data: blob:",
	"font-src 'none'",
	"connect-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
	"frame-ancestors 'self'",
].join("; ");

export const APP_SANDBOX_HEADERS: Record<string, string> = {
	"Content-Type": "text/html; charset=utf-8",
	"X-Content-Type-Options": "nosniff",
	"Cache-Control": "no-store",
	"Content-Security-Policy": APP_SANDBOX_CSP,
};
