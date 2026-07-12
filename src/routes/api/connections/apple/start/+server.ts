import { handleCredentialConnect } from "$lib/server/api/connect";
import {
	AppleCalDavError,
	appleConnect,
} from "$lib/server/services/connections/providers/apple-caldav";
import type { RequestHandler } from "./$types";

// POST /api/connections/apple/start — no redirect flow (Apple has no
// calendar OAuth): the client posts the pasted Apple ID email + an
// app-specific password (generated at appleid.apple.com) and this route
// synchronously runs the whole CalDAV discovery chain before responding.
export const POST: RequestHandler = (event) =>
	handleCredentialConnect({
		event,
		errorType: AppleCalDavError,
		fallbackError: "Failed to connect to Apple iCloud",
		parse: (body) => {
			const appleId =
				typeof body.appleId === "string" ? body.appleId.trim() : "";
			const appPassword =
				typeof body.appPassword === "string" ? body.appPassword.trim() : "";
			if (!appleId || !appPassword) {
				return { ok: false, error: "appleId and appPassword are required" };
			}
			return { ok: true, value: { appleId, appPassword } };
		},
		connect: ({ userId, value }) =>
			appleConnect({
				userId,
				appleId: value.appleId,
				appPassword: value.appPassword,
			}),
	});
