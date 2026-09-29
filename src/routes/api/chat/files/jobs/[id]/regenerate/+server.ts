import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	regenerateFileProductionJob,
	wakeFileProductionWorker,
} from "$lib/server/services/file-production";
import type { RequestHandler } from "./$types";

// POST /api/chat/files/jobs/[id]/regenerate — "Regenerate" on a produced file
// that was deleted: the SAME job is queued again from the request it kept
// (file-production's `regenerateFileProductionJob` owns the rules), and the
// worker makes the file as a new attempt. One answer for an unknown job,
// another user's job, a job that still has its file and one with no stored
// request, so the route reveals nothing about which it was.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	const job = await regenerateFileProductionJob({
		userId: user.id,
		jobId: event.params.id,
	});

	if (!job) {
		return json(
			{ error: "File production job not found or has nothing to regenerate" },
			{ status: 404 },
		);
	}

	wakeFileProductionWorker();

	return json({ job });
};
