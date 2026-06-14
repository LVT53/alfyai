import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { resolveWorkingDocumentFileServing } from "$lib/server/services/knowledge/store/working-document-file-serving";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async (event) => {
	try {
		requireAuth(event);
	} catch {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	const artifactId = event.params.id;
	const rangeHeader = event.request?.headers.get("range") ?? null;

	const resolved = await resolveWorkingDocumentFileServing({
		userId: user.id,
		artifactId,
		mode: "download",
		...(rangeHeader ? { rangeHeader } : {}),
	});
	if (!resolved.ok) {
		return json({ error: resolved.error }, { status: resolved.status });
	}

	return new Response(resolved.body, {
		status: resolved.status,
		headers: resolved.headers,
	});
};
