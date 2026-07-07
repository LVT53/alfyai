import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { runMemoryRecuration } from "$lib/server/services/memory-recuration";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);

	try {
		const body = (await event.request.json().catch(() => ({}))) as {
			userId?: string;
		};

		const userIds = body.userId
			? [body.userId]
			: (await db.select({ id: users.id }).from(users)).map((row) => row.id);

		const results: Record<
			string,
			{
				kept: number;
				rewritten: number;
				retired: number;
				reviewResolved: number;
			}
		> = {};
		for (const userId of userIds) {
			results[userId] = await runMemoryRecuration(userId);
		}

		return json({ results });
	} catch (error) {
		console.error("[MEMORY_RECURATION] Admin trigger failed:", error);
		return json(
			{ error: "Failed to run memory re-curation." },
			{ status: 500 },
		);
	}
};
