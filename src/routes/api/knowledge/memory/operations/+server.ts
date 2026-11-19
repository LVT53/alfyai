import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	getMemoryOperation,
	MemoryRequestError,
} from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	try {
		const requestId = event.url.searchParams.get("requestId");
		if (!requestId || requestId.length > 200)
			throw new MemoryRequestError("invalid_request");
		return json(getMemoryOperation(event.locals.user.id, { requestId }), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		return json(
			{
				error:
					error instanceof MemoryRequestError
						? error.code
						: "memory_unavailable",
			},
			{ status: error instanceof MemoryRequestError ? error.status : 503 },
		);
	}
};
