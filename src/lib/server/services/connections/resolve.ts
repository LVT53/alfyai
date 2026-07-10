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

// ── Multi-connection selection (disambiguation) ─────────────────
//
// A user can have more than one connection serving the same capability (e.g.
// an Apple AND a Google calendar) — every capability tool used to blindly
// take `connections[0]` (alphabetically first, from the sort in
// resolveConnectionsForCapability above), silently routing every action to
// whichever connection sorted first. selectConnection/pickDefaultConnection
// below let a tool honor an explicit `account` selector from the model, and
// otherwise fall back to a deterministic default that — for writes —
// prefers a connection the user has actually enabled writes on, rather than
// whichever one happens to sort first.

// A connection is matched against a free-text selector on its `provider`
// (e.g. "google"), `label` (e.g. "Apple iCloud"), or `accountIdentifier`
// (e.g. "work@gmail.com"), case-insensitively. An exact match on provider or
// label wins outright; otherwise a substring/contains match on any of the
// three fields qualifies. Returns "exact" | "partial" | null so callers can
// implement an exact-first tie-break across a whole connection list (see
// selectConnection below) without duplicating the matching logic.
function matchConnectionSelector(
	conn: Pick<ConnectionPublic, "provider" | "label" | "accountIdentifier">,
	needle: string,
): "exact" | "partial" | null {
	const provider = conn.provider.toLowerCase();
	const label = conn.label.toLowerCase();
	const accountIdentifier = conn.accountIdentifier.toLowerCase();
	if (provider === needle || label === needle) return "exact";
	if (
		provider.includes(needle) ||
		label.includes(needle) ||
		accountIdentifier.includes(needle)
	) {
		return "partial";
	}
	return null;
}

// Resolves an optional model-supplied `account` selector (a provider name, a
// connection label, or an account identifier/email) to one of the caller's
// own connections, already scoped to the requesting user by whatever
// produced `connections` (resolveConnectionsForCapability). Returns null
// when no selector is given (the caller should fall back to
// pickDefaultConnection), or when the selector matches none of the
// connections (the caller should surface a graceful "which one did you
// mean" message rather than silently picking one).
export function selectConnection(
	connections: ConnectionPublic[],
	selector?: string | null,
): ConnectionPublic | null {
	const needle = selector?.trim().toLowerCase();
	if (!needle) return null;
	const exact = connections.find(
		(conn) => matchConnectionSelector(conn, needle) === "exact",
	);
	if (exact) return exact;
	const partial = connections.find(
		(conn) => matchConnectionSelector(conn, needle) === "partial",
	);
	return partial ?? null;
}

// The deterministic fallback a tool uses when no `account` selector was
// given (or selectConnection returned null and the caller decided to fall
// back rather than ask). For a write action, a connection with
// allowWrites=true is preferred over `connections[0]` — this alone fixes the
// surfaced bug (Apple + Google calendar, Apple sorts first but only Google
// has writes enabled: a create_event used to silently go to Apple). Reads,
// and writes when nothing is writable, keep the prior connections[0]
// (alphabetical-by-label) behavior for determinism and backward
// compatibility.
export function pickDefaultConnection(
	connections: ConnectionPublic[],
	opts?: { forWrite?: boolean },
): ConnectionPublic | null {
	if (connections.length === 0) return null;
	if (opts?.forWrite) {
		const writable = connections.find((conn) => conn.allowWrites === true);
		if (writable) return writable;
	}
	return connections[0] ?? null;
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
