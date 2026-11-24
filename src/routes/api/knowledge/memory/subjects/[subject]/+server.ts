import { json } from "@sveltejs/kit";
import type { MemorySubjectKey } from "$lib/memory-types";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	listMemorySubject,
	logMemoryReadFailure,
	MemoryRequestError,
	parseMemoryScope,
} from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";

/** One subject's current or Earlier entries (`all`: every subject's), a page at a time. */
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	try {
		const state = event.url.searchParams.get("state") ?? "current";
		if (state !== "current" && state !== "earlier")
			throw new MemoryRequestError("invalid_state");
		return json(
			listMemorySubject(event.locals.user.id, {
				scope: parseMemoryScope({
					kind: event.url.searchParams.get("scope") ?? "personal",
					projectId: event.url.searchParams.get("projectId"),
				}),
				// The service refuses a subject its bank kind does not have.
				subject: event.params.subject as MemorySubjectKey,
				state,
				cursor: event.url.searchParams.get("cursor") ?? undefined,
			}),
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		if (!(error instanceof MemoryRequestError))
			logMemoryReadFailure("Subject entries", error);
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
