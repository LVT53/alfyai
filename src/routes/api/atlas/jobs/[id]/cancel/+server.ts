import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { cancelAtlasJob } from "$lib/server/services/atlas";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const job = await cancelAtlasJob({
		userId: user.id,
		jobId: event.params.id,
	});
	if (!job) {
		return json(
			{ error: "Atlas job not found or not cancellable" },
			{ status: 404 },
		);
	}

	return json({ job });
};
