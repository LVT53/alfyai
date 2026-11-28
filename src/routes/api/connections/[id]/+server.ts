import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { requireOwnedConnection } from "$lib/server/api/ownership";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import { drivePilotEnabled, gmailPilotEnabled } from "$lib/server/env";
import { grantedCapabilitiesFor } from "$lib/server/services/connections/granted";
import { gmailCanModify } from "$lib/server/services/connections/providers/gmail";
import { googleDriveCanModify } from "$lib/server/services/connections/providers/google-drive-auth";
import { googleServiceCanModify } from "$lib/server/services/connections/providers/google-service-token";
import {
	type Capability,
	PROVIDER_META,
} from "$lib/server/services/connections/registry";
import {
	deleteConnection,
	getConnection,
	setAllowWrites,
	setDefaultOn,
	setEnabledCapabilities,
	setWriteAllowlist,
} from "$lib/server/services/connections/store";
import { normalizeAllowlistPath } from "$lib/server/services/connections/write-guard";
import { gmailReadGranted } from "$lib/shared/gmail-scopes";
import { GOOGLE_CALENDAR_EVENT_WRITE_SCOPE } from "$lib/shared/google-calendar";
import { driveReadGranted } from "$lib/shared/google-drive-scopes";
import { tasksReadGranted } from "$lib/shared/google-tasks-scopes";
import {
	MICROSOFT_WRITE_SCOPES,
	type MicrosoftWritePermission,
	microsoftCanWrite,
} from "$lib/shared/microsoft-permissions";
import type { RequestHandler } from "./$types";

interface PatchBody {
	allowWrites?: unknown;
	defaultOn?: unknown;
	capabilities?: unknown;
	writeAllowlist?: unknown;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// Issue 7.1 — the write-allowlist a caller can submit is capped so a
// misbehaving client can't grow the JSON column unboundedly.
const MAX_WRITE_ALLOWLIST_ENTRIES = 20;

// PATCH /api/connections/[id] — updates allowWrites/defaultOn/capabilities
// for one of the caller's connections. Every field is optional; only the
// fields present in the body are applied. Always scoped via
// getConnection(userId, id) first so another user's connection id 404s
// instead of leaking existence or allowing a cross-user mutation.
export const PATCH: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const userId = user.id;
	const id = event.params.id;

	const owned = await requireOwnedConnection(userId, id);
	if (!owned.ok) {
		return owned.response;
	}
	const connection = owned.connection;

	let body: PatchBody;
	try {
		body = await event.request.json();
	} catch {
		return createJsonErrorResponse("Invalid JSON", 400);
	}

	if (body.allowWrites !== undefined && typeof body.allowWrites !== "boolean") {
		return createJsonErrorResponse("allowWrites must be a boolean", 400);
	}
	if (body.allowWrites === true && connection.provider === "bosch")
		return createJsonErrorResponse("Bosch cycling is read-only", 403);
	const enabledCapabilities = isStringArray(body.capabilities)
		? body.capabilities
		: connection.capabilities;
	if (
		body.allowWrites === true &&
		connection.provider === "google" &&
		enabledCapabilities.some(
			(cap) =>
				cap === "email" ||
				cap === "calendar" ||
				cap === "files" ||
				cap === "tasks",
		)
	) {
		const calendarWrite =
			enabledCapabilities.includes("calendar") &&
			connection.oauthScopes.includes(GOOGLE_CALENDAR_EVENT_WRITE_SCOPE);
		const gmailWrite = gmailCanModify({
			...connection,
			capabilities: enabledCapabilities,
			allowWrites: true,
		});
		const driveWrite = googleDriveCanModify({
			...connection,
			capabilities: enabledCapabilities,
			allowWrites: true,
		});
		const tasksWrite = googleServiceCanModify(
			{ ...connection, capabilities: enabledCapabilities, allowWrites: true },
			"tasks",
		);
		if (!calendarWrite && !gmailWrite && !driveWrite && !tasksWrite)
			return createJsonErrorResponse(
				enabledCapabilities.includes("calendar")
					? "Google Calendar event editing requires Google’s consent"
					: enabledCapabilities.includes("files")
						? "Drive changes require Google consent"
						: enabledCapabilities.includes("tasks")
							? "Google Tasks editing requires consent"
							: "Gmail editing requires consent",
				403,
			);
	}

