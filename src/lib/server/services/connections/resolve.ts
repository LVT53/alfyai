import { CAPABILITIES, CAPABILITY_META, type Capability } from "./registry";
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

// The set of capabilities the user currently has at least one connection
// serving (same "serves it" predicate as resolveConnectionsForCapability:
// connected status + the capability enabled on that connection). Used to
// gate which capability-backed tools (e.g. "files") are exposed to the chat
// model for this user — callers should fail closed (empty set) on error
// rather than block the turn.
export async function getEnabledConnectionCapabilities(
	userId: string,
): Promise<Set<Capability>> {
	const connections = await listConnectionsForUser(userId);
	const enabled = new Set<Capability>();
	for (const capability of CAPABILITIES) {
		const providers = CAPABILITY_META[capability].providers;
		const isServed = connections.some(
			(conn) =>
				providers.includes(conn.provider) &&
				conn.status === "connected" &&
				conn.capabilities.includes(capability),
		);
		if (isServed) enabled.add(capability);
	}
	return enabled;
}
