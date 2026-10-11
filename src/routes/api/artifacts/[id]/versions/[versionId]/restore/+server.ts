import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { restoreVersion } from "$lib/server/services/artifacts";
import type {
	RestoreVersionRequest,
	RestoreVersionResponse,
} from "$lib/shared/artifacts/history";
import type { RequestHandler } from "./$types";

/** A field that is absent (`undefined`), a whole number of at least one, or neither (`null`). */
function optionalPositiveInteger(value: unknown): number | null | undefined {
	if (value === undefined) return undefined;
	return typeof value === "number" && Number.isInteger(value) && value >= 1
		? value
		: null;
}

// POST /api/artifacts/[id]/versions/[versionId]/restore — writes the old body
// back as a NEW version (restoreVersion never coalesces, ruling 47), so a
// restore is itself undoable. `version` is the version NUMBER the restore just
// created (not the version row's id), for the panel to fold straight into its
// next expectVersion; `versionId` is that row, for History to select it.
//
// The JSON body is optional (older callers send none): `expectVersion` is the
// newest version the reader saw, and a restore over a newer one is a 409
// `version_conflict` like a stale save; `undoOf` is the version number of the
// newest row when this restore reverses it (the restore toast's Undo), which
// makes the summary say what was undone (ruling 76, A5).
//
// An App version the current contract audit calls a violation (ruling 58) is a
// 422 `not_runnable`, like the saved-version route's: the restore would make it
// the live App.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const versionId = event.params.versionId;
	const conversationId = event.url.searchParams.get("conversationId");

	const payload = (await event.request.json().catch(() => null)) as
		| {
				[K in keyof RestoreVersionRequest]?: unknown;
		  }
		| null;
	const expectVersion = optionalPositiveInteger(payload?.expectVersion);
	const undoOf = optionalPositiveInteger(payload?.undoOf);
	if (expectVersion === null || undoOf === null) {
		return json(
			{ ok: false, reason: "invalid_request" } satisfies RestoreVersionResponse,
			{ status: 400 },
		);
	}

	const result = await restoreVersion({
		userId: user.id,
		artifactId,
		versionId,
		conversationId,
		expectVersion,
		undoOf,
	});
	if (!result.ok) {
		return json(
			{ ok: false, reason: result.reason } satisfies RestoreVersionResponse,
			{
				status:
					result.reason === "not_found"
						? 404
						: result.reason === "version_conflict"
							? 409
							: result.reason === "not_runnable"
								? 422
								: 400,
			},
		);
	}

	return json({
		ok: true,
		version: result.versionNumber,
		versionId: result.versionId,
		kind: result.kind,
	} satisfies RestoreVersionResponse);
};
