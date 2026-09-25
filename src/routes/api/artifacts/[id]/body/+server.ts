import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	documentTabsFromMetadata,
	getArtifact,
	saveDocumentBody,
	updateArtifactBody,
} from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

// PATCH /api/artifacts/[id]/body — the one write route every kind's body goes
// through (ruling 13: the field is `body` for every type, never `markdown`,
// since Canvas and Slides write JSON through this same shape). The panel's
// autosave is the only caller in this slice, so this route always opts into
// ruling 47's coalescing (`coalesceUserEdits: true`) — a burst of keystrokes
// updates the latest version in place rather than minting one per debounce.
//
// A Document's tabs are carried forward UNCHANGED on an ordinary body save:
// this route reads the artifact's current metadata and re-supplies the same
// tab list, so typing never touches the tab strip (T9 owns the path that
// actually changes it).
export const PATCH: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const conversationId = event.url.searchParams.get("conversationId");

	const payload = (await event.request.json().catch(() => null)) as {
		body?: unknown;
		expectVersion?: unknown;
	} | null;
	if (!payload || typeof payload.body !== "string") {
		return json({ ok: false, reason: "invalid_patch" }, { status: 400 });
	}
	const expectVersion =
		typeof payload.expectVersion === "number"
			? payload.expectVersion
			: undefined;

	const artifact = await getArtifact({
		userId: user.id,
		artifactId,
		conversationId,
	});
	if (!artifact) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	const result =
		artifact.kind === "document"
			? await saveDocumentBody({
					userId: user.id,
					artifactId,
					conversationId,
					body: {
						markdown: payload.body,
						tabs: documentTabsFromMetadata(artifact.metadata),
					},
					author: "user",
					summary: "Edited",
					expectVersion,
					coalesceUserEdits: true,
				})
			: await updateArtifactBody({
					userId: user.id,
					artifactId,
					conversationId,
					body: payload.body,
					author: "user",
					summary: "Edited",
					expectVersion,
					coalesceUserEdits: true,
				}).then((r) => (r.ok ? { ok: true, version: r.versionNumber } : r));

	if (!result.ok) {
		const status =
			result.reason === "not_found"
				? 404
				: result.reason === "too_large"
					? 413
					: result.reason === "version_conflict" || result.reason === "stale"
						? 409
						: 400;
		return json({ ok: false, reason: result.reason }, { status });
	}

	return json({ ok: true, version: result.version });
};
