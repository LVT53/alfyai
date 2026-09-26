import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { restoreVersion } from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

// POST /api/artifacts/[id]/versions/[versionId]/restore — writes the old body
// back as a NEW version (restoreVersion never coalesces, ruling 47), so a
// restore is itself undoable through the same History sheet. `version` is the
// version NUMBER the restore just created (not the version row's id), for the
// panel to fold straight into its next expectVersion.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const versionId = event.params.versionId;
	const conversationId = event.url.searchParams.get("conversationId");

	const result = await restoreVersion({
		userId: user.id,
		artifactId,
		versionId,
		conversationId,
	});
	if (!result.ok) {
		return json(
			{ ok: false, reason: result.reason },
			{ status: result.reason === "not_found" ? 404 : 400 },
		);
	}

	return json({ ok: true, version: result.versionNumber });
};
