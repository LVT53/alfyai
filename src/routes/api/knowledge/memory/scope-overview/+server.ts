import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	MemoryRequestError,
	parseMemoryScope,
	readMemoryOverview,
	writeMemoryOverview,
} from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";

function scopeOf(url: URL) {
	return parseMemoryScope({
		kind: url.searchParams.get("scope") ?? "personal",
		projectId: url.searchParams.get("projectId"),
	});
}

function failure(error: unknown) {
	if (error instanceof MemoryRequestError)
		return json({ error: error.code }, { status: error.status });
	// Content-free (services/AGENTS.md): the error's kind and code only. A
	// message can quote the model's text (a JSON parse error does).
	const code =
		typeof error === "object" &&
		error !== null &&
		typeof (error as { code?: unknown }).code === "string"
			? (error as { code: string }).code
			: null;
	console.error("[KNOWLEDGE_MEMORY] Overview unavailable", {
		error: error instanceof Error ? error.name : "unknown",
		code,
	});
	return json({ error: "overview_unavailable" }, { status: 503 });
}

/** The scope's Overview when one is written and still matches its current entries. */
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	try {
		return json(readMemoryOverview(event.locals.user.id, scopeOf(event.url)), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		return failure(error);
	}
};

/** Writes the Overview (one local-model call) unless a matching one is kept; `rewrite` writes it anew. */
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	let body: unknown = null;
	try {
		body = await event.request.json();
	} catch {
		// No body asks for the kept Overview, written when there is none.
	}
	const rewrite =
		typeof body === "object" &&
		body !== null &&
		(body as { rewrite?: unknown }).rewrite === true;
	try {
		// Not tied to the request: an Overview the person closed the sheet on
		// still lands, so it is there when they open it again.
		return json(
			await writeMemoryOverview(event.locals.user.id, scopeOf(event.url), {
				rewrite,
			}),
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		return failure(error);
	}
};
