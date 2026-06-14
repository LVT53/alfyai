import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	deleteArtifactForUser,
	getArtifactForUser,
	listArtifactLinksForUser,
} from "$lib/server/services/knowledge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const artifact = await getArtifactForUser(user.id, event.params.id);
	if (!artifact) {
		return json({ error: "Artifact not found" }, { status: 404 });
	}

	const links = await listArtifactLinksForUser(user.id, artifact.id);
	return json({ artifact, links });
};

export const DELETE: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	try {
		const result = await deleteArtifactForUser(user.id, event.params.id);
		if (!result) {
			console.info(
				"[KNOWLEDGE_DELETE] Artifact already removed or unavailable",
				{
					userId: user.id,
					artifactId: event.params.id,
				},
			);
			return json({
				success: true,
				deletedArtifactIds: [event.params.id],
				message: "This item was already removed from the Knowledge Base.",
			});
		}

		return json({
			success: true,
			deletedArtifactIds: result.deletedArtifactIds,
			message:
				result.failedStoragePaths.length > 0
					? "Removed from the Knowledge Base, but some local file cleanup had already failed and was logged."
					: "Removed from the Knowledge Base.",
		});
	} catch (error) {
		console.error("[KNOWLEDGE_DELETE] Failed to delete artifact:", {
			userId: user.id,
			artifactId: event.params.id,
			error,
		});
		return json(
			{
				success: false,
				error: "Failed to remove item from the Knowledge Base.",
				message: "Failed to remove item from the Knowledge Base.",
			},
			{ status: 500 },
		);
	}
};
