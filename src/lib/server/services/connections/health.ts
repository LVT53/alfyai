// Side-effect imports: every provider module registers its ConnectionAdapter
// when it is evaluated, and getConnectionAdapter below only sees adapters whose
// module has already loaded. SvelteKit loads route modules lazily, so
// POST /api/connections/[id]/recheck — which reaches the registry only through
// this file — can be the first code a fresh server process runs; without these
// imports it found an empty registry and persisted "No adapter registered"
// onto a working connection. Same pattern as pending-writes.ts for write
// executors; health.registration.test.ts pins that every connectable provider
// resolves from this module alone. Providers never import health.ts, so this
// adds no cycle.
import "./providers/apple-caldav";
import "./providers/caldav-tasks";
import "./providers/github";
import "./providers/google";
import "./providers/imap";
import "./providers/immich";
import "./providers/nextcloud-files";
import "./providers/onedrive";
import "./providers/owntracks";
import "./providers/plex";
import { getConnectionAdapter } from "./adapters";
import { getConnection, getConnectionSecret, updateConnection } from "./store";

export type ConnectionHealth = {
	status: "connected" | "needs_reauth" | "error";
	detail: string | null;
};

// Look up the connection (user-scoped) + its secret, find the adapter, call
// checkHealth, persist the resulting status/detail back to the store, return
// it. Never throws to the caller; a thrown adapter error becomes
// { status: "error", detail: <message, no secrets> }.
export async function checkConnectionHealth(
	userId: string,
	connectionId: string,
): Promise<ConnectionHealth | null> {
	const conn = await getConnection(userId, connectionId);
	if (!conn) return null;

	const secret = await getConnectionSecret(userId, connectionId);
	const adapter = getConnectionAdapter(conn.provider);

	let result: ConnectionHealth;
	if (!adapter) {
		result = {
			status: "error",
			detail: `No adapter registered for provider "${conn.provider}"`,
		};
	} else if (!secret && adapter.requiresSecret !== false) {
		result = {
			status: "needs_reauth",
			detail: "No secret is set for this connection",
		};
	} else {
		try {
			const health = await adapter.checkHealth(secret ?? "", conn);
			result = { status: health.status, detail: health.detail };
		} catch (err) {
			result = {
				status: "error",
				detail: err instanceof Error ? err.message : String(err),
			};
		}
	}

	await updateConnection(userId, connectionId, {
		status: result.status,
		statusDetail: result.detail,
	});

	return result;
}
