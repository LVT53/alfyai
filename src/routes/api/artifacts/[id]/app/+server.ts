import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { getArtifact } from "$lib/server/services/artifacts";
import { injectAppBootstrap } from "$lib/server/services/artifacts/app/bootstrap";
import type { RequestHandler } from "./$types";

/**
 * The exact CSP string the served App runs under, exported as one constant so
 * a test asserts the same object this route sends — a partial assertion
 * (only checking `connect-src` is present, say) would still pass on a header
 * that later gained `unsafe-eval`.
 *
 * `sandbox allow-scripts` here is defence in depth for the direct-open case —
 * a user who pastes this URL into a tab gets the same opaque-origin document
 * the iframe gets (no cookie, no localStorage), not a same-origin page
 * running model-authored script with their session. It is belt to the
 * frame's `sandbox="allow-scripts"` attribute (the brace); either one alone
 * already stops the classic escape, `allow-same-origin` must never join
 * either of them.
 *
 * `'unsafe-inline'` for script/style is required because the App contract
 * mandates inline `<style>`/`<script>` and a nonce cannot be applied to
 * model-authored markup — it is safe BECAUSE the frame is opaque-origin,
 * `connect-src 'none'` and `default-src 'none'`: the app cannot fetch, cannot
 * read a cookie, cannot load a font or a remote image, and cannot reach
 * another origin. `frame-ancestors 'self'` keeps the served document
 * embeddable in this app and nowhere else — it is not what makes the frame
 * opaque-origin (the iframe's `sandbox` attribute is), just an extra lock.
 */
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

// GET /api/artifacts/[id]/app — the App's served document, and the ONLY place
// its HTML ever executes. No other method: this route neither accepts nor
// needs a body, and no `?redirect=`/`?theme=` parameter would make the
// response vary — the `?v=` the frame passes is a cache-buster only, never
// trusted as a version selector, because the body always comes from the
// artifact row.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	// Optional, and widens scope by exactly the caller's own conversation
	// (`getArtifactOwnershipScope`) the same way GET /api/artifacts/[id]
	// already does — without it, an App inside an incognito conversation
	// 404s even for its owner. AppFrame passes it when it has one.
	const conversationId = event.url.searchParams.get("conversationId");

	const artifact = await getArtifact({
		userId: user.id,
		artifactId,
		conversationId,
	});
	if (
		!artifact ||
		artifact.kind !== "app" ||
		typeof artifact.body !== "string"
	) {
		// One reason for absent, foreign, incognito-from-outside, and
		// non-App: a 403 here would confirm an id exists (slice-0.md §Failure
		// modes; ruling 19 names requireApiUser as the 401 layer, not this one).
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	return new Response(injectAppBootstrap(artifact.body), {
		status: 200,
		headers: APP_SANDBOX_HEADERS,
	});
};
