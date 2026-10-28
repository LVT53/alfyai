import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	deleteManagedUser,
	setManagedUserExplicitPictureFilterExempt,
	updateManagedUserRole,
} from "$lib/server/services/user-admin";
import { adminUserErrorResponse } from "../_shared";
import type { RequestHandler } from "./$types";

export const PATCH: RequestHandler = async (event) => {
	requireAdmin(event);
	const actorUserId = event.locals.user.id;

	let body: { role?: unknown; explicitPictureFilterExempt?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	// The explicit-picture filter exemption is its own change, never mixed with a role change.
	if ("explicitPictureFilterExempt" in body) {
		if (typeof body.explicitPictureFilterExempt !== "boolean") {
			return json(
				{ error: "explicitPictureFilterExempt must be true or false" },
				{ status: 400 },
			);
		}
		try {
			const user = await setManagedUserExplicitPictureFilterExempt({
				targetUserId: event.params.id,
				exempt: body.explicitPictureFilterExempt,
			});
			return json({ user });
		} catch (error) {
			return adminUserErrorResponse(
				error,
				"Failed to update the picture filter.",
			);
		}
	}

	if (body.role !== "user" && body.role !== "admin") {
		return json({ error: "role must be user or admin" }, { status: 400 });
	}

	try {
		const user = await updateManagedUserRole({
			actorUserId,
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
	const actorUserId = event.locals.user.id;

	try {
		await deleteManagedUser({
			actorUserId,
			targetUserId: event.params.id,
		});
		return json({ success: true });
	} catch (error) {
		return adminUserErrorResponse(error, "Failed to delete user.");
	}
};
