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
// own ceiling, and the request's abort. 409 says the item cannot be made
// (nothing kept to make it from, one already being made, or — `unreachable` —
// an item still holds the id but the chat cannot reach it).
//
// The request carries no language: an App is made in the language of the brief
// the model kept (the person's own words), not the reader's interface language.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);

	const result = await recreateArtifactFromStoredCall({
		userId: user.id,
		conversationId: event.params.id,
		artifactId: event.params.artifactId,
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
		case "unreachable":
			return json({ ok: false, reason: result.reason }, { status: 409 });
		default:
			return json(
				{ ok: false, reason: "failed", detail: result.detail },
				{ status: 422 },
			);
	}
};
