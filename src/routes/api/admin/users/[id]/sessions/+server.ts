import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { revokeManagedUserSessions } from "$lib/server/services/user-admin";
import { adminUserErrorResponse } from "../../_shared";
import type { RequestHandler } from "./$types";

export const DELETE: RequestHandler = async (event) => {
	requireAdmin(event);

	try {
		await revokeManagedUserSessions(event.params.id);
		return json({ success: true });
	} catch (error) {
		return adminUserErrorResponse(error, "Failed to revoke sessions.");
	}
};
