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
		// Nothing was deleted — either no such id, or not this user's to delete.
		//
		// This used to answer 200 with `deletedArtifactIds: [params.id]`,
		// fabricating the id it had NOT removed. For an unknown id that was
		// merely untrue; for a `generated_output` whose conversation had been
		// deleted it was the bug that hid the leak, because the row was still
		// there and the caller was told it was gone. The body matches the
		// unknown-id case exactly so a 404 never reveals whether an id exists.
		if (!result || result.deletedArtifactIds.length === 0) {
			console.info("[KNOWLEDGE_DELETE] Artifact not found for delete", {
				userId: user.id,
				artifactId: event.params.id,
				// Distinguishes "no row" from "row present but out of scope" in the
				// log, where it is safe, while the response cannot tell them apart.
				reason: result ? "out-of-scope" : "not-found",
			});
			return json({ error: "Artifact not found" }, { status: 404 });
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
