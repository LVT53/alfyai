import { isHttpError, isRedirect, json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { deleteConversationWithCleanup } from "$lib/server/services/cleanup";
import { getConversationDetail } from "$lib/server/services/conversation-detail/read-model";
import {
	conversationHasMessages,
	getConversation,
	moveConversationToProject,
	setConversationMemoryIncognito,
	setConversationSidebarPinned,
	updateConversationTitle,
} from "$lib/server/services/conversations";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const { id } = event.params;
		const requestedView = event.url.searchParams.get("view");
		const view = requestedView === "bootstrap" ? "bootstrap" : "full";

		const detail = await getConversationDetail({
			userId: user.id,
			conversationId: id,
			view,
		});
		if (!detail) {
			return json({ error: "Conversation not found" }, { status: 404 });
		}

		return json(detail);
	} catch (err) {
		if (isHttpError(err) || isRedirect(err)) {
			throw err;
		}
		console.error("Error loading conversation:", err);
		return json({ error: "Failed to load conversation" }, { status: 500 });
	}
};

export const PATCH: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	const { id } = event.params;

	const body = await event.request.json().catch(() => null);
	if (!body) {
		return json({ error: "Body is required" }, { status: 400 });
	}

	if ("sidebarPinned" in body) {
		if (typeof body.sidebarPinned !== "boolean") {
			return json(
				{ error: "sidebarPinned must be a boolean" },
				{ status: 400 },
			);
		}
		const conversation = await setConversationSidebarPinned(
			user.id,
			id,
			body.sidebarPinned,
		);
		if (!conversation) {
			return json({ error: "Conversation not found" }, { status: 404 });
		}
		return json(conversation);
	}

	if ("memoryIncognito" in body) {
		if (typeof body.memoryIncognito !== "boolean") {
			return json(
				{ error: "memoryIncognito must be a boolean" },
				{ status: 400 },
			);
		}

		// Incognito, one-way (docs/plans/incognito-one-way-spec.md §1): the flag
		// can only ever be armed, never disarmed. `false` is refused whatever
		// the conversation's current state — there is no client path that ever
		// sends it (the UI dropped the switch), so a request carrying it is
		// either a stale caller or something worse, and 409 is the honest
		// answer either way: no state changed.
		if (body.memoryIncognito === false) {
			return json({ error: "incognito_is_one_way" }, { status: 409 });
		}

		// `true` is only legal while the conversation has no messages yet — a
		// message already sent may have been learned into memory before the
		// flag could flip, and the UI never offers this path (the composer
		// arms incognito before the conversation exists, atomically at
		// creation). This is defence in depth for direct API callers.
		const existing = await getConversation(user.id, id);
		if (!existing) {
			return json({ error: "Conversation not found" }, { status: 404 });
		}
		if (await conversationHasMessages(id)) {
			return json(
				{ error: "incognito_requires_empty_conversation" },
				{ status: 409 },
			);
		}

		const conversation = await setConversationMemoryIncognito(
			user.id,
			id,
			true,
		);
		if (!conversation) {
			return json({ error: "Conversation not found" }, { status: 404 });
		}
		return json(conversation);
	}

	// Handle project assignment
	if ("projectId" in body) {
		const projectId =
			body.projectId === null || typeof body.projectId === "string"
				? body.projectId
				: undefined;
		if (projectId === undefined) {
			return json(
				{ error: "projectId must be a string or null" },
				{ status: 400 },
			);
		}
		const conversation = await moveConversationToProject(
			user.id,
			id,
			projectId,
		);
		if (!conversation) {
			return json({ error: "Conversation not found" }, { status: 404 });
		}
		return json(conversation);
	}

	// Handle title rename
	if (typeof body.title !== "string" || body.title.trim().length === 0) {
		return json({ error: "Title is required" }, { status: 400 });
	}

	const conversation = await updateConversationTitle(
		user.id,
		id,
		body.title.trim(),
	);
	if (!conversation) {
		return json({ error: "Conversation not found" }, { status: 404 });
	}

	return json(conversation);
};

export const DELETE: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	const { id } = event.params;

	let deleted: Awaited<ReturnType<typeof deleteConversationWithCleanup>>;
	try {
		deleted = await deleteConversationWithCleanup(user.id, id);
	} catch (error) {
		console.error(
			"[CONVERSATION_DELETE] Failed to fully delete conversation:",
			error,
		);
		return json(
			{ error: "Failed to fully delete conversation" },
			{ status: 500 },
		);
	}

	if (!deleted) {
		return json({ error: "Conversation not found" }, { status: 404 });
	}

	return json({
		success: true,
		deletedArtifactIds: deleted.deletedArtifactIds,
		preservedArtifactIds: deleted.preservedArtifactIds,
	});
};
