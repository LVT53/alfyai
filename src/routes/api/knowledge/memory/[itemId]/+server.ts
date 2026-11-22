import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	getMemoryDetail,
	MemoryRequestError,
	parseMemoryScope,
} from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	try {
		return json(
			getMemoryDetail(event.locals.user.id, {
				scope: parseMemoryScope({
					kind: event.url.searchParams.get("scope") ?? "personal",
					projectId: event.url.searchParams.get("projectId"),
				}),
				generation: event.url.searchParams.get("generation") ?? "",
				rowId: event.params.itemId,
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
