import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { triggerDeepResearchWorkflowWorkerForJob } from "$lib/server/services/deep-research/worker";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const config = getConfig();
	const result = await triggerDeepResearchWorkflowWorkerForJob({
		userId: user.id,
		jobId: event.params.id,
		controls: {
			globalConcurrencyLimit: config.deepResearchWorkerGlobalConcurrency,
			userConcurrencyLimit: config.deepResearchWorkerUserConcurrency,
		},
	});

	if (!result) {
		return json({ error: "Deep Research job not found" }, { status: 404 });
	}

	return json(result);
};
