import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	createManagedUser,
	listManagedUsers,
} from "$lib/server/services/user-admin";
import { adminUserErrorResponse } from "./_shared";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);

	try {
		const users = await listManagedUsers();
		return json({ users });
	} catch (error) {
		console.error("[ADMIN_USERS_LIST] Failed to list users:", error);
		return json({ error: "Failed to load users." }, { status: 500 });
	}
};

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);

	let body: {
		email?: unknown;
		password?: unknown;
		name?: unknown;
		role?: unknown;
	};
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	if (typeof body.email !== "string" || typeof body.password !== "string") {
		return json({ error: "email and password are required" }, { status: 400 });
	}
	if (
		body.name !== undefined &&
		body.name !== null &&
		typeof body.name !== "string"
	) {
		return json({ error: "name must be a string" }, { status: 400 });
	}
	if (
		body.role !== undefined &&
		body.role !== "user" &&
		body.role !== "admin"
	) {
		return json({ error: "role must be user or admin" }, { status: 400 });
	}

	try {
		const user = await createManagedUser({
			email: body.email,
			password: body.password,
			name: (body.name as string | null | undefined) ?? null,
			role: (body.role as "user" | "admin" | undefined) ?? "user",
		});
		return json({ user }, { status: 201 });
	} catch (error) {
		return adminUserErrorResponse(error, "Failed to create user.");
	}
};
