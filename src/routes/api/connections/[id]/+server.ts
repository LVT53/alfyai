import { json } from "@sveltejs/kit";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import { requireAuth } from "$lib/server/auth/hooks";
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
	requireAuth(event);
	const userId = event.locals.user.id;
	const id = event.params.id;

	const connection = await getConnection(userId, id);
	if (!connection) {
		return createJsonErrorResponse("Connection not found", 404);
	}

	let body: PatchBody;
	try {
		body = await event.request.json();
	} catch {
		return createJsonErrorResponse("Invalid JSON", 400);
	}

	if (body.allowWrites !== undefined && typeof body.allowWrites !== "boolean") {
		return createJsonErrorResponse("allowWrites must be a boolean", 400);
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
	requireAuth(event);
	const userId = event.locals.user.id;
	const id = event.params.id;

	const deleted = await deleteConnection(userId, id);
	if (!deleted) {
		return createJsonErrorResponse("Connection not found", 404);
	}
	return json({ ok: true });
};
