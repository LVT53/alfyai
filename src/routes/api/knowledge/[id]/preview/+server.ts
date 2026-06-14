import { createJsonErrorResponse } from "$lib/server/api/responses";
import { requireAuth } from "$lib/server/auth/hooks";
import { resolveWorkingDocumentFileServing } from "$lib/server/services/knowledge/store/working-document-file-serving";
import type { RequestHandler } from "./$types";
/**
 * GET /api/knowledge/[id]/preview
 *
 * Returns the file content for preview purposes.
 * Handles both storagePath-based files and contentText-based artifacts.
 * Authenticates the user and verifies artifact ownership.
 */
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return createJsonErrorResponse("Unauthorized", 401);
	}
	const artifactId = event.params.id;
	const rangeHeader = event.request?.headers.get("range") ?? null;

	const resolved = await resolveWorkingDocumentFileServing({
		userId: user.id,
		artifactId,
		mode: "preview",
		...(rangeHeader ? { rangeHeader } : {}),
	});
	if (!resolved.ok) {
		return createJsonErrorResponse(resolved.error, resolved.status);
	}

	return new Response(resolved.body, {
		status: resolved.status,
		headers: resolved.headers,
	});
};
