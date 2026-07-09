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

// The subset of served capabilities (see getEnabledConnectionCapabilities)
// that also have at least one connected connection with defaultOn=true.
// This is the set the composer initializes its per-conversation toggles to
// when the user hasn't made an explicit selection this turn (Issue 7.2 —
// makes the 7.1 defaultOn setting functional for the first time).
export async function getDefaultOnCapabilities(
	userId: string,
): Promise<Set<Capability>> {
	const connections = await listConnectionsForUser(userId);
	const enabled = new Set<Capability>();
	for (const capability of CAPABILITIES) {
		const providers = CAPABILITY_META[capability].providers;
		const isDefaultOn = connections.some(
			(conn) =>
				providers.includes(conn.provider) &&
				conn.status === "connected" &&
				conn.capabilities.includes(capability) &&
				conn.defaultOn,
		);
		if (isDefaultOn) enabled.add(capability);
	}
	return enabled;
}

// The capability set that should actually be exposed to the model this turn.
// SECURITY: fail-closed — a client-supplied `requested` list can only NARROW
// the served set, never widen it. A capability the user does not have a
// connected connection serving is never enabled here, regardless of what the
// client sends.
//   - requested != null (client sent an explicit selection, including []):
//     return served ∩ requested.
//   - requested == null (older client, or no selection made yet): return
//     getDefaultOnCapabilities(userId), NOT the full served set.
export async function resolveActiveCapabilities(
	userId: string,
	requested?: string[] | null,
): Promise<Set<Capability>> {
	const served = await getEnabledConnectionCapabilities(userId);
	if (requested == null) {
		return getDefaultOnCapabilities(userId);
	}
	const requestedSet = new Set(requested);
	const active = new Set<Capability>();
	for (const capability of served) {
		if (requestedSet.has(capability)) active.add(capability);
	}
	return active;
}
