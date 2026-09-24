import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	isProjectKnowledgeError,
	unlinkProjectKnowledge,
} from "$lib/server/services/knowledge";
import type { RequestHandler } from "./$types";

/**
 * Removes the project's link to a library document.
 *
 * Unlink, never delete: the document stays in the library with its bytes
 * untouched. A document that was not linked is still a success — the caller
 * asked for the link to be gone and it is gone.
 */
export const DELETE: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		await unlinkProjectKnowledge({
			userId: user.id,
			projectId: event.params.id,
			artifactId: event.params.artifactId,
		});
	} catch (error) {
		if (isProjectKnowledgeError(error)) {
			return json(
				{ error: error.message, code: error.code },
				{ status: error.status },
			);
		}
		return json(
			{ error: error instanceof Error ? error.message : "Unlink failed" },
			{ status: 500 },
		);
	}

	return json({ success: true });
};
