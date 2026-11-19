import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	getNativeMemoryCleanupStatus,
	retryNativeMemoryCleanup,
} from "$lib/server/services/memory-controls";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	return json(await getNativeMemoryCleanupStatus(event.locals.user.id));
};
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const body: unknown = await event.request.json().catch(() => null);
	if (
		!body ||
		typeof body !== "object" ||
		!("operationId" in body) ||
		typeof body.operationId !== "string"
	)
		return json({ error: "invalid_operation" }, { status: 400 });
	const result = await retryNativeMemoryCleanup(
		event.locals.user.id,
		body.operationId,
	);
	return result
		? json(result)
		: json({ error: "operation_unavailable" }, { status: 404 });
};
