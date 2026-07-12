import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import {
	OwnTracksError,
	owntracksListDevices,
} from "$lib/server/services/connections/providers/owntracks";
import type { RequestHandler } from "./$types";

// GET /api/connections/owntracks/devices — lists every (otUser, otDevice)
// pair the on-box recorder knows about, so the client can present a picker
// for the user to self-select "which device is mine". This is a CONNECT-time
// listing only; it never reads/returns any location data, and the isolation
// guarantee (a user can only ever read the device they bind to) is enforced
// later, at read time, by owntracksLastLocation/owntracksLocationHistory —
// not by restricting this list.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);

	try {
		const devices = await owntracksListDevices(user.id);
		return json({ devices });
	} catch (err) {
		const status =
			err instanceof OwnTracksError && err.code === "not_configured"
				? 409
				: 502;
		return createJsonErrorResponse(
			err instanceof OwnTracksError
				? err.message
				: "Failed to list OwnTracks devices",
			status,
		);
	}
};
