import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { recreateArtifactFromStoredCall } from "$lib/server/services/normal-chat-tools/artifact-tools/recreate";
import { TOOL_TIMEOUTS_MS } from "$lib/server/services/normal-chat-tools/shared";
import type { RequestHandler } from "./$types";

// POST /api/conversations/[id]/artifacts/[artifactId]/regenerate — "Regenerate"
// on a chat card whose Document or App was deleted: make it again from the
// arguments the model itself gave `create_artifact`, which the conversation
// kept, under the id its cards already carry. A thin adapter: the service
// (`recreateArtifactFromStoredCall`) owns the conversation scope, the stored
// call, the per-kind handlers and the one-at-a-time rule; this only maps its
// answer to a status and gives it the budget `create_artifact` runs in — its
// own ceiling, and the request's abort.
//
// `{ language }` (optional, "en" | "hu") is the reader's interface language: a
// regeneration is not a turn with a reply language of its own (ruling 55), so
// an App is made in the caller's. Anything else falls back to English.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const body = (await event.request.json().catch(() => null)) as {
		language?: unknown;
	} | null;
	const language = body?.language === "hu" ? "hu" : "en";

	const result = await recreateArtifactFromStoredCall({
		userId: user.id,
		conversationId: event.params.id,
		artifactId: event.params.artifactId,
		language,
		abortSignal: AbortSignal.any([
			event.request.signal,
			AbortSignal.timeout(TOOL_TIMEOUTS_MS.create_artifact),
		]),
	});

	if (result.ok) return json(result);
	switch (result.reason) {
		case "not_found":
			return json({ ok: false, reason: "not_found" }, { status: 404 });
		case "no_stored_input":
		case "in_progress":
			return json({ ok: false, reason: result.reason }, { status: 409 });
		default:
			return json(
				{ ok: false, reason: "failed", detail: result.detail },
				{ status: 422 },
			);
	}
};
