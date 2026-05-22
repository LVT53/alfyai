import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	deleteProject,
	setProjectSidebarPinned,
	updateProject,
} from "$lib/server/services/projects";
import type { RequestHandler } from "./$types";

export const PATCH: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	const { id } = event.params;
	const body = await event.request.json().catch(() => null);

	if (body && "sidebarPinned" in body) {
		if (typeof body.sidebarPinned !== "boolean") {
			return json(
				{ error: "sidebarPinned must be a boolean" },
				{ status: 400 },
			);
		}
		const project = await setProjectSidebarPinned(
			user.id,
			id,
			body.sidebarPinned,
		);
		if (!project) {
			return json({ error: "Project not found" }, { status: 404 });
		}
		return json(project);
	}

	if (!body || typeof body.name !== "string" || body.name.trim().length === 0) {
		return json({ error: "Name is required" }, { status: 400 });
	}
	const project = await updateProject(user.id, id, { name: body.name.trim() });
	if (!project) {
		return json({ error: "Project not found" }, { status: 404 });
	}
	return json(project);
};

export const DELETE: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	const { id } = event.params;
	const deleted = await deleteProject(user.id, id);
	if (!deleted) {
		return json({ error: "Project not found" }, { status: 404 });
	}
	return json({ success: true });
};
