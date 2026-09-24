// The chat home's one read: everything HomeV4A "Compact" draws, per user,
// cached 30 seconds (see home-summary.ts).
//
// The POST is the one write the screen needs: dismissing the "memories need
// review" notice. It used to carry a second payload — the suggestion rail's
// shown/dismissed/used events — and that half is gone along with the rail and
// its event table. What is left writes a single timestamp onto the caller's own
// `users` row, so it needs no rate limit: the row cannot grow, and repeating
// the write is the same write.

import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	dismissMemoryReviewNotice,
	getHomeSummary,
} from "$lib/server/services/home-summary";
import type { RequestHandler } from "./$types";

/** The one action this endpoint accepts. */
const DISMISS_MEMORY_REVIEW_ACTION = "dismissMemoryReviewNotice";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const summary = await getHomeSummary({ userId: event.locals.user.id });
	return json(summary, {
		// Private and short: the payload names the user's own conversations, so
		// no shared cache may ever hold it.
		headers: { "cache-control": "private, max-age=0, no-store" },
	});
};

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const body = await event.request.json().catch(() => null);

	if (
		!body ||
		typeof body.action !== "string" ||
		body.action !== DISMISS_MEMORY_REVIEW_ACTION
	) {
		return json({ error: "Unknown action" }, { status: 400 });
	}

	// The notice belongs to the session user and to nobody else: the body may
	// name a user, but a body field is never what decides whose row is written.
	await dismissMemoryReviewNotice(event.locals.user.id);
	return json({ ok: true });
};