	if (
		body.allowWrites === true &&
		connection.provider === "onedrive" &&
		!(Object.keys(MICROSOFT_WRITE_SCOPES) as MicrosoftWritePermission[]).some(
			(p) =>
				microsoftCanWrite(
					{
						...connection,
						allowWrites: true,
						capabilities: Array.isArray(body.capabilities)
							? body.capabilities
							: connection.capabilities,
					},
					p,
				),
		)
	) {
		return createJsonErrorResponse(
			"Reconnect to grant the requested Microsoft permission",
			403,
		);
	}
	if (body.defaultOn !== undefined && typeof body.defaultOn !== "boolean") {
		return createJsonErrorResponse("defaultOn must be a boolean", 400);
	}
	if (body.capabilities !== undefined) {
		if (!isStringArray(body.capabilities)) {
			return createJsonErrorResponse(
				"capabilities must be an array of strings",
				400,
			);
		}
		const allowed = new Set<string>(
			PROVIDER_META[connection.provider].capabilities,
		);
		const unknown = body.capabilities.filter((cap) => !allowed.has(cap));
		if (unknown.length > 0) {
			return createJsonErrorResponse(
				`Unknown capabilities for ${connection.provider}: ${unknown.join(", ")}`,
				400,
			);
		}
		if (
			connection.provider === "apple" &&
			body.capabilities.some(
				(cap) =>
					!(grantedCapabilitiesFor(connection) as string[]).includes(cap),
			)
		) {
			return createJsonErrorResponse(
				"Reconnect to enable the requested iCloud service",
				400,
			);
		}
		if (
			connection.provider === "google" &&
			body.capabilities.includes("email") &&
			(!gmailPilotEnabled(userId) || !gmailReadGranted(connection.oauthScopes))
		)
			return createJsonErrorResponse("Reconnect to grant Gmail access", 403);
		if (
			connection.provider === "google" &&
			body.capabilities.includes("files") &&
			(!drivePilotEnabled(userId) || !driveReadGranted(connection.oauthScopes))
		)
			return createJsonErrorResponse("Reconnect to grant Drive access", 403);
		if (
			connection.provider === "google" &&
			body.capabilities.includes("tasks") &&
			!tasksReadGranted(connection.oauthScopes)
		)
			return createJsonErrorResponse(
				"Reconnect to grant Google Tasks access",
				403,
			);
		if (connection.provider === "onedrive") {
			const granted = new Set<string>(grantedCapabilitiesFor(connection));
			if (body.capabilities.some((cap) => !granted.has(cap))) {
				return createJsonErrorResponse(
					"Reconnect to grant the requested Microsoft permission",
					400,
				);
			}
		}
	}

	// Issue 7.1 — writeAllowlist: root paths the user allows path-based write
	// providers (currently nextcloud) to write under without a per-write
	// warning. Every entry is run through the SAME traversal-rejecting
	// normalization the write-guard uses when resolving an actual write
	// target (normalizeAllowlistPath), so a `..`-bearing entry can never be
	// persisted here either.
	let normalizedWriteAllowlist: string[] | undefined;
	if (body.writeAllowlist !== undefined) {
		if (!isStringArray(body.writeAllowlist)) {
			return createJsonErrorResponse(
				"writeAllowlist must be an array of strings",
				400,
			);
		}
		if (body.writeAllowlist.length > MAX_WRITE_ALLOWLIST_ENTRIES) {
			return createJsonErrorResponse(
				`writeAllowlist supports at most ${MAX_WRITE_ALLOWLIST_ENTRIES} entries`,
				400,
			);
		}
		if (body.writeAllowlist.some((entry) => entry.trim() === "")) {
			return createJsonErrorResponse(
				"writeAllowlist entries must be non-empty",
				400,
			);
		}
		try {
			normalizedWriteAllowlist = body.writeAllowlist.map(
				normalizeAllowlistPath,
			);
		} catch {
			return createJsonErrorResponse(
				"writeAllowlist entries must not escape the allowed root",
				400,
			);
		}
	}

	if (body.allowWrites !== undefined) {
		await setAllowWrites(userId, id, body.allowWrites as boolean);
	}
	if (body.defaultOn !== undefined) {
		await setDefaultOn(userId, id, body.defaultOn as boolean);
	}
	if (body.capabilities !== undefined) {
		await setEnabledCapabilities(userId, id, body.capabilities as Capability[]);
	}
	if (normalizedWriteAllowlist !== undefined) {
		await setWriteAllowlist(userId, id, normalizedWriteAllowlist);
	}

	const updated = await getConnection(userId, id);
	if (!updated) {
		return createJsonErrorResponse("Connection not found", 404);
	}
	return json(updated);
};

// DELETE /api/connections/[id] — disconnects (removes) one of the caller's
// connections. 404 for a missing or another user's id.
export const DELETE: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const userId = user.id;
	const id = event.params.id;

	const deleted = await deleteConnection(userId, id);
	if (!deleted) {
		return createJsonErrorResponse("Connection not found", 404);
	}
	return json({ ok: true });
};
