import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	logMemoryReadFailure,
	MemoryRequestError,
	parseMemoryScope,
	readMemorySubjectIndex,
} from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";

/** The Memory page's subject index for one scope (layout C). */
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	try {
		return json(
			readMemorySubjectIndex(
				event.locals.user.id,
				parseMemoryScope({
					kind: event.url.searchParams.get("scope") ?? "personal",
					projectId: event.url.searchParams.get("projectId"),
				}),
			),
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		if (!(error instanceof MemoryRequestError))
			logMemoryReadFailure("Subject index", error);
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
