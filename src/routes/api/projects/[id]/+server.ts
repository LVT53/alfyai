import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	deleteProject,
	getProjectInstructions,
	type UpdateProjectInput,
	updateProject,
} from "$lib/server/services/projects";
import { validateInstructionInput } from "$lib/shared/instructions";
import type { RequestHandler } from "./$types";

/**
 * The project's own instruction text, read back by the one browser surface that
 * has to show it: the instructions dialog `/instruction` opens, where the text
 * already saved and the text being added must be visible together before
 * anything is written. `Project` deliberately never carries the text, so this
 * is its own read rather than a wider list payload — and the ownership check is
 * the read's own.
 */
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	const project = await getProjectInstructions(user.id, event.params.id);
	if (!project) {
		return json({ error: "Project not found" }, { status: 404 });
	}
	return json({
		project: {
			id: project.id,
			name: project.name,
			instructions: project.text,
		},
	});
};

export const PATCH: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	const { id } = event.params;
	const body = await event.request.json().catch(() => null);

	const hasName = body?.name !== undefined;
	const hasInstructions = body?.instructions !== undefined;
	if (!hasName && !hasInstructions) {
		return json({ error: "Nothing to update" }, { status: 400 });
	}

	const updates: UpdateProjectInput = {};

	if (hasName) {
		if (typeof body.name !== "string" || body.name.trim().length === 0) {
			return json({ error: "Name is required" }, { status: 400 });
		}
		updates.name = body.name.trim();
	}
	if (hasInstructions) {
		const validated = validateInstructionInput(body.instructions);
		if (!validated.ok) {
			return json(
				{
					error:
						validated.error === "too_long"
							? "Instructions are too long"
							: "Invalid instructions",
				},
				{ status: 400 },
			);
		}
		updates.instructions = validated.value;
	}

	const project = await updateProject(user.id, id, updates);
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
