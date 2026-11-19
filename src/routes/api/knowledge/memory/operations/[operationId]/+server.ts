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
		return json(
			getMemoryOperation(event.locals.user.id, {
				id: event.params.operationId,
			}),
			{ headers: { "Cache-Control": "no-store" } },
		);
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
