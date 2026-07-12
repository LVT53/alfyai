import { handleCredentialConnect } from "$lib/server/api/connect";
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
export const POST: RequestHandler = (event) =>
	handleCredentialConnect({
		event,
		errorType: OwnTracksError,
		fallbackError: "Failed to connect to OwnTracks",
		// not_configured (no recorder configured server-side) is a 409 here; the
		// base ladder handles invalid_config -> 400 and everything else -> 502.
		errorStatusOverrides: { not_configured: 409 },
		parse: (body) => {
			const otUser = typeof body.otUser === "string" ? body.otUser.trim() : "";
			const otDevice =
				typeof body.otDevice === "string" ? body.otDevice.trim() : "";
			const label =
				typeof body.label === "string" ? body.label.trim() : undefined;
			if (!otUser || !otDevice) {
				return { ok: false, error: "otUser and otDevice are required" };
			}
			return { ok: true, value: { otUser, otDevice, label } };
		},
		connect: ({ userId, value }) =>
			owntracksConnect({
				userId,
				otUser: value.otUser,
				otDevice: value.otDevice,
				...(value.label ? { label: value.label } : {}),
			}),
	});
