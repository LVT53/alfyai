import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	retryFileProductionJob,
	wakeFileProductionWorker,
} from "$lib/server/services/file-production";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	const job = await retryFileProductionJob({
		userId: user.id,
		jobId: event.params.id,
	});

	if (!job) {
		return json(
			{ error: "File production job not found or not retryable" },
			{ status: 404 },
		);
	}

	if (job.status === "queued" || job.status === "running") {
		wakeFileProductionWorker();
	}

	return json({ job });
};
