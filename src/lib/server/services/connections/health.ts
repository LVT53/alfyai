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
