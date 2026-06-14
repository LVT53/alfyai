import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { resolveGeneratedFileServing } from "$lib/server/services/generated-file-serving";
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
	const fileId = event.params.id;
	const rangeHeader = event.request?.headers.get("range") ?? null;
	const result = await resolveGeneratedFileServing({
		userId: user.id,
		fileId,
		mode: "download",
		...(rangeHeader ? { rangeHeader } : {}),
	});
	if (!result.ok) {
		return json({ error: result.error }, { status: result.status });
	}

	return new Response(result.body, {
		status: result.status,
		headers: result.headers,
	});
};
