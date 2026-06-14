import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	editDeepResearchPlan,
	isDeepResearchPlanActionError,
} from "$lib/server/services/deep-research";
import type { DeepResearchReportIntent } from "$lib/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const body = await event.request.json().catch(() => null);
	const editInstruction =
		body && typeof body.editInstruction === "string"
			? body.editInstruction.trim()
			: "";
	const reportIntent =
		body && isReportIntent(body.reportIntent) ? body.reportIntent : undefined;
	if (!editInstruction && !reportIntent) {
		return json(
			{ error: "Plan Edit instruction is required" },
			{ status: 400 },
		);
	}

	try {
		const job = await editDeepResearchPlan({
			userId: user.id,
			jobId: event.params.id,
			editInstruction,
			reportIntent,
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

function isReportIntent(value: unknown): value is DeepResearchReportIntent {
	return (
		value === "comparison" ||
		value === "recommendation" ||
		value === "investigation" ||
		value === "market_scan" ||
		value === "product_scan" ||
		value === "limitation_focused"
	);
}
