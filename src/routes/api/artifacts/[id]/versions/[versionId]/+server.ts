import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	getArtifact,
	getVersionBody,
	nameVersion,
} from "$lib/server/services/artifacts";
import type {
	NameVersionRequest,
	NameVersionResponse,
} from "$lib/shared/artifacts/history";
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

// PATCH /api/artifacts/[id]/versions/[versionId] — the reader's name for a
// version, `{ label: string | null }` (ruling 76, Q3). Naming is a fact about
// one row, never a body: it mints no version and changes nothing else. Blank or
// null removes the name; more than 60 characters, or anything that is not
// text, is a 400. Scoped like every artifact route, so a version that is not
// the caller's to name is the same 404 as a missing one.
export const PATCH: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const payload = (await event.request.json().catch(() => null)) as
		| {
				[K in keyof NameVersionRequest]?: unknown;
		  }
		| null;
	if (!payload || typeof payload !== "object" || !("label" in payload)) {
		return json(
			{ ok: false, reason: "invalid_label" } satisfies NameVersionResponse,
			{ status: 400 },
		);
	}

	const result = await nameVersion({
		userId: user.id,
		artifactId: event.params.id,
		versionId: event.params.versionId,
		conversationId: event.url.searchParams.get("conversationId"),
		label: payload.label,
	});
	if (!result.ok) {
		return json(result satisfies NameVersionResponse, {
			status: result.reason === "not_found" ? 404 : 400,
		});
	}
	return json(result satisfies NameVersionResponse);
};
