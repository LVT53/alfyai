import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getFileProductionJobForUser } from "$lib/server/services/file-production";
import type { RequestHandler } from "./$types";

// GET /api/chat/files/jobs/[id] — one of the caller's own jobs, with the files
// it has made so far. What a Download polls after it started an export
// (`POST /api/artifacts/[id]/export`, `…/app/download`): the job has finished
// when its status says so, and the file is then downloaded through the
// canonical `/api/chat/files/[id]/download`. An unknown id and another user's
// job answer the same 404, so the route reveals nothing about which it was.
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const job = await getFileProductionJobForUser({
		userId: user.id,
		jobId: event.params.id,
	});
	if (!job) {
		return json({ error: "File production job not found" }, { status: 404 });
	}

	return json({ job });
};
