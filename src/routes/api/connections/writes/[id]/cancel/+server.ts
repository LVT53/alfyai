import { json } from "@sveltejs/kit";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	cancelPendingWrite,
	getPendingWrite,
} from "$lib/server/services/connections/pending-writes";
import type { RequestHandler } from "./$types";

// POST /api/connections/writes/[id]/cancel — marks a PENDING write (4.3)
// cancelled. Once cancelled, a later confirm on the same id is permanently
// refused (see confirmPendingWrite's "cancelled" -> 409 branch).
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user.id;
	const id = event.params.id;

	const record = await getPendingWrite(userId, id);
	if (!record) {
		return createJsonErrorResponse("not_found", 404);
	}
	if (record.status !== "pending") {
		return createJsonErrorResponse(`already_${record.status}`, 409);
	}

	const cancelled = await cancelPendingWrite(userId, id);
	if (!cancelled) {
		return createJsonErrorResponse("not_found", 404);
	}

	return json({ ok: true, status: "cancelled" });
};
