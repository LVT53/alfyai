import { json } from "@sveltejs/kit";
import type { MemoryQuarantineRequest } from "$lib/memory-types";
import { requireAuth } from "$lib/server/auth/hooks";
import { isJsonRecord } from "$lib/server/services/memory-profile/internal-json";
import { MemoryRequestError } from "$lib/server/services/memory-profile/memory-request";
import {
	getMemoryQuarantine,
	resolveMemoryQuarantineCandidate,
	retryMemoryQuarantineApproval,
	startMemoryQuarantine,
} from "$lib/server/services/memory-profile/quarantine";
import type { RequestHandler } from "./$types";

const headers = { "Cache-Control": "no-store" };
const validId = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0 && value.length <= 200;

function parseRequest(value: unknown): MemoryQuarantineRequest | null {
	if (!isJsonRecord(value)) return null;
	const { action, requestId } = value;
	if (action === "retry" && validId(value.id)) return { action, id: value.id };
	if (!validId(requestId)) return null;
	if (action === "start") return { action, requestId };
	if (action !== "resolve" || !validId(value.id)) return null;
	const { id, decision, text } = value;
	if (decision === "discard" && text === undefined)
		return { action, requestId, id, decision };
	if (
		decision === "keep" &&
		(text === undefined ||
			(typeof text === "string" &&
				text.trim().length > 0 &&
				text.length <= 16000))
	)
		return {
			action,
			requestId,
			id,
			decision,
			...(text === undefined ? {} : { text }),
		};
	return null;
}

function failure(error: unknown) {
	return error instanceof MemoryRequestError
		? json({ error: error.code }, { headers, status: error.status })
		: json(
				{ error: "memory_quarantine_unavailable" },
				{ headers, status: 503 },
			);
}

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	try {
		return json(await getMemoryQuarantine(event.locals.user.id), { headers });
	} catch (error) {
		return failure(error);
	}
};

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const request = parseRequest(await event.request.json().catch(() => null));
	if (!request)
		return json({ error: "invalid_action" }, { headers, status: 400 });
	const userId = event.locals.user.id;
	try {
		if (request.action === "start")
			return json(
				await startMemoryQuarantine(userId, { requestId: request.requestId }),
				{ headers },
			);
		if (request.action === "retry")
			return json(
				await retryMemoryQuarantineApproval(userId, { id: request.id }),
				{ headers },
			);
		const { action: _, ...resolution } = request;
		const result = await resolveMemoryQuarantineCandidate(userId, resolution);
		return json(result, { headers });
	} catch (error) {
		return failure(error);
	}
};
