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

	// Incognito, one-way: a landing-page arm-before-creation choice rides in
	// on this same request so the flag is set atomically with the row — there
	// is never a window where the conversation exists without it, and never a
	// follow-up PATCH racing the first send. Only `true` is meaningful here;
	// `false`/absent both mean "not incognito" (the default), so it is simply
	// ignored rather than rejected.
	const memoryIncognito = body?.memoryIncognito === true ? true : undefined;

	const conversation = await createConversation(user.id, title, {
		projectId,
		...(memoryIncognito ? { memoryIncognito } : {}),
	});
	return json(conversation, { status: 201 });
};
