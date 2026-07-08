import { CAPABILITY_META, type Capability } from "./registry";
import type { ConnectionPublic } from "./store";
import { listConnectionsForUser } from "./store";

// A connection serves a capability iff: its provider is listed under that
// capability in CAPABILITY_META, AND its status === "connected", AND the
// capability is enabled on the connection (present in conn.capabilities).
export async function resolveConnectionsForCapability(
	userId: string,
	capability: Capability,
): Promise<ConnectionPublic[]> {
	const providers = CAPABILITY_META[capability].providers;
	const connections = await listConnectionsForUser(userId);
	return connections
		.filter(
			(conn) =>
				providers.includes(conn.provider) &&
				conn.status === "connected" &&
				conn.capabilities.includes(capability),
		)
		.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

// True when the caller must disambiguate (more than one connection serves it).
export function needsDisambiguation(connections: ConnectionPublic[]): boolean {
	return connections.length > 1;
}
