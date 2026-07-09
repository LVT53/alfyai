import { requestJson, requestVoid } from "./http";

// Client-side mirror of the server ConnectionPublic DTO
// (src/lib/server/services/connections/store.ts). Never add a secret field
// here — the server DTO deliberately excludes them.
export type ConnectionPublic = {
	id: string;
	provider: string;
	label: string;
	accountIdentifier: string | null;
	status: "connected" | "needs_reauth" | "error" | "disconnected";
	statusDetail: string | null;
	defaultOn: boolean;
	allowWrites: boolean;
	writeAllowlist: string[];
	capabilities: string[];
	config: Record<string, unknown>;
	oauthScopes: string[];
	tokenExpiresAt: number | null;
	hasSecret: boolean;
	hasWriteSecret: boolean;
	createdAt: number;
	updatedAt: number;
};

export async function fetchConnections(): Promise<ConnectionPublic[]> {
	const { connections } = await requestJson<{
		connections: ConnectionPublic[];
	}>("/api/connections", undefined, "Failed to load connections");
	return connections;
}

export async function updateConnection(
	id: string,
	patch: {
		allowWrites?: boolean;
		defaultOn?: boolean;
		capabilities?: string[];
		// Issue 7.1 — root paths a path-based write provider (e.g. nextcloud)
		// is allowed to write under. Server-side validated/normalized; see
		// src/routes/api/connections/[id]/+server.ts.
		writeAllowlist?: string[];
	},
): Promise<ConnectionPublic> {
	return requestJson<ConnectionPublic>(
		`/api/connections/${id}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		},
		"Failed to update connection",
	);
}

export async function disconnectConnection(id: string): Promise<void> {
	await requestVoid(
		`/api/connections/${id}`,
		{ method: "DELETE" },
		"Failed to disconnect",
	);
}
