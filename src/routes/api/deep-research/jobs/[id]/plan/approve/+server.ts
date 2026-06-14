import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	approveDeepResearchPlan,
	isDeepResearchPlanActionError,
} from "$lib/server/services/deep-research";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const job = await approveDeepResearchPlan({
			userId: user.id,
			jobId: event.params.id,
		});

		if (!job) {
			return json({ error: "Deep Research job not found" }, { status: 404 });
		}

		return json({ job });
	} catch (error) {
		if (isDeepResearchPlanActionError(error)) {
			return json(
				{ error: error.message, code: error.code },
				{ status: error.status },
			);
		}
		throw error;
	}
};
