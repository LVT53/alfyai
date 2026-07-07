import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { runAllUsersMemoryRecuration } from "$lib/server/services/memory-recuration";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);

	try {
		const body = (await event.request.json().catch(() => ({}))) as {
			userId?: string;
		};

		const results = await runAllUsersMemoryRecuration(
			body.userId ? [body.userId] : undefined,
		);

		return json({ results });
	} catch (error) {
		console.error("[MEMORY_RECURATION] Admin trigger failed:", error);
		return json(
			{ error: "Failed to run memory re-curation." },
			{ status: 500 },
		);
	}
};
