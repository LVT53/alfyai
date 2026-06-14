import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	deleteManagedUser,
	updateManagedUserRole,
} from "$lib/server/services/user-admin";
import { adminUserErrorResponse } from "../_shared";
import type { RequestHandler } from "./$types";

export const PATCH: RequestHandler = async (event) => {
	requireAdmin(event);

	let body: { role?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	if (body.role !== "user" && body.role !== "admin") {
		return json({ error: "role must be user or admin" }, { status: 400 });
	}

	try {
		const user = await updateManagedUserRole({
			actorUserId: event.locals.user?.id,
			targetUserId: event.params.id,
			role: body.role,
		});
		return json({ user });
	} catch (error) {
		return adminUserErrorResponse(error, "Failed to update user role.");
	}
};

export const DELETE: RequestHandler = async (event) => {
	requireAdmin(event);

	try {
		await deleteManagedUser({
			actorUserId: event.locals.user?.id,
			targetUserId: event.params.id,
		});
		return json({ success: true });
	} catch (error) {
		return adminUserErrorResponse(error, "Failed to delete user.");
	}
};
