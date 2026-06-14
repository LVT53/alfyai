import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { resolveKnowledgeWorkspaceDocument } from "$lib/server/services/knowledge";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const artifactId = event.url.searchParams.get("artifactId")?.trim() ?? "";
	if (!artifactId) {
		return json({ document: null }, { status: 400 });
	}

	const document = await resolveKnowledgeWorkspaceDocument(
		event.locals.user.id,
		artifactId,
	);
	return json({ document });
};
