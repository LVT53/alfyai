import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { regenerateApp } from "$lib/server/services/artifacts/app/regenerate";
import { resolveTurnResponseLanguage } from "$lib/server/services/chat-turn";
import { resolveResponseLanguage } from "$lib/server/services/language";
import type { RequestHandler } from "./$types";

/**
 * POST /api/artifacts/[id]/app/regenerate — the panel's own App edit path
 * (slice-2.md §The App card). The ONLY App route that writes; it runs the
 * same generator+verifier pipeline the `create_artifact` tool's App branch
 * uses (`regenerateApp`, one implementation, two callers).
 *
 * There is no chat turn here to inherit a resolved response language from
 * (ruling 55), so this route resolves its own through the SAME policy
 * `resolveTurnResponseLanguage`/`resolveResponseLanguage` apply to a chat
 * turn — the request's own prompt, then the conversation's established
 * language, then the account's UI language — rather than the retired
 * per-message `detectLanguage(prompt)` guess, which read an English prompt
 * full of Hungarian-looking letter pairs as Hungarian. A project-linked App
 * (Task A7's own note: `conversationId` can be null here, unlike the tool's
 * call) has no conversation history to fall back through, so it resolves the
 * prompt and the UI language only — still the same policy, just with an
 * empty history.
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
	const scopedConversationId =
		typeof conversationId === "string" ? conversationId : null;

	const language = scopedConversationId
		? await resolveTurnResponseLanguage({
				message: prompt,
				conversationId: scopedConversationId,
				user,
			})
		: resolveResponseLanguage({
				latestMessage: prompt,
				uiLanguage: user.uiLanguage,
			});

	const result = await regenerateApp({
		userId: user.id,
		artifactId: event.params.id,
		prompt,
		language,
		expectVersion,
		conversationId: scopedConversationId,
		// Ruling 53: generation + verification can run for tens of seconds: if
		// the caller disconnects (the panel navigates away, the fetch is
		// aborted) before that finishes, regenerateApp must find out, so it
		// does not write a version for a call nobody is waiting on anymore.
		abortSignal: event.request.signal,
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
