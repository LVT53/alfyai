import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { getArtifact, getVersionBody } from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

// GET /api/artifacts/[id]/versions/[versionId] — one version's stored body,
// for the History sheet's preview. 404, never a partial body, for a version
// of another artifact or another user (getVersionBody is itself scoped
// through readScopedArtifactRow).
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const versionId = event.params.versionId;
	const conversationId = event.url.searchParams.get("conversationId");

	const artifact = await getArtifact({
		userId: user.id,
		artifactId,
		conversationId,
	});
	if (!artifact) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	const body = await getVersionBody({
		userId: user.id,
		artifactId,
		versionId,
		conversationId,
	});
	if (body === null) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	return json({ ok: true, body });
};
