import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { researchFurtherFromDeepResearchReport } from "$lib/server/services/deep-research";
import type { DeepResearchDepth } from "$lib/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const body = await event.request.json().catch(() => ({}));
	const depth = readDepth(body?.depth);
	if (body?.depth != null && !depth) {
		return json({ error: "Invalid Deep Research depth" }, { status: 400 });
	}

	const action = await researchFurtherFromDeepResearchReport({
		userId: user.id,
		jobId: event.params.id,
		depth,
	});

	if (!action) {
		return json(
			{
				error:
					"Completed Research Report or Evidence Limitation Memo not found",
			},
			{ status: 404 },
		);
	}

	return json(action, { status: 201 });
};

function readDepth(value: unknown): DeepResearchDepth | undefined {
	if (value === "focused" || value === "standard" || value === "max") {
		return value;
	}
	return undefined;
}
