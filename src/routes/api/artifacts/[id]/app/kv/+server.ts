import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	readAppValue,
	writeAppValue,
} from "$lib/server/services/artifacts/app/storage";
import type { RequestHandler } from "./$types";

/** The one reason → HTTP status map this route (and only this route) owns. */
const STATUS_BY_REASON: Record<string, number> = {
	invalid_key: 400,
	not_serialisable: 400,
	too_large: 413,
	too_many_keys: 409,
	not_found: 404,
};

// Ruling 58: the served App document is already `no-store`; a kv READ's body
// is the user's own stored data and deserves the same explicit treatment,
// even though nothing here is heuristically cacheable today (no validator).
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

// GET /api/artifacts/[id]/app/kv?key=… — the frame's window.alfy.storage.get.
// The artifact id is the ROUTE's, never a payload field, so a frame cannot
// address another artifact even if the parent (AppFrame.svelte) were tricked.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const key = event.url.searchParams.get("key");
	if (key === null) {
		return json(
			{ ok: false, reason: "invalid_key" },
			{ status: 400, headers: NO_STORE_HEADERS },
		);
	}

	const result = await readAppValue({
		userId: user.id,
		artifactId: event.params.id,
		key,
		conversationId: event.url.searchParams.get("conversationId"),
	});
	if (!result.ok) {
		return json(result, {
			status: STATUS_BY_REASON[result.reason] ?? 400,
			headers: NO_STORE_HEADERS,
		});
	}
	return json(result, { headers: NO_STORE_HEADERS });
};

// POST /api/artifacts/[id]/app/kv — the frame's window.alfy.storage.set.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return json({ ok: false, reason: "invalid_key" }, { status: 400 });
	}
	if (
		!body ||
		typeof body !== "object" ||
		typeof (body as { key?: unknown }).key !== "string"
	) {
		return json({ ok: false, reason: "invalid_key" }, { status: 400 });
	}
	const { key, value } = body as { key: string; value: unknown };

	const result = await writeAppValue({
		userId: user.id,
		artifactId: event.params.id,
		key,
		value,
		conversationId: event.url.searchParams.get("conversationId"),
	});
	if (!result.ok) {
		return json(result, { status: STATUS_BY_REASON[result.reason] ?? 400 });
	}
	return json(result);
};
