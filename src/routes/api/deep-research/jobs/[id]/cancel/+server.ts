import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { cancelPrePlanDeepResearchJob } from "$lib/server/services/deep-research";
import { requestDeepResearchWorkerCancellation } from "$lib/server/services/deep-research/worker";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const job =
		(await cancelPrePlanDeepResearchJob({
			userId: user.id,
			jobId: event.params.id,
		})) ??
		(await requestDeepResearchWorkerCancellation({
			userId: user.id,
			jobId: event.params.id,
		}));

	if (!job) {
		return json(
			{ error: "Deep Research job not found or not cancellable" },
			{ status: 404 },
		);
	}

	return json({ job });
};
