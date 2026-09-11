// The chat home's one read: everything HomeV4A "Compact" draws, per user,
// cached 30 seconds (see home-summary.ts).
//
// The POST is the one write the screen needs and the only reason the
// `home_suggestion_events` table exists: without a record that a chip was used
// or dismissed, the ranking's second field cannot be computed at all and
// "another" would be the only way a chip ever changed.

import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	type HomeSuggestionEventKind,
	recordHomeSuggestionEvent,
} from "$lib/server/services/home-suggestions";
import {
	getHomeSummary,
	invalidateHomeSummary,
} from "$lib/server/services/home-summary";
import type { RequestHandler } from "./$types";

const EVENT_KINDS: HomeSuggestionEventKind[] = ["shown", "dismissed", "used"];
const MAX_CANDIDATE_KEY_LENGTH = 200;

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
	const candidateKey =
		body && typeof body.candidateKey === "string"
			? body.candidateKey.trim()
			: "";
	const kind = body && typeof body.event === "string" ? body.event : "";

	if (!candidateKey) {
		return json({ error: "candidateKey is required" }, { status: 400 });
	}
	// The engine's own keys are `<kind>:<uuid>`. The bound is not a format
	// check — a key whose object was deleted must still be storable — it just
	// stops the table being used as free per-user storage.
	if (candidateKey.length > MAX_CANDIDATE_KEY_LENGTH) {
		return json({ error: "candidateKey is too long" }, { status: 400 });
	}
	if (!EVENT_KINDS.includes(kind as HomeSuggestionEventKind)) {
		return json(
			{ error: `event must be one of ${EVENT_KINDS.join(", ")}` },
			{ status: 400 },
		);
	}

	await recordHomeSuggestionEvent({
		userId: event.locals.user.id,
		candidateKey,
		event: kind as HomeSuggestionEventKind,
	});
	// An acted-on candidate must be gone from the rail on the next render, not
	// up to 30 seconds later.
	invalidateHomeSummary(event.locals.user.id);
	return json({ ok: true });
};
