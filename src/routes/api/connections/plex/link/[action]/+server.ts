import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import { requireApiUser } from "$lib/server/api/auth";
import {
	privateSetupHeaders,
	readSetupRequest,
} from "$lib/server/api/connection-setup";
import { ConnectionHttpError } from "$lib/server/services/connections/provider-http";
import {
	plexSetupSession,
	pollPlexSetup,
	selectPlexServer,
	startPlexSetup,
} from "$lib/server/services/connections/providers/plex-setup";
import type { RequestHandler } from "./$types";

const start = z.strictObject({
	connectionId: z.string().min(1).max(128).optional(),
});
const poll = z.strictObject({ attemptId: z.uuid() });
const select = poll.extend({ serverId: z.string().min(1).max(512) });
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const cookie = event.cookies.get("session");
	if (!cookie) error(401, "Unauthorized");
	const session = plexSetupSession(cookie);
	const read = <T>(schema: z.ZodType<T>) =>
		readSetupRequest(event.request, schema, event.url.origin);
	const reply = (value: unknown) =>
		json(value, { headers: privateSetupHeaders });
	try {
		switch (event.params.action) {
			case "start":
				return reply(
					await startPlexSetup(
						user.id,
						session,
						(await read(start)).connectionId,
					),
				);
			case "status":
				return reply(
					await pollPlexSetup(user.id, session, (await read(poll)).attemptId),
				);
			case "select": {
				const { attemptId, serverId } = await read(select);
				return reply(
					await selectPlexServer(user.id, session, attemptId, serverId),
				);
			}
			default:
				return error(404, "Unknown Plex setup step");
		}
	} catch (err) {
		if (!(err instanceof ConnectionHttpError)) throw err;
		switch (err.code) {
			case "expired":
			case "needs_reauth":
				return error(410, "Sign in to Plex again");
			case "busy":
			case "rate_limited":
				return error(429, "Try again shortly");
			case "pending":
				return error(409, "Waiting for Plex approval");
			case "no_server_grant":
				return error(403, "Plex has not granted access to this server");
			case "server_unavailable":
				return error(422, "Cannot reach this Plex server");
			default:
				return error(502, "Cannot contact Plex");
		}
	}
};
