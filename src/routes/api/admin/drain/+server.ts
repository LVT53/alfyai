import { timingSafeEqual } from "node:crypto";
import { json } from "@sveltejs/kit";
import { getBearerToken, requireAdmin } from "$lib/server/auth/hooks";
import { config } from "$lib/server/env";
import {
	getStreamStats,
	isDraining,
	setDraining,
} from "$lib/server/services/chat-turn/active-streams";
import type { RequestHandler } from "./$types";

type DrainEvent = Parameters<RequestHandler>[0];

// Authorized by EITHER an admin session (the admin UI) or a bearer token
// equal to ALFYAI_API_SIGNING_KEY (the service path scripts/deploy.sh uses
// to drain the live process ahead of the cutover restart). See ADR-0054's
// D2 amendment.
function hasAdminSession(event: DrainEvent): boolean {
	try {
		requireAdmin(event);
		return true;
	} catch {
		return false;
	}
}

function hasServiceAuth(event: DrainEvent): boolean {
	const signingKey = config.alfyaiApiSigningKey.trim();
	if (!signingKey) return false;

	const token = getBearerToken(event.request.headers.get("authorization"));
	if (!token) return false;

	const expected = Buffer.from(signingKey);
	const provided = Buffer.from(token);
	if (expected.length !== provided.length) return false;
	return timingSafeEqual(expected, provided);
}

function isAuthorized(event: DrainEvent): boolean {
	return hasAdminSession(event) || hasServiceAuth(event);
}

function drainStateResponse() {
	return json({
		draining: isDraining(),
		activeStreams: getStreamStats().globalActiveCount,
	});
}

export const GET: RequestHandler = async (event) => {
	if (!isAuthorized(event)) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	return drainStateResponse();
};

export const POST: RequestHandler = async (event) => {
	if (!isAuthorized(event)) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const requestedDraining =
		body && typeof body === "object" && "draining" in body
			? (body as { draining?: unknown }).draining
			: undefined;
	if (typeof requestedDraining !== "boolean") {
		return json({ error: "draining must be a boolean" }, { status: 400 });
	}

	setDraining(requestedDraining);
	return drainStateResponse();
};
