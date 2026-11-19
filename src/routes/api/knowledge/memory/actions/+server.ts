import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	MemoryRequestError,
	submitMemoryAction,
} from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	try {
		return json(
			await submitMemoryAction(
				event.locals.user.id,
				await event.request.json().catch(() => null),
			),
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
