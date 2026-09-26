import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { getArtifact } from "$lib/server/services/artifacts";
import { injectAppBootstrap } from "$lib/server/services/artifacts/app/bootstrap";
import { APP_SANDBOX_HEADERS } from "$lib/server/services/artifacts/app/sandbox-response";
import type { RequestHandler } from "./$types";

// GET /api/artifacts/[id]/app — the App's served document, and the ONLY place
// its HTML ever executes. No other method: this route neither accepts nor
// needs a body, and no `?redirect=`/`?theme=` parameter would make the
// response vary — the `?v=` the frame passes is a cache-buster only, never
// trusted as a version selector, because the body always comes from the
// artifact row.
//
// The response headers (the exact CSP string included) live in
// `sandbox-response.ts`, not here: SvelteKit's build rejects a `+server.ts`
// that exports anything beyond the recognised handler names, so the
// constant a test needs to assert against has to live in its own module.
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
