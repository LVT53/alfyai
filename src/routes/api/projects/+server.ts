import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { createProject, listProjects } from "$lib/server/services/projects";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const projects = await listProjects(user.id);
	return json({ projects });
};

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const body = await event.request.json().catch(() => ({}));
	const name = typeof body?.name === "string" ? body.name.trim() : "";
	if (!name) {
		return json({ error: "Name is required" }, { status: 400 });
	}
	const project = await createProject(user.id, name);
	return json(project, { status: 201 });
};
