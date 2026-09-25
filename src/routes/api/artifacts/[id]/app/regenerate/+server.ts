import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { regenerateApp } from "$lib/server/services/artifacts/app/regenerate";
import { detectLanguage } from "$lib/server/services/language";
import type { RequestHandler } from "./$types";

/**
 * POST /api/artifacts/[id]/app/regenerate — the panel's own App edit path
 * (slice-2.md §The App card). The ONLY App route that writes; it runs the
 * same generator+verifier pipeline the `create_artifact` tool's App branch
 * will use once Slice 5a lands (`regenerateApp`, one implementation, two
 * callers).
 *
 * There is no chat turn here to inherit a detected response language from,
 * so the request's own prompt text is what `detectLanguage` reads — the same
 * function `chat-turn/` uses for a turn's own language decision.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return json(
			{ ok: false, reason: "empty_content", detail: "invalid request body" },
			{ status: 422 },
		);
	}
	const prompt =
		body && typeof body === "object"
			? (body as { prompt?: unknown }).prompt
			: undefined;
	if (typeof prompt !== "string" || prompt.trim().length === 0) {
		return json(
			{ ok: false, reason: "empty_content", detail: "a prompt is required" },
			{ status: 422 },
		);
	}
	const expectVersionRaw = (body as { expectVersion?: unknown }).expectVersion;
	const expectVersion =
		typeof expectVersionRaw === "number" ? expectVersionRaw : undefined;
	const conversationId = (body as { conversationId?: unknown }).conversationId;

	const result = await regenerateApp({
		userId: user.id,
		artifactId: event.params.id,
		prompt,
		language: detectLanguage(prompt),
		expectVersion,
		conversationId: typeof conversationId === "string" ? conversationId : null,
	});

	if (!result.ok) {
		if (result.reason === "not_found") {
			return json(result, { status: 404 });
		}
		if (result.reason === "version_conflict") {
			return json(result, { status: 409 });
		}
		return json(result, { status: 422 });
	}
	return json(result);
};
