import { isHttpError, isRedirect, json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { deleteConversationWithCleanup } from "$lib/server/services/cleanup";
import { getConversationDetail } from "$lib/server/services/conversation-detail/read-model";
import {
	moveConversationToProject,
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
		const view =
			requestedView === "bootstrap" || requestedView === "first-render"
				? requestedView
				: "full";

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
