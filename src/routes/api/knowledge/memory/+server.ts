import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	listMemory,
	MemoryRequestError,
	parseMemoryScope,
} from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	try {
		return json(
			listMemory(event.locals.user.id, {
				scope: parseMemoryScope({
					kind: event.url.searchParams.get("scope") ?? "personal",
					projectId: event.url.searchParams.get("projectId"),
				}),
				query: event.url.searchParams.get("query") ?? undefined,
				cursor: event.url.searchParams.get("cursor") ?? undefined,
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
