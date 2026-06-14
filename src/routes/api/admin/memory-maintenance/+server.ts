import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { runAllUsersMemoryMaintenance } from "$lib/server/services/memory-maintenance";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);

	try {
		await runAllUsersMemoryMaintenance("admin_trigger");
		return json({ success: true });
	} catch (error) {
		console.error("[MEMORY_MAINTENANCE] Admin trigger failed:", error);
		return json(
			{ error: "Failed to run memory maintenance." },
			{ status: 500 },
		);
	}
};
