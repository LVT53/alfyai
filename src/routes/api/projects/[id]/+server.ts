import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	deleteProject,
	type UpdateProjectInput,
	updateProject,
} from "$lib/server/services/projects";
import { validateInstructionInput } from "$lib/shared/instructions";
import type { RequestHandler } from "./$types";

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
