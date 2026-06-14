import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { cancelFileProductionJob } from "$lib/server/services/file-production";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const job = await cancelFileProductionJob({
		userId: user.id,
		jobId: event.params.id,
	});

	if (!job) {
		return json(
			{ error: "File production job not found or not cancellable" },
			{ status: 404 },
		);
	}

	return json({ job });
};
