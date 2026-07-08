import { json } from "@sveltejs/kit";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import { requireAuth } from "$lib/server/auth/hooks";
import { confirmPendingWrite } from "$lib/server/services/connections/pending-writes";
import type { RequestHandler } from "./$types";

// POST /api/connections/writes/[id]/confirm — the only endpoint that can
// turn a PENDING write (created by a tool's "save" action, 4.3) into a real
// mutation. confirmPendingWrite (pending-writes.ts) is idempotent: a second
// confirm on an already-executed write returns the prior success WITHOUT
// executing again; a cancelled/unknown/other-user's pending write is
// refused.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user.id;
	const id = event.params.id;

	const result = await confirmPendingWrite(userId, id);
	if (!result.ok) {
		return createJsonErrorResponse(result.reason, result.status);
	}

	return json({
		ok: true,
		alreadyExecuted: result.alreadyExecuted,
		etag: result.etag ?? null,
	});
};
