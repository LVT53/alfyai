import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { runAlfyCommentReply } from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

/**
 * The hook's own ceiling, separate from the three tools' `TOOL_TIMEOUTS_MS`
 * (this route is not one of the three tools, and that map is append-only
 * across type slices — ruling 41). Generous enough for a real model call plus
 * one patch apply, the same order of magnitude as `edit_artifact`'s 20s tool
 * budget plus room for the model's own generation time.
 */
const ALFY_COMMENT_ROUTE_TIMEOUT_MS = 45_000;

// POST /api/artifacts/[id]/comments/[commentId]/alfy — the @Alfy hook
// (T10.5). No request body: the comment named by the URL already carries the
// request. Combines the request's own signal (the caller disconnecting) with
// a server-side ceiling so `runAlfyCommentReply` always ends, one way or
// another, and never writes after either fires.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const commentId = event.params.commentId;
	const conversationId = event.url.searchParams.get("conversationId");

	const abortSignal = AbortSignal.any([
		event.request.signal,
		AbortSignal.timeout(ALFY_COMMENT_ROUTE_TIMEOUT_MS),
	]);

	const result = await runAlfyCommentReply({
		userId: user.id,
		artifactId,
		commentId,
		conversationId,
		abortSignal,
	});

	if (!result.ok) {
		const status = result.reason === "aborted" ? 504 : 404;
		return json({ ok: false, reason: result.reason }, { status });
	}

	return json({
		ok: true,
		outcome: result.value.outcome,
		applied: result.value.applied,
		refused: result.value.refused,
		version: result.value.version,
		reply: result.value.reply,
	});
};
