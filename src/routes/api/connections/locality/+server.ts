import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import {
	hasLocalDistillEnabled,
	setLocalDistillEnabled,
} from "$lib/server/services/connections/locality";
import type { RequestHandler } from "./$types";

// GET /api/connections/locality — Option A (Issue 7.4): whether the caller
// has opted in to routing connector data through a local model for
// privacy-preserving distillation before any cloud chat model can see it.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);

	const localDistill = await hasLocalDistillEnabled(user.id);

	return json({ localDistill });
};

// PATCH /api/connections/locality — sets the caller's Option-A preference.
export const PATCH: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const userId = user.id;

	let body: { localDistill?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return createJsonErrorResponse("Invalid JSON", 400);
	}

	if (typeof body.localDistill !== "boolean") {
		return createJsonErrorResponse("localDistill must be a boolean", 400);
	}

	await setLocalDistillEnabled(userId, body.localDistill);

	return json({ localDistill: body.localDistill });
};
