import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	isProjectKnowledgeError,
	linkProjectKnowledge,
	listProjectKnowledge,
} from "$lib/server/services/knowledge";
import { getProject } from "$lib/server/services/projects";
import type { RequestHandler } from "./$types";

function parseArtifactIds(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	if (value.length === 0) return null;
	if (
		!value.every((item) => typeof item === "string" && item.trim().length > 0)
	) {
		return null;
	}
	return value.map((item) => item.trim());
}

function projectKnowledgeErrorResponse(error: unknown) {
	if (isProjectKnowledgeError(error)) {
		return json(
			{ error: error.message, code: error.code },
			{ status: error.status },
		);
	}
	return json(
		{ error: error instanceof Error ? error.message : "Project files failed" },
		{ status: 500 },
	);
}

/**
 * The project's linked library documents.
 *
 * The ownership check is this read's own — the service would answer an empty
 * list for somebody else's project, and "empty" and "not yours" must not look
 * the same to a client that asked for a project it cannot see.
 */
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const project = await getProject(user.id, event.params.id);
	if (!project) {
		return json({ error: "Project not found" }, { status: 404 });
	}

	const files = await listProjectKnowledge({
		userId: user.id,
		projectId: project.id,
	});
	return json({ files });
};

/** Links library documents to the project. Adds links; copies nothing. */
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const body = await event.request.json().catch(() => null);
	const artifactIds = body
		? parseArtifactIds((body as { artifactIds?: unknown }).artifactIds)
		: null;
	if (!artifactIds) {
		return json(
			{ error: "artifactIds must be a non-empty array of artifact ids" },
			{ status: 400 },
		);
	}

	try {
		const files = await linkProjectKnowledge({
			userId: user.id,
			projectId: event.params.id,
			artifactIds,
		});
		return json({ files });
	} catch (error) {
		return projectKnowledgeErrorResponse(error);
	}
};
