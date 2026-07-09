import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	AppleCalDavError,
	appleConnect,
} from "$lib/server/services/connections/providers/apple-caldav";
import type { RequestHandler } from "./$types";

// POST /api/connections/apple/start — no redirect flow (Apple has no
// calendar OAuth): the client posts the pasted Apple ID email + an
// app-specific password (generated at appleid.apple.com) and this route
// synchronously runs the whole CalDAV discovery chain before responding.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	let body: { appleId?: unknown; appPassword?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const appleId = typeof body.appleId === "string" ? body.appleId.trim() : "";
	const appPassword =
		typeof body.appPassword === "string" ? body.appPassword.trim() : "";
	if (!appleId || !appPassword) {
		return json(
			{ error: "appleId and appPassword are required" },
			{ status: 400 },
		);
	}

	try {
		const result = await appleConnect({
			userId: user.id,
			appleId,
			appPassword,
		});
		return json(result);
	} catch (err) {
		const status =
			err instanceof AppleCalDavError && err.code === "invalid_credentials"
				? 401
				: 502;
		return json(
			{
				error:
					err instanceof AppleCalDavError
						? err.message
						: "Failed to connect to Apple iCloud",
			},
			{ status },
		);
	}
};
