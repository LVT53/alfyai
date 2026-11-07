import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { mapConnectError } from "$lib/server/api/connect";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import {
	ImmichError,
	immichEnableWrites,
} from "$lib/server/services/connections/providers/immich";
import { resolveConnectionsForCapability } from "$lib/server/services/connections/resolve";
import type { RequestHandler } from "./$types";

// POST /api/connections/immich/enable-writes — Issue 6.4's write-key
// provisioning route. Body is `{ password, connectionId? }`. With a
// `connectionId` (the Settings dialog is for one connection, so it names it) the
// key is made for that connection; without one the route locates the caller's
// Immich connection itself (same "photos" capability resolution the photos chat
// tool uses). Re-authenticates against the user's own Immich server (the
// password is used only in memory, inside immichEnableWrites, and is never
// persisted or logged) to mint a SEPARATE write-scoped API key — the
// existing read-only key from 5.5's connect flow is left completely
// untouched. This route only PROVISIONS the key; it does not itself flip
// `allowWrites` — that remains the user's own separate toggle.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);

	let body: { password?: unknown; connectionId?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return createJsonErrorResponse("Invalid JSON", 400);
	}

	const password = typeof body.password === "string" ? body.password : "";
	if (!password) {
		return createJsonErrorResponse("password is required", 400);
	}

	if (
		body.connectionId !== undefined &&
		typeof body.connectionId !== "string"
	) {
		return createJsonErrorResponse("connectionId must be a string", 400);
	}

	let connectionId = body.connectionId || "";
	if (!connectionId) {
		const connections = await resolveConnectionsForCapability(
			user.id,
			"photos",
		);
		const connection = connections.find((c) => c.provider === "immich");
		if (!connection) {
			return createJsonErrorResponse(
				"No Immich connection found. Connect your Immich account in Settings first.",
				404,
			);
		}
		connectionId = connection.id;
	}

	try {
		const result = await immichEnableWrites({
			userId: user.id,
			connectionId,
			password,
		});
		return json(result);
	} catch (err) {
		// Gate BOTH the message and the status on the provider-error check —
		// same posture as handleCredentialConnect (connect.ts). An unexpected,
		// non-ImmichError must fall back to 502 rather than letting
		// mapConnectError read a stray `.code` off it.
		const isImmichError = err instanceof ImmichError;
		return createJsonErrorResponse(
			isImmichError ? err.message : "Failed to enable Immich writes",
			isImmichError ? mapConnectError(err, { connection_not_found: 404 }) : 502,
		);
	}
};
