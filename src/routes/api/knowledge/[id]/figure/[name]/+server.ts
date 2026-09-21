import { createJsonErrorResponse } from "$lib/server/api/responses";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	getArtifactForUser,
	getSourceArtifactIdForNormalizedArtifact,
} from "$lib/server/services/knowledge/store/core";
import { readMineruFigure } from "$lib/server/services/mineru/bundle";
import type { RequestHandler } from "./$types";

/**
 * GET /api/knowledge/[id]/figure/[name]
 *
 * One image MinerU extracted from a parsed document, from that document's
 * parse bundle.
 *
 * Authorization is `getArtifactForUser`, exactly as download and preview do
 * it — never a lookup of `artifacts` by id alone. Another user's artifact is a
 * 404 identical to an unknown one, so this endpoint cannot be used to learn
 * which artifact ids exist.
 *
 * No UI renders a figure in this phase. The endpoint ships with the bundle so
 * the images are not written to disk with no way to read them back, and so a
 * follow-up (or a model-facing tool) has something to call.
 */
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return createJsonErrorResponse("Unauthorized", 401);
	}

	const artifact = await getArtifactForUser(user.id, event.params.id);
	if (!artifact) {
		return createJsonErrorResponse("Not found", 404);
	}

	// The bundle is keyed on the SOURCE artifact, but a caller holding a
	// document usually holds its normalized half. Same hop
	// `working-document-file-serving.ts` makes.
	let sourceArtifactId = artifact.id;
	if (artifact.type === "normalized_document") {
		const resolved = await getSourceArtifactIdForNormalizedArtifact(
			user.id,
			artifact.id,
		);
		if (!resolved) {
			return createJsonErrorResponse("Not found", 404);
		}
		sourceArtifactId = resolved;
	}

	// `readMineruFigure` refuses a traversal, a name the manifest does not
	// list, a type that is not a servable image and a symlink. It returns null
	// for every one of them, and for a missing file, so none of those cases is
	// distinguishable from the outside.
	//
	// The bundle sits under the OWNER's `data/knowledge/<userId>/`, and an
	// artifact the caller may read is not always one they own — an artifact is
	// also canonically owned through a conversation the caller owns, which is
	// the whole reason `getArtifactForUser` exists rather than a `userId`
	// equality check. Deriving the directory from the CALLER made every figure
	// of such a document 404. `getArtifactForUser` above is the authorization;
	// this is only where the bytes live, exactly as `row.storagePath` is for
	// download and preview.
	const figure = await readMineruFigure({
		userId: artifact.userId,
		sourceArtifactId,
		name: event.params.name,
	});
	if (!figure) {
		return createJsonErrorResponse("Not found", 404);
	}

	return new Response(figure.stream, {
		status: 200,
		headers: {
			"Content-Type": figure.contentType,
			"Content-Length": figure.bytes.toString(),
			// These bytes came out of a document the app did not author, so they
			// are served under the same restrictive policy the repo uses for an
			// untrusted preview: no sniffing, no scripts, no referrer, and only
			// the raster image types the manifest allows — never SVG.
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy":
				"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
			"Referrer-Policy": "no-referrer",
			"Content-Disposition": `inline; filename="${encodeURIComponent(
				event.params.name,
			)}"`,
			"Cache-Control": "private, max-age=3600",
		},
	});
};
