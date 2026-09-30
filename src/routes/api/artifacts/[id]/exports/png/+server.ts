import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	canvasImageFailureStatus,
	storeCanvasImage,
} from "$lib/server/services/artifacts";
import { EXPORT_PNG_MAX_BYTES } from "$lib/shared/artifacts/canvas-limits";
import type { RequestHandler } from "./$types";

/** Base64 is four characters to three bytes; the rest is the data URL's own prefix and the JSON around it. */
const MAX_BODY_CHARS = Math.ceil(EXPORT_PNG_MAX_BYTES / 3) * 4 + 1024;

// POST /api/artifacts/[id]/exports/png — a picture of the board the browser drew,
// `{ source: "canvas-export" | "canvas-poster", dataUrl, nodeId? }`. A thin adapter
// over `storeCanvasImage`, which owns every rule (whose board it is, that the bytes
// are a PNG, how large, what is made of it); this route only reads the body, bounded,
// and passes it on as written for the service to judge. `canvas-export` is the PNG the
// reader downloads and becomes an ordinary produced file linked to the board (ruling
// 18); `canvas-poster` is a block's still image and is listed nowhere.
//
// Same 404 rule as every artifact route (rulings 39/49/51): another user's board and a
// missing id answer alike, before the picture is looked at. `?conversationId=` names
// the chat the panel shows, so an incognito chat's own board can be exported.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);

	const declaredChars = Number(event.request.headers.get("content-length"));
	if (Number.isFinite(declaredChars) && declaredChars > MAX_BODY_CHARS) {
		return json({ ok: false, reason: "too_large" }, { status: 413 });
	}
	const raw = await event.request.text().catch(() => null);
	if (raw !== null && raw.length > MAX_BODY_CHARS) {
		return json({ ok: false, reason: "too_large" }, { status: 413 });
	}
	let body: unknown = null;
	try {
		body = raw === null ? null : JSON.parse(raw);
	} catch {
		body = null;
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return json({ ok: false, reason: "invalid_request" }, { status: 400 });
	}
	const request = body as {
		source?: unknown;
		nodeId?: unknown;
		dataUrl?: unknown;
	};

	const result = await storeCanvasImage({
		userId: user.id,
		artifactId: event.params.id,
		conversationId: event.url.searchParams.get("conversationId"),
		source: request.source,
		nodeId: request.nodeId,
		dataUrl: request.dataUrl,
	});
	if (!result.ok) {
		return json(
			{ ok: false, reason: result.reason },
			{ status: canvasImageFailureStatus(result.reason) },
		);
	}
	return json({
		ok: true,
		fileId: result.fileId,
		width: result.width,
		height: result.height,
	});
};
