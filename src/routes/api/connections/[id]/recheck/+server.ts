import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { requireOwnedConnection } from "$lib/server/api/ownership";
import { checkConnectionHealth } from "$lib/server/services/connections/health";
import { getConnection } from "$lib/server/services/connections/store";
import type { RequestHandler } from "./$types";

// POST /api/connections/[id]/recheck — asks the provider whether this
// connection still works, persists the answer, and returns the refreshed
// connection.
//
// Connections redesign. `checkConnectionHealth` has existed in health.ts since
// the feature landed and nothing ever called it: status was only ever written
// as a side effect of a provider read during a chat turn. That made the tab's
// status stale by construction — a token revoked at the provider still read
// "Connected" until the user asked a question that happened to need it, and
// then failed mid-answer instead of on the screen that could fix it.
//
// Additive: nothing else changes, GET /api/connections still returns whatever
// is stored. The tab calls this for the one connection whose detail dialog the
// user just opened, which is the moment they are actually asking "does this
// still work?" — rather than firing a network call per provider on every visit
// to the tab.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const userId = user.id;
	const id = event.params.id;

	// User-scoped: another user's connection id 404s exactly like a missing
	// one. checkConnectionHealth scopes by userId too, but the 404 shape has to
	// match every other [id]/ route.
	const owned = await requireOwnedConnection(userId, id);
	if (!owned.ok) {
		return owned.response;
	}

	// Never throws — an adapter that blows up becomes { status: "error" }, and
	// the status/detail are already persisted by the time this returns.
	await checkConnectionHealth(userId, id);

	// Re-read rather than patching the DTO we already hold: checkConnectionHealth
	// writes through the store, and the store owns what a ConnectionPublic
	// contains (statusChangedAt moves too).
	const connection = await getConnection(userId, id);
	return json({ connection: connection ?? owned.connection });
};
