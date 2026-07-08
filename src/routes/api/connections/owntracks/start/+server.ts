import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	OwnTracksError,
	owntracksConnect,
} from "$lib/server/services/connections/providers/owntracks";
import type { RequestHandler } from "./$types";

// POST /api/connections/owntracks/start — binds the (otUser, otDevice) pair
// the user picked (from GET .../devices) to a connection owned by them. No
// token/password is ever accepted here: the recorder is admin-configured
// server-side (OWNTRACKS_RECORDER_URL, see config-store.ts), so there is
// nothing secret for this route to receive or store.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	let body: {
		otUser?: unknown;
		otDevice?: unknown;
		label?: unknown;
	};
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const otUser = typeof body.otUser === "string" ? body.otUser.trim() : "";
	const otDevice =
		typeof body.otDevice === "string" ? body.otDevice.trim() : "";
	const label = typeof body.label === "string" ? body.label.trim() : undefined;
	if (!otUser || !otDevice) {
		return json({ error: "otUser and otDevice are required" }, { status: 400 });
	}

	try {
		const result = await owntracksConnect({
			userId: user.id,
			otUser,
			otDevice,
			...(label ? { label } : {}),
		});
		return json(result);
	} catch (err) {
		const status =
			err instanceof OwnTracksError && err.code === "not_configured"
				? 409
				: err instanceof OwnTracksError && err.code === "invalid_config"
					? 400
					: 502;
		return json(
			{
				error:
					err instanceof OwnTracksError
						? err.message
						: "Failed to connect to OwnTracks",
			},
			{ status },
		);
	}
};
