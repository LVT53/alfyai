// The served App's response headers, as one exported constant so a test
// asserts the exact same object the route sends (Feature 2 · Artifacts,
// Slice 2). Split out of the route file itself: SvelteKit's build validates
// that a `+server.ts` exports ONLY recognised names (GET/POST/…), so a named
// export like this one — needed for the CSP/header exact-string assertion —
// cannot live there (`npm run build` fails outright otherwise; see the App
// route's own test for the assertion this constant exists to support).
//
// Ruling 58: the sandbox is exactly `allow-scripts allow-forms` — no
// `allow-same-origin`, no `allow-popups`, no `allow-modals`, no
// `allow-top-navigation`. `allow-forms` is the ONE addition over the
// original `allow-scripts`-only sandbox (RV-2A open question 1, measured in
// Chromium): without it a generated app's <form> `submit` EVENT never fires
// at all ("the 'allow-forms' permission is not set"), which silently killed
// the primary action of several recorded eval apps that put Add/Calculate on
// a submit handler. Adding it costs nothing: `form-action 'none'` below still
// refuses the submission itself ("violates ... form-action 'none'"), so the
// event can fire and be handled by the app's own script (`preventDefault()`,
// or not — either way nothing is ever actually submitted anywhere).
//
// This one constant is read by BOTH the iframe's `sandbox` attribute
// (AppFrame.svelte keeps its own literal copy — a client component cannot
// import `$lib/server/*` without breaking the build, so its test pins the
// literal against this constant instead) and the CSP's `sandbox` directive
// below, so the two cannot drift apart from each other. This is defence in
// depth for the direct-open case — a user who pastes this URL into a tab
// gets the same opaque-origin document the iframe gets (no cookie, no
// localStorage), not a same-origin page running model-authored script with
// their session. It is belt to the frame's `sandbox` attribute (the brace);
// either one alone already stops the classic escape, `allow-same-origin`
// must never join either of them.
export const APP_IFRAME_SANDBOX = "allow-scripts allow-forms";

// `'unsafe-inline'` for script/style is required because the App contract
// mandates inline `<style>`/`<script>` and a nonce cannot be applied to
// model-authored markup — it is safe BECAUSE the frame is opaque-origin,
// `connect-src 'none'` and `default-src 'none'`: the app cannot fetch, cannot
// read a cookie, cannot load a font or a remote image, and cannot reach
// another origin. `frame-ancestors 'self'` keeps the served document
// embeddable in this app and nowhere else — it is not what makes the frame
// opaque-origin (the iframe's `sandbox` attribute is), just an extra lock.
export const APP_SANDBOX_CSP = [
	`sandbox ${APP_IFRAME_SANDBOX}`,
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
