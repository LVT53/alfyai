import { json } from "@sveltejs/kit";
import { currentPasswordRefusal } from "$lib/server/api/current-password";
import { requireAuth } from "$lib/server/auth/hooks";
import { updateOwnProfile } from "$lib/server/services/auth";
import type { RequestHandler } from "./$types";

export const PATCH: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user?.id;

	let body: { name?: unknown; email?: unknown; currentPassword?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const { name, email, currentPassword } = body;
	if (name !== undefined && typeof name !== "string") {
		return json({ error: "name must be a string" }, { status: 400 });
	}
	if (
		email !== undefined &&
		(typeof email !== "string" || !email.includes("@"))
	) {
		return json({ error: "Invalid email address" }, { status: 400 });
	}

	// What a change costs (an email asks for the account password) is the
	// service's; this answers for it.
	const result = await updateOwnProfile(userId, {
		name,
		email,
		currentPassword:
			typeof currentPassword === "string" ? currentPassword : undefined,
	});

	switch (result.status) {
		case "updated":
			return json({ name: result.name, email: result.email });
		case "not_found":
			return json({ error: "User not found" }, { status: 404 });
		case "password_required":
			return json(
				{
					error: "password_required",
					errorKey: "profileTab.emailNeedsPassword",
				},
				{ status: 400 },
			);
		case "password_refused":
			return currentPasswordRefusal(result.check);
		case "email_taken":
			return json({ error: "Email already in use" }, { status: 409 });
	}
};
