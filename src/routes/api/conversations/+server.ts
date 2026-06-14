import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	createConversation,
	listConversations,
} from "$lib/server/services/conversations";
import { getProject } from "$lib/server/services/projects";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	const conversations = await listConversations(user.id);
	return json({ conversations });
};

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	const body = await event.request.json().catch(() => ({}));
	const title =
		typeof body?.title === "string"
			? body.title.trim() || undefined
			: undefined;
	const projectId =
		body?.projectId === undefined || body?.projectId === null
			? null
			: typeof body.projectId === "string"
				? body.projectId.trim()
				: undefined;

	if (projectId === undefined || projectId === "") {
		return json(
			{ error: "projectId must be a string or null" },
			{ status: 400 },
		);
	}
	if (projectId) {
		const project = await getProject(user.id, projectId);
		if (!project) {
			return json({ error: "Project not found" }, { status: 404 });
		}
	}

	const conversation = await createConversation(user.id, title, { projectId });
	return json(conversation, { status: 201 });
};
