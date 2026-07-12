import type { ConnectionPublic } from "$lib/server/services/connections/store";
import { getConnection } from "$lib/server/services/connections/store";
import { createJsonErrorResponse } from "./responses";

// Ownership seam for the `[id]/` connection routes.
//
// Every one of them re-implemented `const c = await getConnection(userId, id);
// if (!c) return 404;` — usually followed by a `c.provider !== "x" -> 400`
// guard. requireOwnedConnection owns that fetch + user-scoped 404 (getConnection
// is scoped by userId in the store, so another user's id resolves to null
// exactly like a missing one, never leaking existence) plus the optional
// provider guard.
//
// Returns a discriminated result rather than throwing so the caller keeps
// returning the SAME `{ error }` JSON shape (createJsonErrorResponse) with each
// route's own message/status preserved.

export type OwnedConnectionResult =
	| { ok: true; connection: ConnectionPublic }
	| { ok: false; response: Response };

export async function requireOwnedConnection(
	userId: string,
	id: string,
	opts?: {
		// Reject the connection unless this predicate holds (e.g. right provider
		// AND capability). Return false to trigger the mismatch response.
		guard?: (connection: ConnectionPublic) => boolean;
		notFoundMessage?: string;
		mismatchMessage?: string;
		// Status for a guard mismatch (default 400). thumbnail collapses a
		// wrong-provider connection into its 404 "not found" response, so it
		// passes 404 here.
		mismatchStatus?: number;
	},
): Promise<OwnedConnectionResult> {
	const connection = await getConnection(userId, id);
	if (!connection) {
		return {
			ok: false,
			response: createJsonErrorResponse(
				opts?.notFoundMessage ?? "Connection not found",
				404,
			),
		};
	}

	if (opts?.guard && !opts.guard(connection)) {
		return {
			ok: false,
			response: createJsonErrorResponse(
				opts.mismatchMessage ?? "Connection does not support this operation",
				opts.mismatchStatus ?? 400,
			),
		};
	}

	return { ok: true, connection };
}
